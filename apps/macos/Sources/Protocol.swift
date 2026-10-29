//
//  Protocol.swift
//  livedub macOS 菜单栏 App
//
//  livedub 线协议 v1 的 Swift 侧镜像（纯函数，不依赖 UI / 屏幕录制权限）。
//  权威实现：engine/protocol.mjs；契约：docs/CONTRACTS.md §3。
//
//  为什么单独一个文件：`--self-test` 需要在没有窗口服务器、没有屏幕录制权限的环境里
//  做字节级校验（音频帧布局 / hello JSON / 事件解析 / 字幕排版），这些逻辑必须可独立测试。
//

import Foundation

// MARK: - 协议常量（必须与 engine/protocol.mjs 保持一致）

enum LiveDubProtocol {
    /// 协议版本（engine/protocol.mjs#PROTOCOL_VERSION）
    static let version = 1
    /// 二进制音频帧首字节魔数（engine/protocol.mjs#AUDIO_FRAME_TAG）
    static let audioFrameTag: UInt8 = 0x01
    /// ASR 输入采样率，s16le mono（engine/protocol.mjs#AUDIO_INPUT_SAMPLE_RATE）
    static let audioInputSampleRate = 16_000
    /// 推荐音频分片时长：每 100ms 一帧（engine/protocol.mjs#AUDIO_FRAME_MS）
    static let audioFrameMs = 100
    /// 单帧上限（engine/protocol.mjs#MAX_AUDIO_FRAME_BYTES）
    static let maxAudioFrameBytes = 256 * 1024
    /// 配音 PCM 采样率（引擎 dub 事件 sampleRate 默认值，config.tts.sampleRate）
    static let dubSampleRate = 24_000
    /// 引擎默认 WebSocket 地址（docs/CONTRACTS.md §3）
    static let defaultEngineURL = "ws://127.0.0.1:8787/ws"
    /// 引擎默认端口
    static let enginePort = 8787
    /// 引擎 WebSocket 路径
    static let wsPath = "/ws"

    /// 每帧采样数（16k * 100ms / 1000 = 1600）
    static var frameSamples: Int { audioInputSampleRate * audioFrameMs / 1000 }
    /// 每帧 PCM 字节数（1600 * 2 = 3200）
    static var frameBytes: Int { frameSamples * MemoryLayout<Int16>.size }
}

// MARK: - s16le 编解码

enum S16leCodec {
    /// [Int16] -> little-endian 原始字节（macOS 为小端，但显式写端序，避免 future portability 问题）
    static func encodeData(_ samples: [Int16]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for sample in samples {
            let value = UInt16(bitPattern: sample)
            data.append(UInt8(value & 0xFF))
            data.append(UInt8((value >> 8) & 0xFF))
        }
        return data
    }

    /// little-endian 原始字节 -> [Int16]
    static func decode(data: Data) -> [Int16] {
        guard data.count >= 2 else { return [] }
        let bytes = [UInt8](data)
        var out = [Int16](repeating: 0, count: bytes.count / 2)
        for i in 0..<out.count {
            let lo = UInt16(bytes[i * 2])
            let hi = UInt16(bytes[i * 2 + 1])
            out[i] = Int16(bitPattern: lo | (hi << 8))
        }
        return out
    }

    /// base64（引擎 Node Buffer#toString('base64')）-> [Int16]
    static func decode(base64: String) -> [Int16] {
        guard !base64.isEmpty, let data = Data(base64Encoded: base64, options: [.ignoreUnknownCharacters]) else {
            return []
        }
        return decode(data: data)
    }
}

// MARK: - 二进制音频帧：[0]=0x01 | [1..8]=float64BE tMs | [9..]=s16le 16k mono

enum AudioFrameCodecError: Error, CustomStringConvertible {
    case emptyPcm
    case invalidTimestamp
    case frameTooLarge

    var description: String {
        switch self {
        case .emptyPcm: return "PCM 为空：音频帧至少需要 2 字节 s16le 数据"
        case .invalidTimestamp: return "tMs 非法：必须是有限非负数字（会话时间轴毫秒）"
        case .frameTooLarge: return "音频帧超过 \(LiveDubProtocol.maxAudioFrameBytes) 字节上限：请缩短分片"
        }
    }
}

struct DecodedAudioFrame {
    let tMs: Double
    let pcm: [Int16]
}

enum AudioFrameCodec {
    /// 与 engine/protocol.mjs#encodeAudioFrame 字节级一致：
    /// [0]=0x01, [1..8]=float64 big-endian tMs, [9..]=s16le 16k mono
    static func encode(tMs: Double, pcm: [Int16]) throws -> Data {
        guard !pcm.isEmpty else { throw AudioFrameCodecError.emptyPcm }
        guard tMs.isFinite, tMs >= 0 else { throw AudioFrameCodecError.invalidTimestamp }
        let payloadBytes = pcm.count * 2
        guard payloadBytes + 9 <= LiveDubProtocol.maxAudioFrameBytes else {
            throw AudioFrameCodecError.frameTooLarge
        }
        var data = Data(capacity: 9 + payloadBytes)
        data.append(LiveDubProtocol.audioFrameTag)
        // float64 big-endian：bitPattern 高位在前
        let bits = tMs.bitPattern
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8((bits >> UInt64(shift)) & 0xFF))
        }
        data.append(S16leCodec.encodeData(pcm))
        return data
    }

    /// 与 engine/protocol.mjs#decodeAudioFrame 等价的严格解析（self-test / 回放用）
    static func decode(_ data: Data) throws -> DecodedAudioFrame {
        guard data.count >= 11 else { throw AudioFrameCodecError.emptyPcm }
        guard data[0] == LiveDubProtocol.audioFrameTag else { throw AudioFrameCodecError.emptyPcm }
        let payloadBytes = data.count - 9
        guard payloadBytes % 2 == 0 else { throw AudioFrameCodecError.emptyPcm }
        var bits: UInt64 = 0
        for i in 0..<8 {
            bits = (bits << 8) | UInt64(data[1 + i])
        }
        let tMs = Double(bitPattern: bits)
        guard tMs.isFinite, tMs >= 0 else { throw AudioFrameCodecError.invalidTimestamp }
        let payload = data.subdata(in: 9..<data.count)
        return DecodedAudioFrame(tMs: tMs, pcm: S16leCodec.decode(data: payload))
    }
}

// MARK: - hello JSON

struct HelloOptions {
    /// 客户端类型。契约枚举：extension | studio | batch | test。
    /// macOS App 复用 "studio"（引擎 normalizeHello 只接受这四个值，未知值会回退 studio）。
    var source: String = "studio"
    var title: String = ""
    var url: String = ""
    var langFrom: String = "en"
    var langTo: String = "zh"
    var overrides: [String: Any] = [:]

    static let allowedSources = ["extension", "studio", "batch", "test"]
}

enum HelloJSON {
    /// 构造 docs/CONTRACTS.md §3.1 的 hello 消息对象。
    static func object(options: HelloOptions) -> [String: Any] {
        let source = HelloOptions.allowedSources.contains(options.source) ? options.source : "studio"
        let session: [String: Any] = [
            "source": source,
            "title": String(options.title.prefix(500)),
            "url": String(options.url.prefix(500)),
            "langFrom": options.langFrom.isEmpty ? "en" : String(options.langFrom.prefix(20)),
            "langTo": options.langTo.isEmpty ? "zh" : String(options.langTo.prefix(20)),
            "tMsBase": NSNull(),
            "overrides": options.overrides,
        ]
        return [
            "type": "hello",
            "protocol": LiveDubProtocol.version,
            "session": session,
        ]
    }

    static func data(options: HelloOptions) throws -> Data {
        try JSONSerialization.data(withJSONObject: object(options: options), options: [.sortedKeys])
    }

    static func text(options: HelloOptions) throws -> String {
        let data = try data(options: options)
        guard let text = String(data: data, encoding: .utf8) else {
            throw AudioFrameCodecError.emptyPcm
        }
        return text
    }
}

// MARK: - 引擎事件

struct DubChunk {
    let id: String
    let seq: Int
    /// 会话时间轴毫秒：客户端按 startMs 尽量对齐播放，来不及就立即播
    let startMs: Double
    /// 采样率（引擎默认 24000）
    let sampleRate: Int
    /// 已解码的 s16le mono 采样
    let samples: [Int16]
    let durationMs: Double
    let final: Bool
    let voiceId: String
}

enum EngineEvent {
    case ready(sessionId: String, protocolVersion: Int, providers: [String: String], voiceMode: String, voiceId: String)
    case status(state: String, detail: String?, tsMs: Double?)
    case partial(id: String, text: String)
    case segment(id: String, text: String, lang: String?)
    case translation(id: String, text: String, final: Bool)
    case dub(DubChunk)
    case metrics(id: String, e2eLagMs: Double?, e2eFromStartMs: Double?, asrFinalMs: Double?, mtFirstMs: Double?, ttsFirstMs: Double?)
    case voice(mode: String, voiceId: String, degraded: Bool, reason: String?)
    case error(scope: String, message: String, recoverable: Bool)
    case pong
    case bye(reason: String)
    case unknown(type: String)
}

enum EngineEventParser {
    /// 解析文本帧 JSON；返回 nil 表示不是合法 JSON 对象。
    static func parse(text: String) -> EngineEvent? {
        guard let data = text.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data),
              let object = raw as? [String: Any] else {
            return nil
        }
        return parse(object)
    }

    static func parse(_ object: [String: Any]) -> EngineEvent {
        let type = string(object["type"]) ?? ""
        switch type {
        case "ready":
            let voice = stringMap(object["voice"])
            return .ready(
                sessionId: string(object["sessionId"]) ?? "",
                protocolVersion: Int(number(object["protocol"]) ?? 0),
                providers: stringMap(object["providers"]),
                voiceMode: voice["mode"] ?? "",
                voiceId: voice["voiceId"] ?? ""
            )
        case "status":
            return .status(
                state: string(object["state"]) ?? "idle",
                detail: string(object["detail"]),
                tsMs: number(object["tsMs"])
            )
        case "partial":
            return .partial(id: string(object["id"]) ?? "", text: string(object["text"]) ?? "")
        case "segment":
            return .segment(
                id: string(object["id"]) ?? "",
                text: string(object["text"]) ?? "",
                lang: string(object["lang"])
            )
        case "translation":
            return .translation(
                id: string(object["id"]) ?? "",
                text: string(object["text"]) ?? "",
                final: bool(object["final"]) ?? false
            )
        case "dub":
            let sampleRate = Int(number(object["sampleRate"]) ?? Double(LiveDubProtocol.dubSampleRate))
            let chunk = DubChunk(
                id: string(object["id"]) ?? "",
                seq: Int(number(object["seq"]) ?? 0),
                startMs: number(object["startMs"]) ?? 0,
                sampleRate: sampleRate > 0 ? sampleRate : LiveDubProtocol.dubSampleRate,
                samples: S16leCodec.decode(base64: string(object["pcm"]) ?? ""),
                durationMs: number(object["durationMs"]) ?? 0,
                final: bool(object["final"]) ?? false,
                voiceId: string(object["voiceId"]) ?? ""
            )
            return .dub(chunk)
        case "metrics":
            return .metrics(
                id: string(object["id"]) ?? "",
                e2eLagMs: number(object["e2eLagMs"]),
                e2eFromStartMs: number(object["e2eFromStartMs"]),
                asrFinalMs: number(object["asrFinalMs"]),
                mtFirstMs: number(object["mtFirstMs"]),
                ttsFirstMs: number(object["ttsFirstMs"])
            )
        case "voice":
            let voice = stringMap(object["voice"])
            return .voice(
                mode: string(object["mode"]) ?? voice["mode"] ?? "preset",
                voiceId: string(object["voiceId"]) ?? voice["voiceId"] ?? "",
                degraded: bool(object["degraded"]) ?? false,
                reason: string(object["reason"])
            )
        case "error":
            return .error(
                scope: string(object["scope"]) ?? "server",
                message: string(object["message"]) ?? "",
                recoverable: bool(object["recoverable"]) ?? true
            )
        case "pong":
            return .pong
        case "bye":
            return .bye(reason: string(object["reason"]) ?? "")
        default:
            return .unknown(type: type)
        }
    }

    // MARK: 取值帮手（引擎字段可能是 Int / Double / String）

    private static func string(_ value: Any?) -> String? {
        if let text = value as? String { return text }
        return nil
    }

    private static func number(_ value: Any?) -> Double? {
        switch value {
        case let double as Double: return double.isFinite ? double : nil
        case let int as Int: return Double(int)
        case let number as NSNumber: return number.doubleValue
        case let text as String: return Double(text)
        default: return nil
        }
    }

    private static func bool(_ value: Any?) -> Bool? {
        switch value {
        case let flag as Bool: return flag
        case let number as NSNumber: return number.boolValue
        case let text as String: return text == "true"
        default: return nil
        }
    }

    private static func stringMap(_ value: Any?) -> [String: String] {
        guard let dict = value as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (key, raw) in dict {
            if let text = raw as? String { out[key] = text }
        }
        return out
    }
}

// MARK: - 字幕排版 / 状态文案（纯函数，self-test 覆盖）

enum CaptionLayout {
    /// 终端显示宽度：CJK / 全角 / emoji 记 2 列，其余 1 列。
    static func displayWidth(_ character: Character) -> Int {
        var width = 0
        for scalar in character.unicodeScalars {
            width = max(width, scalarWidth(scalar))
        }
        return max(1, width)
    }

    static func scalarWidth(_ scalar: UnicodeScalar) -> Int {
        switch scalar.value {
        case 0x1100...0x115F, 0x2E80...0xA4CF, 0xAC00...0xD7A3,
             0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFF60,
             0xFFE0...0xFFE6, 0x1F300...0x1FAFF:
            return 2
        default:
            return 1
        }
    }

    static func textWidth(_ text: String) -> Int {
        text.reduce(0) { $0 + displayWidth($1) }
    }

    /// 按显示宽度折行：优先在空格 / CJK 字符间断行；超长英文 token 硬切。
    /// - Parameters:
    ///   - maxColumns: 每行显示列数（CJK 算 2）
    ///   - maxLines: >0 时最多保留 N 行，末行加省略号；0 = 不限
    static func wrap(_ text: String, maxColumns: Int, maxLines: Int = 0) -> [String] {
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        guard !normalized.isEmpty else { return [] }
        let limit = max(4, maxColumns)

        var lines: [String] = []
        for paragraph in normalized.components(separatedBy: "\n") {
            var current = ""
            var currentWidth = 0
            func flush() {
                let trimmed = current.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { lines.append(trimmed) }
                current = ""
                currentWidth = 0
            }

            for unit in layoutUnits(paragraph) {
                if unit.isSpace {
                    if currentWidth == 0 { continue }
                    if currentWidth + 1 <= limit {
                        current.append(" ")
                        currentWidth += 1
                    }
                    continue
                }
                if currentWidth + unit.width <= limit {
                    current.append(contentsOf: unit.text)
                    currentWidth += unit.width
                    continue
                }
                if currentWidth > 0 { flush() }
                if unit.width <= limit {
                    current = unit.text
                    currentWidth = unit.width
                } else {
                    for character in unit.text {
                        let width = displayWidth(character)
                        if currentWidth + width > limit && currentWidth > 0 { flush() }
                        current.append(character)
                        currentWidth += width
                    }
                }
            }
            flush()
        }

        guard maxLines > 0, lines.count > maxLines else { return lines }
        var kept = Array(lines.prefix(maxLines))
        if let last = kept.last {
            var trimmed = last
            if trimmed.count > 1 { trimmed.removeLast() }
            kept[kept.count - 1] = trimmed + "…"
        }
        return kept
    }

    /// 延迟小字：nil -> "—"，否则一位小数秒。例：1834 -> "1.8s"
    static func formatLatency(_ ms: Double?) -> String {
        guard let ms, ms.isFinite, ms >= 0 else { return "—" }
        return String(format: "%.1fs", ms / 1000.0)
    }

    /// 引擎 status.state -> 中文短状态（菜单栏 / 浮层共用）。
    static func statusLabel(_ state: String) -> String {
        switch state {
        case "idle": return "待机"
        case "ready": return "已就绪"
        case "listening": return "聆听中"
        case "translating": return "翻译中"
        case "speaking": return "播放配音"
        case "paused": return "已暂停"
        case "error": return "出错"
        case "connecting": return "连接引擎…"
        case "reconnecting": return "重连引擎…"
        case "simulating": return "模拟演示"
        case "stopped": return "已停止"
        default: return state.isEmpty ? "未知" : state
        }
    }

    private struct LayoutUnit {
        let text: String
        let width: Int
        let isSpace: Bool
    }

    private static func layoutUnits(_ paragraph: String) -> [LayoutUnit] {
        var units: [LayoutUnit] = []
        var word = ""
        var wordWidth = 0
        func flushWord() {
            if !word.isEmpty {
                units.append(LayoutUnit(text: word, width: wordWidth, isSpace: false))
                word = ""
                wordWidth = 0
            }
        }
        for character in paragraph {
            if character == " " || character == "\t" {
                flushWord()
                units.append(LayoutUnit(text: " ", width: 1, isSpace: true))
            } else if displayWidth(character) >= 2 {
                flushWord()
                units.append(LayoutUnit(text: String(character), width: displayWidth(character), isSpace: false))
            } else {
                word.append(character)
                wordWidth += displayWidth(character)
            }
        }
        flushWord()
        return units
    }
}

// MARK: - PCM 分帧（100ms / 1600 samples）

final class FrameChunker {
    let sampleRate: Int
    let frameMs: Int
    private(set) var frameIndex = 0
    private var pending: [Int16] = []

    var frameSamples: Int { max(1, sampleRate * frameMs / 1000) }

    init(sampleRate: Int = LiveDubProtocol.audioInputSampleRate,
         frameMs: Int = LiveDubProtocol.audioFrameMs) {
        self.sampleRate = sampleRate
        self.frameMs = frameMs
    }

    /// 追加 16k mono s16le 采样，返回本次凑满的 100ms 帧（tMs = 帧序号 * 100）。
    func push(_ samples: [Int16]) -> [(tMs: Double, pcm: [Int16])] {
        guard !samples.isEmpty else { return [] }
        pending.append(contentsOf: samples)
        let size = frameSamples
        var frames: [(tMs: Double, pcm: [Int16])] = []
        while pending.count >= size {
            let frame = Array(pending[0..<size])
            pending.removeFirst(size)
            frames.append((tMs: Double(frameIndex * frameMs), frame))
            frameIndex += 1
        }
        return frames
    }

    func reset() {
        pending.removeAll(keepingCapacity: true)
        frameIndex = 0
    }
}

// MARK: - 重采样：任意输入率 -> 16k mono s16le（系统音频 48kHz 常见）

/// 流式线性插值 + 盒式抗混叠预滤波。对语音足够，不做高质量重采样（无第三方依赖）。
final class StreamingResampler {
    let inputRate: Double
    let outputRate: Double
    private let ratio: Double
    private let window: Int
    private var buffer: [Float] = []
    /// buffer[0] 对应的全局输入采样下标
    private var bufferStart: Int = 0
    /// 下一个输出采样对应的全局输入位置（浮点）
    private var nextInputPosition: Double = 0

    init(inputRate: Double, outputRate: Double = Double(LiveDubProtocol.audioInputSampleRate)) {
        precondition(inputRate > 0 && outputRate > 0, "采样率必须为正数")
        self.inputRate = inputRate
        self.outputRate = outputRate
        self.ratio = inputRate / outputRate
        self.window = max(1, Int(ratio.rounded()))
    }

    /// 输入一段单声道 Float32（-1...1），返回本次可产出的 16k s16le 采样。
    func process(_ samples: [Float]) -> [Int16] {
        guard !samples.isEmpty else { return [] }
        buffer.append(contentsOf: samples)
        let lastGlobal = bufferStart + buffer.count - 1
        var out: [Int16] = []
        while true {
            let base = Int(nextInputPosition.rounded(.down))
            if base + window - 1 > lastGlobal { break }
            var sum: Float = 0
            for offset in 0..<window {
                sum += buffer[base - bufferStart + offset]
            }
            out.append(Self.floatToInt16(sum / Float(window)))
            nextInputPosition += ratio
        }
        compact()
        return out
    }

    func reset() {
        buffer.removeAll(keepingCapacity: true)
        bufferStart = 0
        nextInputPosition = 0
    }

    private func compact() {
        let consumed = Int(nextInputPosition.rounded(.down)) - window
        guard consumed > 4096 else { return }
        let drop = min(consumed, buffer.count)
        buffer.removeFirst(drop)
        bufferStart += drop
    }

    static func floatToInt16(_ value: Float) -> Int16 {
        let clamped = max(-1.0, min(1.0, value))
        return Int16((clamped * 32_767.0).rounded())
    }
}

// MARK: - PCM 小工具

enum PcmMath {
    static func rms(_ samples: [Int16]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var sum = 0.0
        for sample in samples {
            let value = Double(sample) / 32_768.0
            sum += value * value
        }
        return (sum / Double(samples.count)).squareRoot()
    }

    static func peak(_ samples: [Int16]) -> Double {
        var peak = 0
        for sample in samples { peak = max(peak, abs(Int(sample))) }
        return Double(peak) / 32_768.0
    }
}
