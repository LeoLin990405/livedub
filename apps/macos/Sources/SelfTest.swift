//
//  SelfTest.swift
//  livedub macOS 菜单栏 App
//
//  `livedub --self-test`：headless 自检（不建窗口、不请求权限、不联网）。
//  校验内容：
//   - 协议常量与 engine/protocol.mjs 对齐（0x01 / 16000 / 100ms / 256KB 上限 / ws://127.0.0.1:8787/ws）
//   - 音频帧字节布局：[0]=0x01 | [1..8]=float64BE tMs | [9..]=s16le（含 tMs=1234 的固定字节向量）
//   - hello JSON 字段 / 事件解析（ready/status/partial/segment/translation/dub/metrics/voice/error/pong/bye）
//   - 字幕折行（ASCII / CJK 宽字符 / 超长 token / 最多两行）、延迟时间格式、状态文案
//   - 16k 100ms 分帧、48k/44.1k -> 16k 重采样、引擎地址清洗
//  退出码：0 全部通过；1 有失败（便于 CI 与 scripts/build-macos.sh --check）。
//

import Foundation

// MARK: - --simulate 演示数据

enum SimulatedSession {
    struct Turn {
        let en: String
        let zh: String
    }

    static let turns: [Turn] = [
        Turn(
            en: "Today we're going to talk about how gradient descent actually works.",
            zh: "今天我们来聊聊梯度下降到底是怎么工作的。"
        ),
        Turn(
            en: "The key idea is surprisingly simple: follow the slope downhill.",
            zh: "核心思想其实非常简单：顺着坡往下走。"
        ),
        Turn(
            en: "If the learning rate is too large, the loss may diverge instead of converge.",
            zh: "如果学习率太大，损失可能会发散，而不是收敛。"
        ),
        Turn(
            en: "In practice we usually combine momentum with a slowly decaying schedule.",
            zh: "实践中，我们通常把动量和缓慢衰减的学习率调度结合起来。"
        ),
        Turn(
            en: "Let's look at a concrete example on the whiteboard.",
            zh: "我们来看白板上的一个具体例子。"
        ),
    ]
}

// MARK: - 自检

enum SelfTest {
    private static var total = 0
    private static var failures: [String] = []

    /// 运行全部检查，返回失败项（空 = 通过）。检查过程会逐行打印 ok / FAIL。
    static func run() -> [String] {
        total = 0
        failures = []

        checkProtocol()
        checkFrames()
        checkHello()
        checkEvents()
        checkCaptions()
        checkResampler()
        checkChunker()
        checkSettings()
        checkSimulationData()

        if failures.isEmpty {
            print("self-test: \(total) checks passed")
        } else {
            print("self-test: \(failures.count)/\(total) checks FAILED")
        }
        return failures
    }

    // MARK: 协议常量

    private static func checkProtocol() {
        check("protocol.version == 1", LiveDubProtocol.version == 1)
        check("audioFrameTag == 0x01", LiveDubProtocol.audioFrameTag == 0x01)
        check("audioInputSampleRate == 16000", LiveDubProtocol.audioInputSampleRate == 16_000)
        check("audioFrameMs == 100", LiveDubProtocol.audioFrameMs == 100)
        check("frameSamples == 1600", LiveDubProtocol.frameSamples == 1_600,
              detail: "got \(LiveDubProtocol.frameSamples)")
        check("frameBytes == 3200", LiveDubProtocol.frameBytes == 3_200,
              detail: "got \(LiveDubProtocol.frameBytes)")
        check("maxAudioFrameBytes == 256KB", LiveDubProtocol.maxAudioFrameBytes == 262_144)
        check("dubSampleRate == 24000", LiveDubProtocol.dubSampleRate == 24_000)
        check("defaultEngineURL == ws://127.0.0.1:8787/ws",
              LiveDubProtocol.defaultEngineURL == "ws://127.0.0.1:8787/ws",
              detail: "got \(LiveDubProtocol.defaultEngineURL)")
    }

    // MARK: 二进制音频帧

    private static func checkFrames() {
        let samples = (0..<LiveDubProtocol.frameSamples).map { Int16($0 % 1_000) }
        do {
            let frame = try AudioFrameCodec.encode(tMs: 1_234, pcm: samples)
            check("encode frame length == 9 + 3200", frame.count == 3_209, detail: "got \(frame.count)")
            check("frame[0] == 0x01", frame.first == 0x01)
            // 1234.0 的 IEEE754 BE = 40 93 48 00 00 00 00 00
            let expectedTime: [UInt8] = [0x40, 0x93, 0x48, 0x00, 0x00, 0x00, 0x00, 0x00]
            let timeBytes = Array(frame[1..<9])
            check("tMs=1234 float64BE 字节向量", timeBytes == expectedTime, detail: "got \(timeBytes.map { String(format: "%02x", $0) })")

            let zeroFrame = try AudioFrameCodec.encode(tMs: 0, pcm: [1])
            check("tMs=0 时 [1..8] 全 0", Array(zeroFrame[1..<9]) == [UInt8](repeating: 0, count: 8))

            let layoutFrame = try AudioFrameCodec.encode(tMs: 1, pcm: [0x0102, -2])
            check("PCM s16le 字节布局（0x0102 -> 02 01，-2 -> fe ff）",
                  Array(layoutFrame[9..<13]) == [0x02, 0x01, 0xFE, 0xFF],
                  detail: "got \(Array(layoutFrame[9..<13]).map { String(format: "%02x", $0) })")

            let decoded = try AudioFrameCodec.decode(frame)
            check("decode 往返 tMs 一致", decoded.tMs == 1_234, detail: "got \(decoded.tMs)")
            check("decode 往返 PCM 一致", decoded.pcm == samples)
        } catch {
            check("encode 正常路径不抛错", false, detail: "\(error)")
        }

        checkThrows("空 PCM 抛错") {
            _ = try AudioFrameCodec.encode(tMs: 0, pcm: [])
        }
        checkThrows("负 tMs 抛错") {
            _ = try AudioFrameCodec.encode(tMs: -1, pcm: [1])
        }
        checkThrows("超 256KB 帧抛错") {
            _ = try AudioFrameCodec.encode(tMs: 0, pcm: [Int16](repeating: 0, count: 200_000))
        }
        checkThrows("decode 拒绝错误魔数") {
            _ = try AudioFrameCodec.decode(Data([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
        }

        let s16Roundtrip: [Int16] = [0, 1, -1, 32_767, -32_768, 1_234, -2_345]
        check("S16leCodec 往返", S16leCodec.decode(data: S16leCodec.encodeData(s16Roundtrip)) == s16Roundtrip)
    }

    // MARK: hello JSON

    private static func checkHello() {
        let options = HelloOptions(
            source: "macos",
            title: "macOS 系统音频（livedub）",
            url: "",
            langFrom: "en",
            langTo: "zh"
        )
        let object = HelloJSON.object(options: options)
        check("hello.type == hello", object["type"] as? String == "hello")
        check("hello.protocol == 1", object["protocol"] as? Int == 1)
        guard let session = object["session"] as? [String: Any] else {
            check("hello.session 是对象", false)
            return
        }
        let source = session["source"] as? String ?? ""
        check("hello.session.source 在契约枚举内",
              HelloOptions.allowedSources.contains(source), detail: "got \(source)")
        check("hello.session.title 保留中文",
              session["title"] as? String == "macOS 系统音频（livedub）")
        check("hello.session.langFrom/langTo",
              session["langFrom"] as? String == "en" && session["langTo"] as? String == "zh")
        check("hello.session.tMsBase 为 null", session["tMsBase"] is NSNull)
        check("hello.session.overrides 是对象", session["overrides"] is [String: Any])

        do {
            let data = try HelloJSON.data(options: options)
            let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            check("hello JSON 可被 JSONSerialization 解析", parsed != nil, detail: "无效 JSON")
            let text = try HelloJSON.text(options: options)
            check("hello 文本帧非空且含 protocol", !text.isEmpty && text.contains("\"protocol\":1"))
        } catch {
            check("hello 序列化不抛错", false, detail: "\(error)")
        }

        let invalidSource = HelloJSON.object(options: HelloOptions(source: "macos-unknown"))
        let normalized = (invalidSource["session"] as? [String: Any])?["source"] as? String
        check("未知 source 回退 studio", normalized == "studio", detail: "got \(normalized ?? "nil")")
    }

    // MARK: 事件解析

    private static func checkEvents() {
        if case let .ready(sessionId, protocolVersion, providers, voiceMode, voiceId) =
            EngineEventParser.parse([
                "type": "ready",
                "sessionId": "s_123",
                "protocol": 1,
                "providers": ["asr": "whisper-local", "translate": "deepseek", "tts": "minimax"],
                "voice": ["mode": "clone", "voiceId": "male-qn-qingse"],
            ]) {
            check("ready 事件解析",
                  sessionId == "s_123" && protocolVersion == 1
                      && providers["asr"] == "whisper-local"
                      && voiceMode == "clone" && voiceId == "male-qn-qingse")
        } else {
            check("ready 事件解析", false)
        }

        if case let .status(state, detail, tsMs) =
            EngineEventParser.parse(["type": "status", "state": "speaking", "detail": "配音中", "tsMs": 4321]) {
            check("status 事件解析", state == "speaking" && detail == "配音中" && tsMs == 4_321)
        } else {
            check("status 事件解析", false)
        }

        if case let .partial(id, text) =
            EngineEventParser.parse(["type": "partial", "id": "seg_1", "text": "hello wor"]) {
            check("partial 事件解析", id == "seg_1" && text == "hello wor")
        } else {
            check("partial 事件解析", false)
        }

        if case let .segment(id, text, lang) =
            EngineEventParser.parse(["type": "segment", "id": "seg_1", "text": "hello world", "lang": "en"]) {
            check("segment 事件解析", id == "seg_1" && text == "hello world" && lang == "en")
        } else {
            check("segment 事件解析", false)
        }

        if case let .translation(id, text, isFinal) =
            EngineEventParser.parse(["type": "translation", "id": "seg_1", "text": "你好，世界", "final": true]) {
            check("translation(final) 事件解析", id == "seg_1" && text == "你好，世界" && isFinal)
        } else {
            check("translation(final) 事件解析", false)
        }

        let dubSamples: [Int16] = (0..<240).map { Int16($0 - 120) }
        let dubBase64 = S16leCodec.encodeData(dubSamples).base64EncodedString()
        if case let .dub(chunk) =
            EngineEventParser.parse([
                "type": "dub",
                "id": "seg_1",
                "seq": 2,
                "startMs": 1_500,
                "sampleRate": 24_000,
                "format": "s16le",
                "pcm": dubBase64,
                "durationMs": 10,
                "voiceId": "male-qn-qingse",
                "final": false,
            ]) {
            check("dub 事件解析（base64 s16le 24k）",
                  chunk.seq == 2 && chunk.startMs == 1_500 && chunk.sampleRate == 24_000
                      && chunk.samples == dubSamples && chunk.durationMs == 10
                      && chunk.voiceId == "male-qn-qingse" && !chunk.final)
        } else {
            check("dub 事件解析（base64 s16le 24k）", false)
        }

        if case let .dub(finalChunk) =
            EngineEventParser.parse(["type": "dub", "id": "seg_1", "final": true, "pcm": "", "sampleRate": 24_000]) {
            check("dub(final 空 pcm) 解析为空采样", finalChunk.final && finalChunk.samples.isEmpty)
        } else {
            check("dub(final 空 pcm) 解析为空采样", false)
        }

        if case let .metrics(_, e2eLagMs, e2eFromStartMs, asrFinalMs, _, _) =
            EngineEventParser.parse([
                "type": "metrics",
                "id": "seg_1",
                "asrFinalMs": 420,
                "mtFirstMs": 610,
                "ttsFirstMs": 980,
                "e2eLagMs": 2_340,
                "e2eFromStartMs": 3_100,
            ]) {
            check("metrics 事件解析", e2eLagMs == 2_340 && e2eFromStartMs == 3_100 && asrFinalMs == 420)
        } else {
            check("metrics 事件解析", false)
        }

        if case let .voice(mode, voiceId, degraded, reason) =
            EngineEventParser.parse([
                "type": "voice", "mode": "preset", "voiceId": "male-qn-qingse",
                "degraded": true, "reason": "clone 不可用",
            ]) {
            check("voice 事件解析", mode == "preset" && voiceId == "male-qn-qingse" && degraded && reason == "clone 不可用")
        } else {
            check("voice 事件解析", false)
        }

        if case let .error(scope, message, recoverable) =
            EngineEventParser.parse(["type": "error", "scope": "tts", "message": "额度不足", "recoverable": true]) {
            check("error 事件解析", scope == "tts" && message == "额度不足" && recoverable)
        } else {
            check("error 事件解析", false)
        }

        if case .pong = EngineEventParser.parse(["type": "pong", "t": 123]) {
            check("pong 事件解析", true)
        } else {
            check("pong 事件解析", false)
        }

        if case let .bye(reason) = EngineEventParser.parse(["type": "bye", "reason": "server shutdown"]) {
            check("bye 事件解析", reason == "server shutdown")
        } else {
            check("bye 事件解析", false)
        }

        if case let .unknown(type) = EngineEventParser.parse(["type": "future-event"]) {
            check("未知事件保留类型", type == "future-event")
        } else {
            check("未知事件保留类型", false)
        }

        check("非法 JSON 返回 nil", EngineEventParser.parse(text: "not json") == nil)
        if case let .partial(_, text) = EngineEventParser.parse(text: "{\"type\":\"partial\",\"text\":\"hi\"}") {
            check("文本帧 JSON 解析", text == "hi")
        } else {
            check("文本帧 JSON 解析", false)
        }
    }

    // MARK: 字幕排版 / 时间格式

    private static func checkCaptions() {
        check("ASCII 折行", CaptionLayout.wrap("hello world from livedub", maxColumns: 11) ==
            ["hello world", "from", "livedub"],
            detail: "got \(CaptionLayout.wrap("hello world from livedub", maxColumns: 11))")
        check("CJK 按双列宽折行", CaptionLayout.wrap("实时同声传译", maxColumns: 8) == ["实时同声", "传译"],
              detail: "got \(CaptionLayout.wrap("实时同声传译", maxColumns: 8))")
        check("超长英文 token 硬切", CaptionLayout.wrap("supercalifragilisticexpialidocious", maxColumns: 8) ==
            ["supercal", "ifragili", "sticexpi", "alidocio", "us"],
            detail: "got \(CaptionLayout.wrap("supercalifragilisticexpialidocious", maxColumns: 8))")
        check("maxLines=2 截断加省略号",
              CaptionLayout.wrap("hello world from livedub", maxColumns: 11, maxLines: 2) == ["hello world", "fro…"],
              detail: "got \(CaptionLayout.wrap("hello world from livedub", maxColumns: 11, maxLines: 2))")
        check("空文本折行为空数组", CaptionLayout.wrap("", maxColumns: 10).isEmpty)
        check("中文显示宽度 = 2", CaptionLayout.textWidth("中文") == 4 && CaptionLayout.textWidth("abc") == 3)

        check("延迟格式 nil -> —", CaptionLayout.formatLatency(nil) == "—")
        check("延迟格式 405ms -> 0.4s", CaptionLayout.formatLatency(405) == "0.4s")
        check("延迟格式 1834ms -> 1.8s", CaptionLayout.formatLatency(1_834) == "1.8s")
        check("延迟格式 12000ms -> 12.0s", CaptionLayout.formatLatency(12_000) == "12.0s")
        check("状态文案 listening -> 聆听中", CaptionLayout.statusLabel("listening") == "聆听中")
        check("状态文案未知值原样返回", CaptionLayout.statusLabel("custom") == "custom")
    }

    // MARK: 重采样

    private static func checkResampler() {
        let resampler48k = StreamingResampler(inputRate: 48_000)
        let input48k = (0..<4_800).map { Float(sin(2 * Double.pi * 220 * Double($0) / 48_000) * 0.3) }
        let output48k = resampler48k.process(input48k)
        check("48k 0.1s -> 16k 恰好 1600 采样", output48k.count == 1_600, detail: "got \(output48k.count)")

        let silence = StreamingResampler(inputRate: 48_000).process([Float](repeating: 0, count: 4_800))
        check("48k 静音重采样输出全 0", silence.allSatisfy { $0 == 0 } && silence.count == 1_600)

        let rmsValue = PcmMath.rms(output48k)
        check("48k 220Hz 正弦 RMS 合理", rmsValue > 0.15 && rmsValue < 0.30,
              detail: String(format: "rms=%.3f", rmsValue))

        let output441k = StreamingResampler(inputRate: 44_100).process([Float](repeating: 0.1, count: 4_410))
        check("44.1k 0.1s -> 16k 约 1600 采样", abs(output441k.count - 1_600) <= 2,
              detail: "got \(output441k.count)")
        check("重采样输出在 s16 范围内", PcmMath.peak(output441k) <= 1.0)
    }

    // MARK: 100ms 分帧

    private static func checkChunker() {
        let chunker = FrameChunker()
        check("不足 100ms 不出帧", chunker.push([Int16](repeating: 1, count: 1_599)).isEmpty
              && chunker.frameIndex == 0)

        let first = chunker.push([Int16](repeating: 2, count: 1))
        check("补满 1600 采样出 1 帧且 tMs=0",
              first.count == 1 && first[0].tMs == 0 && first[0].pcm.count == 1_600)
        check("帧内容正确（前 1599 个旧采样 + 第 1600 个新采样）",
              first.first?.pcm.first == 1 && first.first?.pcm.last == 2)

        let next = chunker.push([Int16](repeating: 3, count: 3_200))
        check("3200 采样出 2 帧 tMs=100/200",
              next.map { $0.tMs } == [100, 200], detail: "got \(next.map { $0.tMs })")

        chunker.reset()
        check("reset 后帧序号归零", chunker.frameIndex == 0)
    }

    // MARK: 设置清洗

    private static func checkSettings() {
        let fallback = LiveDubProtocol.defaultEngineURL
        check("空地址 -> 默认", Settings.normalizeEngineURL("") == fallback)
        check("裸 host:port/path -> ws://",
              Settings.normalizeEngineURL("127.0.0.1:8787/ws") == fallback,
              detail: "got \(Settings.normalizeEngineURL("127.0.0.1:8787/ws"))")
        check("localhost:9000 -> 补 /ws",
              Settings.normalizeEngineURL("localhost:9000") == "ws://localhost:9000/ws",
              detail: "got \(Settings.normalizeEngineURL("localhost:9000"))")
        check("http:// 映射到 ws://",
              Settings.normalizeEngineURL("http://127.0.0.1:8787/ws") == fallback)
        check("无路径补 /ws",
              Settings.normalizeEngineURL("ws://127.0.0.1:8787") == fallback)
        check("默认地址保持稳定", Settings.normalizeEngineURL(fallback) == fallback)
    }

    // MARK: 演示数据

    private static func checkSimulationData() {
        check("simulate 演示语料 >= 4 轮", SimulatedSession.turns.count >= 4)
        check("simulate 语料均为中英双语",
              SimulatedSession.turns.allSatisfy { !$0.en.isEmpty && !$0.zh.isEmpty })
    }

    // MARK: - 断言帮手

    private static func check(_ name: String, _ condition: Bool, detail: String = "") {
        total += 1
        if condition {
            print("ok \(String(format: "%02d", total)) \(name)")
        } else {
            let full = detail.isEmpty ? name : "\(name) [\(detail)]"
            failures.append(full)
            print("FAIL \(String(format: "%02d", total)) \(full)")
        }
    }

    private static func checkThrows(_ name: String, _ body: () throws -> Void) {
        total += 1
        do {
            try body()
            failures.append(name)
            print("FAIL \(String(format: "%02d", total)) \(name)")
        } catch {
            print("ok \(String(format: "%02d", total)) \(name)")
        }
    }
}
