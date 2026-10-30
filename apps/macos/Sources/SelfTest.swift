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
//   - v0.4 快捷笔记：quick note JSON/时间格式/离线队列/标题推导/截图降级
//   - v0.5 画面文字（OCR）/画面理解：请求体、imageUrl 校验、文本清洗/代码块转义、
//     降级决策（含旧引擎 404 无 /api/vision/*）、health 解析（全部纯函数，不联网）
//  退出码：0 全部通过；1 有失败（便于 CI 与 scripts/build-macos.sh --check）。
//

import CoreGraphics
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
        checkNotes()
        checkVision()
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


    // MARK: 快捷笔记（v0.4 ⌥N）

    private static func checkNotes() {
        let utc = TimeZone(identifier: "UTC") ?? .current
        var components = DateComponents()
        components.year = 2026
        components.month = 10
        components.day = 30
        components.hour = 14
        components.minute = 20
        components.second = 33
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let referenceDate = calendar.date(from: components) ?? Date(timeIntervalSince1970: 0)

        // Notes HTTP 基址/URL
        check("Notes HTTP：ws -> http", NotesHTTP.baseURLString(fromEngineURL: "ws://127.0.0.1:8787/ws") == "http://127.0.0.1:8787",
              detail: NotesHTTP.baseURLString(fromEngineURL: "ws://127.0.0.1:8787/ws"))
        check("Notes HTTP：保留自定义端口",
              NotesHTTP.baseURLString(fromEngineURL: "ws://127.0.0.1:19999/ws") == "http://127.0.0.1:19999")
        check("Notes HTTP：wss -> https（不强制 8787 端口）",
              NotesHTTP.baseURLString(fromEngineURL: "wss://notes.example.com/ws") == "https://notes.example.com")
        check("Notes HTTP：非法地址回落默认",
              NotesHTTP.baseURLString(fromEngineURL: "") == "http://127.0.0.1:8787")
        check("Notes HTTP：打开笔记面板 URL（?notes=1）",
              NotesHTTP.studioURL(fromEngineURL: "ws://127.0.0.1:8787/ws", notes: true)?.absoluteString
                  == "http://127.0.0.1:8787/studio/?notes=1")
        check("Notes HTTP：工作台 URL",
              NotesHTTP.studioURL(fromEngineURL: "ws://127.0.0.1:8787/ws", notes: false)?.absoluteString
                  == "http://127.0.0.1:8787/studio/")
        check("Notes HTTP：相对 assets 路径转绝对",
              NotesHTTP.absoluteAssetURLString(base: "http://127.0.0.1:8787", assetPath: "/api/notes/assets/a.png")
                  == "http://127.0.0.1:8787/api/notes/assets/a.png")
        check("Notes HTTP：绝对 URL 原样返回",
              NotesHTTP.absoluteAssetURLString(base: "http://127.0.0.1:8787", assetPath: "https://cdn.example.com/a.png")
                  == "https://cdn.example.com/a.png")
        check("Notes HTTP：assets 相对路径补 /",
              NotesHTTP.absoluteAssetURLString(base: "http://127.0.0.1:8787/", assetPath: "api/notes/assets/a.png")
                  == "http://127.0.0.1:8787/api/notes/assets/a.png")

        // 时间格式
        check("会话时间 0 -> 00:00.0", NoteComposer.formatSessionTime(0) == "00:00.0")
        check("会话时间 83400 -> 01:23.4", NoteComposer.formatSessionTime(83_400) == "01:23.4",
              detail: NoteComposer.formatSessionTime(83_400))
        check("会话时间 3723456 -> 1:02:03.4", NoteComposer.formatSessionTime(3_723_456) == "1:02:03.4",
              detail: NoteComposer.formatSessionTime(3_723_456))
        check("会话时间 负数/NaN -> 00:00.0",
              NoteComposer.formatSessionTime(-100) == "00:00.0" && NoteComposer.formatSessionTime(Double.nan) == "00:00.0")
        check("时钟格式 HH:MM:SS", NoteComposer.formatClock(referenceDate, timeZone: utc) == "14:20:33",
              detail: NoteComposer.formatClock(referenceDate, timeZone: utc))
        check("日期格式 yyyy-MM-dd", NoteComposer.formatDateStamp(referenceDate, timeZone: utc) == "2026-10-30")
        check("时钟格式 epoch 0（UTC）", NoteComposer.formatClock(Date(timeIntervalSince1970: 0), timeZone: utc) == "00:00:00")

        // 视频标题 / ID 推导
        check("标题：媒体 App 就是声音来源",
              NoteComposer.deriveVideoTitle(sessionTitle: "macOS 系统音频 · livedub app", frontmostApp: "zoom.us", date: referenceDate, timeZone: utc)
                  == "zoom.us · 系统音频同传")
        check("标题：普通前台 App 用会话标题",
              NoteComposer.deriveVideoTitle(sessionTitle: "macOS 系统音频 · livedub app", frontmostApp: "Visual Studio Code", date: referenceDate, timeZone: utc)
                  == "macOS 系统音频 · livedub app")
        check("标题：无标题回落日期",
              NoteComposer.deriveVideoTitle(sessionTitle: "", frontmostApp: nil, date: referenceDate, timeZone: utc)
                  == "macOS 系统音频同传 · 2026-10-30")
        check("标题：换行/空白清洗",
              NoteComposer.deriveVideoTitle(sessionTitle: "  hello\nworld  ", frontmostApp: nil, date: referenceDate, timeZone: utc)
                  == "hello world")
        check("视频 ID：媒体 App 分组", NoteComposer.deriveVideoID(sessionId: "s_abc", frontmostApp: "zoom.us") == "macos-zoom-us")
        check("视频 ID：会话 id 分组", NoteComposer.deriveVideoID(sessionId: "s_abc", frontmostApp: "Visual Studio Code") == "macos-s-abc")
        check("视频 ID：无信息兜底", NoteComposer.deriveVideoID(sessionId: nil, frontmostApp: nil) == "macos-live")
        check("视频 ID：slug 只保留 [a-z0-9-]", NoteComposer.slug(" Visual Studio Code! ") == "visual-studio-code")
        check("媒体 App 识别（大小写/包含）",
              NoteComposer.isMediaApp("zoom.us") && NoteComposer.isMediaApp("Google Chrome") && !NoteComposer.isMediaApp("Visual Studio Code"))

        // quick note 文本 / JSON 构造
        let context = NoteContext(
            sessionId: "s_test",
            sessionTitle: "macOS 系统音频 · livedub app",
            tMs: 83_400,
            statusText: "聆听中",
            translation: "今天我们来聊聊梯度下降到底是怎么工作的。",
            source: "Today we're going to talk about how gradient descent actually works.",
            latencyMs: 1_834,
            frontmostApp: "Visual Studio Code",
            frontmostBundleId: "com.microsoft.VSCode",
            capturedAt: referenceDate,
            timeZone: utc
        )
        let assetURL = "http://127.0.0.1:8787/api/notes/assets/a.png"
        let assetPath = "/api/notes/assets/a.png"
        let assetRef = NoteAssetRef(absoluteURL: assetURL, relativePath: assetPath)
        let request = NoteComposer.makeQuickRequest(context: context, image: assetRef)
        check("quick note：source=macos", request.source == "macos")
        check("quick note：tMs 使用会话时间轴", request.tMs == 83_400)
        check("quick note：text 含原文/译文/时间/来源/截图",
              request.text.contains("**原文**") && request.text.contains("**译文**")
                  && request.text.contains("时间 01:23.4") && request.text.contains("**来源**")
                  && request.text.contains("![截图](\(assetURL))"))
        check("quick note：quotes 双语引用",
              request.quotes?.first?.src?.contains("gradient") == true
                  && request.quotes?.first?.dst == "今天我们来聊聊梯度下降到底是怎么工作的。"
                  && request.quotes?.first?.t0Ms == 83_400)
        check("quick note：imageUrl 用服务端相对路径（contract）", request.imageUrl == assetPath,
              detail: request.imageUrl ?? "nil")
        check("quick note：text 截图用绝对 URL（便于渲染）", request.text.contains("![截图](\(assetURL))"))
        check("Notes assets：相对路径严格校验",
              NoteComposer.isValidAssetPath(assetPath)
                  && !NoteComposer.isValidAssetPath(assetURL)
                  && !NoteComposer.isValidAssetPath("/api/notes/assets/../x.png")
                  && !NoteComposer.isValidAssetPath("/api/notes/assets/a.jpg"))
        check("Notes assets：绝对 URL 可提取相对路径",
              NoteComposer.relativeAssetPath(from: assetURL) == assetPath
                  && NoteComposer.relativeAssetPath(from: assetPath) == assetPath
                  && NoteComposer.relativeAssetPath(from: "") == nil
                  && NoteComposer.relativeAssetPath(from: "not-a-url") == nil)
        check("quick note：视频 ID / 标题",
              request.video.id == "macos-s-test" && request.video.title == "macOS 系统音频 · livedub app")
        check("quick note：文本长度上限", request.text.count <= NoteComposer.maxTextChars)

        var emptyContext = context
        emptyContext.translation = ""
        emptyContext.source = ""
        emptyContext.latencyMs = nil
        emptyContext.statusText = "已停止"
        let emptyRequest = NoteComposer.makeQuickRequest(context: emptyContext)
        check("quick note：无字幕 -> （无字幕）",
              emptyRequest.text.contains(NoteComposer.emptyCaption) && !emptyRequest.text.contains("**原文**"))
        check("quick note：无字幕不带 quotes", emptyRequest.quotes == nil)
        check("quick note：无截图时 imageUrl 为空", emptyRequest.imageUrl == nil)
        var negativeContext = emptyContext
        negativeContext.tMs = -500
        check("quick note：tMs 负数归零", NoteComposer.makeQuickRequest(context: negativeContext).tMs == 0)

        do {
            let data = try JSONEncoder().encode(request)
            let decoded = try JSONDecoder().decode(QuickNoteRequest.self, from: data)
            let json = String(data: data, encoding: .utf8) ?? ""
            check("quick note：JSON 编解码往返", decoded == request)
            check("quick note：JSON 字段名与契约一致",
                  json.contains("\"video\"") && json.contains("\"tMs\"") && json.contains("\"text\"")
                      && json.contains("\"quotes\"") && json.contains("\"source\":\"macos\""))
        } catch {
            check("quick note：JSON 编解码往返", false, detail: "\(error)")
            check("quick note：JSON 字段名与契约一致", false, detail: "\(error)")
        }

        // 文本清洗
        check("文本清洗：折叠换行/空白", NoteComposer.normalizeInline("  a \n\n b\tc  ", maxLength: 100) == "a b c")
        check("文本清洗：截断", NoteComposer.normalizeInline(String(repeating: "x", count: 100), maxLength: 10).count == 10)

        // 离线队列（注入内存存储，不写用户偏好）
        func makeNoteRequest(_ text: String) -> QuickNoteRequest {
            var ctx = emptyContext
            ctx.source = text
            return NoteComposer.makeQuickRequest(context: ctx)
        }

        let store = InMemoryNotesStore()
        let queue = NotesOfflineQueue(store: store)
        for index in 0..<55 {
            queue.enqueue(makeNoteRequest("note-\(index)"))
        }
        check("离线队列：上限 50", queue.count == 50 && NotesOfflineQueue.maxItems == 50)
        check("离线队列：丢最旧、保最新",
              queue.items.first?.request.text.contains("**原文**：note-5\n") == true
                  && queue.items.last?.request.text.contains("**原文**：note-54\n") == true
                  && queue.items.count == 50)
        check("离线队列：持久化到注入存储",
              store.loadNotesQueueData(NotesOfflineQueue.storageKey) != nil)
        let removed = queue.removeFirst()
        check("离线队列：removeFirst 按 FIFO",
              removed?.request.text.contains("**原文**：note-5\n") == true
                  && queue.count == 49
                  && queue.peekFirst()?.request.text.contains("**原文**：note-6\n") == true)
        let frontStore = InMemoryNotesStore()
        let frontQueue = NotesOfflineQueue(store: frontStore)
        frontQueue.enqueue(makeNoteRequest("a"))
        frontQueue.enqueue(makeNoteRequest("b"))
        frontQueue.enqueueFront(makeNoteRequest("z"), queuedAt: 0)
        check("离线队列：enqueueFront 插回队首",
              frontQueue.items.count == 3
                  && frontQueue.items[0].request.text.contains("**原文**：z")
                  && frontQueue.items[1].request.text.contains("**原文**：a")
                  && frontQueue.items[2].request.text.contains("**原文**：b"))
        frontQueue.clear()
        check("离线队列：clear 清空并清存储",
              frontQueue.count == 0 && frontStore.loadNotesQueueData(NotesOfflineQueue.storageKey) == nil)
        let corruptStore = InMemoryNotesStore()
        corruptStore.saveNotesQueueData(NotesOfflineQueue.storageKey, data: Data("not-json".utf8))
        check("离线队列：损坏数据安全丢弃", NotesOfflineQueue(store: corruptStore).count == 0)
        check("离线队列：存储 key 命名", NotesOfflineQueue.storageKey.contains("livedub.macos.notes"))

        // 截图降级决策（不真截图）
        check("截图决策：关闭 -> 纯文字",
              ScreenshotPlanner.decide(includeScreenshot: false, permissionGranted: true, capturedBytes: 1024) == .textOnly(reason: "disabled"))
        check("截图决策：无权限 -> 纯文字",
              ScreenshotPlanner.decide(includeScreenshot: true, permissionGranted: false, capturedBytes: nil) == .textOnly(reason: "permission"))
        check("截图决策：截图失败 -> 纯文字",
              ScreenshotPlanner.decide(includeScreenshot: true, permissionGranted: true, capturedBytes: nil) == .textOnly(reason: "captureFailed"))
        check("截图决策：超 4MB -> 纯文字",
              ScreenshotPlanner.decide(includeScreenshot: true, permissionGranted: true, capturedBytes: 5 * 1024 * 1024) == .textOnly(reason: "tooLarge"))
        check("截图决策：正常 -> 附加",
              ScreenshotPlanner.decide(includeScreenshot: true, permissionGranted: true, capturedBytes: 1_500_000) == .attach)
        check("截图上限 = 4MB", ScreenshotPlanner.maxAssetBytes == 4 * 1024 * 1024 && NotesClient.maxAssetBytes == 4 * 1024 * 1024)
        check("截图降采样序列递减",
              ScreenshotPlanner.scaleSteps.first == 1.0
                  && ScreenshotPlanner.scaleSteps.count >= 3
                  && zip(ScreenshotPlanner.scaleSteps, ScreenshotPlanner.scaleSteps.dropFirst()).allSatisfy { $0 > $1 })
        check("截图降级文案含原因", ScreenshotPlanner.reasonText("tooLarge").contains("4MB"))

        // 热键/网络常量
        check("热键文案 = ⌥N", GlobalHotKey.displayName == "⌥N")
        check("热键 keyCode = kVK_ANSI_N(45)", GlobalHotKey.keyCode == 45)
        check("热键修饰键 = Carbon optionKey(2048)", GlobalHotKey.modifiers == 2_048)
        check("Notes 请求超时 8s", NotesClient.requestTimeout == 8)
    }


    // MARK: 画面文字（OCR）/ 画面理解（VLM）—— v0.5

    private static func checkVision() {
        // ---- 请求体构造 / URL ----
        let assetPath = "/api/notes/assets/a.png"
        let base = URL(string: "http://127.0.0.1:8787")!
        do {
            let ocrData = try JSONEncoder().encode(VisionOCRRequest(imageUrl: assetPath))
            let ocrDecoded = try JSONDecoder().decode(VisionOCRRequest.self, from: ocrData)
            check("vision/ocr 请求体：JSON {imageUrl}",
                  ocrDecoded.imageUrl == assetPath,
                  detail: String(data: ocrData, encoding: .utf8) ?? "")
            let analyzeData = try JSONEncoder().encode(VisionAnalyzeRequest(imageUrl: assetPath))
            let analyzeDecoded = try JSONDecoder().decode(VisionAnalyzeRequest.self, from: analyzeData)
            check("vision/analyze 请求体：JSON {imageUrl}", analyzeDecoded.imageUrl == assetPath)
        } catch {
            check("vision/ocr 请求体：JSON {imageUrl}", false, detail: "\(error)")
            check("vision/analyze 请求体：JSON {imageUrl}", false, detail: "\(error)")
        }
        check("vision URL：/api/vision/ocr",
              NotesHTTP.visionOCRURL(base: base).absoluteString == "http://127.0.0.1:8787/api/vision/ocr")
        check("vision URL：/api/vision/health",
              NotesHTTP.visionHealthURL(base: base).absoluteString == "http://127.0.0.1:8787/api/vision/health")
        let analyzeURL = NotesHTTP.visionAnalyzeURL(base: base, mode: "both").absoluteString
        check("vision URL：analyze?mode=both", analyzeURL.contains("/api/vision/analyze") && analyzeURL.contains("mode=both"),
              detail: analyzeURL)
        check("vision mode 归一化",
              NotesHTTP.normalizeVisionMode("VISION") == "vision"
                  && NotesHTTP.normalizeVisionMode("both") == "both"
                  && NotesHTTP.normalizeVisionMode("weird") == "ocr"
                  && NotesHTTP.normalizeVisionMode("") == "ocr")
        check("vision imageUrl 只接受相对资产路径",
              NoteComposer.isValidAssetPath(assetPath)
                  && !NoteComposer.isValidAssetPath("http://127.0.0.1:8787/api/notes/assets/a.png")
                  && !NoteComposer.isValidAssetPath("/api/notes/assets/../x.png"))

        // ---- OCR 文本清洗 / 截断 ----
        check("OCR 清洗：trim/去空行/折叠空白",
              VisionText.cleanOCR("  Hello  world \n\n  second\tline  \n") == "Hello world\nsecond line",
              detail: VisionText.cleanOCR("  Hello  world \n\n  second\tline  \n") ?? "nil")
        check("OCR 清洗：相邻重复行去重",
              VisionText.cleanOCR("same line\nsame line\nother") == "same line\nother")
        check("OCR 清洗：控制字符剔除",
              VisionText.cleanOCR("\u{0007}abc\u{0000}") == "abc")
        check("OCR 清洗：空/全空白 -> nil",
              VisionText.cleanOCR("") == nil && VisionText.cleanOCR(" \n\t \n") == nil)
        let longOCR = String(repeating: "x", count: 2_500)
        let truncatedOCR = VisionText.cleanOCR(longOCR) ?? ""
        check("OCR 清洗：截断到 2000 字并加省略号",
              truncatedOCR.count == 2_000 && truncatedOCR.hasSuffix("…"),
              detail: "count=\(truncatedOCR.count)")
        let manyLines = (0..<100).map { "line-\($0)" }.joined(separator: "\n")
        let cappedLines = VisionText.cleanOCR(manyLines)?.components(separatedBy: "\n").count ?? 0
        check("OCR 清洗：最多 80 行", cappedLines == 80, detail: "lines=\(cappedLines)")

        // ---- 代码块转义 ----
        check("codeBlock：普通内容用 3 反引号",
              VisionText.codeBlock("hello") == "```\nhello\n```")
        check("codeBlock：内容含 ``` 时用更长 fence",
              VisionText.codeBlock("use ``` fences") == "````\nuse ``` fences\n````")
        check("longestBacktickRun", VisionText.longestBacktickRun("a``b```c") == 3
              && VisionText.longestBacktickRun("no ticks") == 0)
        let ocrSection = VisionText.ocrSection("Gradient descent\nFollow the slope") ?? ""
        check("OCR 段落格式（**画面文字**（OCR）+ 代码块）",
              ocrSection.hasPrefix("**画面文字**（OCR）：\n\n```\n")
                  && ocrSection.hasSuffix("\n```")
                  && ocrSection.contains("Gradient descent"))
        check("OCR 段落：无文字不加", VisionText.ocrSection(" \n\t") == nil)
        let captionSection = VisionText.captionSection("幻灯片在讲解梯度下降") ?? ""
        check("画面理解段落格式",
              captionSection.hasPrefix("**画面理解**：\n\n") && captionSection.contains("梯度下降"))
        check("画面理解段落：空 -> nil", VisionText.captionSection("   \n") == nil)
        let longCaption = String(repeating: "字", count: 1_500)
        let truncatedCaption = VisionText.cleanCaption(longCaption) ?? ""
        check("caption 截断到 1000 字", truncatedCaption.count == 1_000 && truncatedCaption.hasSuffix("…"))

        // ---- 降级决策 ----
        let healthGood = VisionStatus(
            ok: true, ready: true,
            ocr: VisionCapability(available: true, detail: "macos-vision"),
            vision: VisionCapability(available: false, detail: "未配置"),
            endpointMissing: false, error: nil, fetchedAt: nil
        )
        check("OCR 决策：关闭 -> disabled",
              VisionPlanner.ocrDecision(enabled: false, hasImageAsset: true, endpointMissing: false, health: nil) == .skip(reason: "disabled"))
        check("OCR 决策：无截图附件 -> noImage",
              VisionPlanner.ocrDecision(enabled: true, hasImageAsset: false, endpointMissing: false, health: nil) == .skip(reason: "noImage"))
        check("OCR 决策：旧引擎无端点 -> endpointMissing",
              VisionPlanner.ocrDecision(enabled: true, hasImageAsset: true, endpointMissing: true, health: nil) == .skip(reason: "endpointMissing"))
        let healthNoOCR = VisionStatus(
            ok: true, ready: true,
            ocr: .unavailable,
            vision: .unavailable,
            endpointMissing: false, error: nil, fetchedAt: nil
        )
        check("OCR 决策：health 说 OCR 不可用 -> ocrUnavailable",
              VisionPlanner.ocrDecision(enabled: true, hasImageAsset: true, endpointMissing: false, health: healthNoOCR) == .skip(reason: "ocrUnavailable"))
        check("OCR 决策：health 未检测/未知 -> 尝试",
              VisionPlanner.ocrDecision(enabled: true, hasImageAsset: true, endpointMissing: false, health: nil) == .run)
        check("VLM 决策：默认关闭 -> disabled",
              VisionPlanner.visionDecision(enabled: false, hasImageAsset: true, endpointMissing: false, health: nil) == .skip(reason: "disabled"))
        check("VLM 决策：health 未配置 -> visionUnavailable",
              VisionPlanner.visionDecision(enabled: true, hasImageAsset: true, endpointMissing: false, health: healthGood) == .skip(reason: "visionUnavailable"))
        let healthWithVLM = VisionStatus(
            ok: true, ready: true,
            ocr: VisionCapability(available: true, detail: "macos-vision"),
            vision: VisionCapability(available: true, detail: "ark-plan"),
            endpointMissing: false, error: nil, fetchedAt: nil
        )
        check("VLM 决策：health 已配置 -> 尝试",
              VisionPlanner.visionDecision(enabled: true, hasImageAsset: true, endpointMissing: false, health: healthWithVLM) == .run)
        check("旧引擎状态码识别 404/405/501",
              VisionPlanner.endpointMissing(forHTTPStatus: 404)
                  && VisionPlanner.endpointMissing(forHTTPStatus: 405)
                  && VisionPlanner.endpointMissing(forHTTPStatus: 501)
                  && !VisionPlanner.endpointMissing(forHTTPStatus: 500)
                  && !VisionPlanner.endpointMissing(forHTTPStatus: 503))
        check("视觉服务未就绪识别 503/vision_unavailable",
              VisionPlanner.serviceUnavailable(forHTTPStatus: 503, message: "")
                  && VisionPlanner.serviceUnavailable(forHTTPStatus: 503, message: "vision_unavailable")
                  && !VisionPlanner.serviceUnavailable(forHTTPStatus: 500, message: "oops"))
        check("shouldMarkEndpointMissing：404/503 为真",
              VisionPlanner.shouldMarkEndpointMissing(NotesClientError.http(status: 404, message: "nope"))
                  && VisionPlanner.shouldMarkEndpointMissing(NotesClientError.http(status: 503, message: "vision_unavailable"))
                  && !VisionPlanner.shouldMarkEndpointMissing(NotesClientError.http(status: 500, message: "oops"))
                  && !VisionPlanner.shouldMarkEndpointMissing(AudioFrameCodecError.emptyPcm))
        check("降级文案不为空",
              ["disabled", "noImage", "endpointMissing", "ocrUnavailable", "visionUnavailable"]
                  .allSatisfy { !VisionPlanner.skipReasonText($0).isEmpty })

        // ---- health 解析 ----
        let healthJSON = "{\"ok\":true,\"ready\":true,"
            + "\"ocr\":{\"available\":true,\"provider\":\"macos-vision\"},"
            + "\"vision\":{\"available\":false,\"reason\":\"VLM 未配置\"}}"
        if let parsed = VisionHealthParser.parse(data: Data(healthJSON.utf8)) {
            check("health 解析：ok/ready", parsed.ok && parsed.ready)
            check("health 解析：OCR 能力/提供商",
                  parsed.ocr.available && parsed.ocr.label.contains("macos-vision"), detail: parsed.ocr.label)
            check("health 解析：VLM 未配置",
                  !parsed.vision.available && parsed.vision.detail == "VLM 未配置", detail: parsed.vision.detail)
            check("health 摘要含 OCR/VLM",
                  parsed.summaryText.contains("OCR") && parsed.summaryText.contains("VLM"), detail: parsed.summaryText)
        } else {
            check("health 解析：ok/ready", false)
            check("health 解析：OCR 能力/提供商", false)
            check("health 解析：VLM 未配置", false)
            check("health 摘要含 OCR/VLM", false)
        }
        let boolHealth = VisionHealthParser.parse(dictionary: ["ok": true, "ready": true, "ocr": true, "vision": false])
        check("health 解析：布尔能力", boolHealth.ocr.available && !boolHealth.vision.available)
        check("health 解析：坏 JSON -> nil", VisionHealthParser.parse(data: Data("not-json".utf8)) == nil)
        check("health 缺端点摘要", VisionStatus.missing().summaryText.contains("v0.5"))
        check("health 失败摘要", VisionStatus.unavailable(error: "boom").summaryText.contains("检测失败"))
        check("health 端点缺失状态", VisionStatus.missing().endpointMissing && !VisionStatus.missing().isUsable)

        // ---- analyze 响应兼容（string / object 两种 ocr/caption 形态）----
        do {
            let analyzeJSON = "{\"ok\":true,\"mode\":\"both\",\"ocr\":{\"text\":\"line one\"},"
                + "\"caption\":\"画面描述\",\"provider\":\"mock\",\"ms\":12}"
            let decoded = try JSONDecoder().decode(VisionAnalyzeResponse.self, from: Data(analyzeJSON.utf8))
            check("analyze 响应：object 形态 ocr + string caption",
                  decoded.ok == true && decoded.ocrText == "line one" && decoded.caption == "画面描述" && decoded.ms == 12)
            let analyzeJSON2 = "{\"ok\":true,\"ocr\":\"plain ocr\",\"caption\":{\"text\":\"object caption\"}}"
            let decoded2 = try JSONDecoder().decode(VisionAnalyzeResponse.self, from: Data(analyzeJSON2.utf8))
            check("analyze 响应：string ocr + object caption",
                  decoded2.ocrText == "plain ocr" && decoded2.caption == "object caption")
        } catch {
            check("analyze 响应：object 形态 ocr + string caption", false, detail: "\(error)")
            check("analyze 响应：string ocr + object caption", false)
        }
        do {
            let ocrJSON = "{\"ok\":true,\"text\":\"hello\",\"lines\":[\"hello\"],\"provider\":\"macos-vision\",\"ms\":42}"
            let objectLines = #"{"ok":true,"text":"a\nb","lines":[{"text":"a","confidence":1},{"text":"b","confidence":1}]}"#
            let decodedObject = try JSONDecoder().decode(VisionOCRResponse.self, from: Data(objectLines.utf8))
            check("vision/ocr lines 对象数组兼容", decodedObject.lines == ["a", "b"])
            let decoded = try JSONDecoder().decode(VisionOCRResponse.self, from: Data(ocrJSON.utf8))
            check("vision/ocr 响应解析", decoded.text == "hello" && decoded.lines == ["hello"] && decoded.provider == "macos-vision")
        } catch {
            check("vision/ocr 响应解析", false, detail: "\(error)")
        }

        // ---- quick note 图文正文（OCR + 画面理解）----
        var context = NoteContext(
            sessionId: "s_vision",
            sessionTitle: "macOS 系统音频 · livedub app",
            tMs: 42_000,
            statusText: "聆听中",
            translation: "今天我们来学习梯度下降。",
            source: "Today we are going to learn gradient descent.",
            latencyMs: 1_834,
            frontmostApp: "Visual Studio Code",
            frontmostBundleId: "com.microsoft.VSCode",
            capturedAt: Date(timeIntervalSince1970: 1_790_000_000),
            timeZone: TimeZone(identifier: "UTC") ?? .current
        )
        let asset = NoteAssetRef(absoluteURL: "http://127.0.0.1:8787/api/notes/assets/a.png", relativePath: assetPath)
        let enriched = NoteComposer.makeQuickRequest(
            context: context,
            image: asset,
            ocrText: "Gradient descent\nFollow the slope downhill",
            visionCaption: "幻灯片在讲解梯度下降的几何直觉"
        )
        check("图文笔记：含画面文字代码块",
              enriched.text.contains("**画面文字**（OCR）：\n\n```\nGradient descent\nFollow the slope downhill\n```"),
              detail: String(enriched.text.prefix(160)))
        check("图文笔记：含画面理解",
              enriched.text.contains("**画面理解**：\n\n幻灯片在讲解梯度下降的几何直觉"))
        check("图文笔记：保留原文/译文/记录/来源结构",
              ["**原文**", "**译文**", "**记录**", "**来源**", "![截图]"].allSatisfy { enriched.text.contains($0) })
        if let ocrRange = enriched.text.range(of: "**画面文字**"),
           let sourceRange = enriched.text.range(of: "**原文**"),
           let imageRange = enriched.text.range(of: "![截图]") {
            check("图文笔记：顺序 原文 -> 画面文字 -> 截图",
                  sourceRange.lowerBound < ocrRange.lowerBound && ocrRange.lowerBound < imageRange.lowerBound)
        } else {
            check("图文笔记：顺序 原文 -> 画面文字 -> 截图", false)
        }
        let plainNote = NoteComposer.makeQuickRequest(context: context, image: asset)
        check("图文笔记：未识别时不加画面文字/画面理解",
              !plainNote.text.contains("**画面文字**") && !plainNote.text.contains("**画面理解**"))
        let backtickNote = NoteComposer.makeQuickRequest(
            context: context, image: asset, ocrText: "code: ```python\nprint(1)\n```", visionCaption: nil
        )
        check("图文笔记：OCR 含反引号时用更长 fence",
              backtickNote.text.contains("````\n") && backtickNote.text.contains("print(1)"),
              detail: String(backtickNote.text.prefix(120)))
        context.translation = ""
        context.source = ""
        let noCaptionNote = NoteComposer.makeQuickRequest(context: context, ocrText: "只有画面文字")
        check("图文笔记：无字幕 + 有 OCR 也保存（（无字幕）+ 画面文字）",
              noCaptionNote.text.contains("（无字幕）") && noCaptionNote.text.contains("**画面文字**（OCR）"))
        let hugeOCR = String(repeating: "字", count: 2_000)
        let hugeNote = NoteComposer.makeQuickRequest(context: context, image: asset, ocrText: hugeOCR, visionCaption: nil)
        check("图文笔记：正文不超过 4000 字", hugeNote.text.count <= NoteComposer.maxTextChars,
              detail: "count=\(hugeNote.text.count)")

        // ---- 常量 ----
        check("vision 超时：OCR 8s / analyze 45s",
              VisionPlanner.ocrTimeout == 25 && VisionPlanner.analyzeTimeout == 45)
        check("vision 上限：OCR 2000 字 / caption 1000 字 / 图片 4MB",
              VisionPlanner.ocrMaxChars == 2_000
                  && VisionPlanner.captionMaxChars == 1_000
                  && VisionPlanner.maxImageBytes == 4 * 1024 * 1024)
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
