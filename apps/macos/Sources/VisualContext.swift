//
//  VisualContext.swift
//  livedub macOS 菜单栏 App
//
//  v0.6 可选「实时画面上下文」：会话直播时每 N 秒（默认 10s）截屏 -> assets 上传 ->
//  /api/vision/ocr -> 清洗截断 -> 通过 WS 文本帧推给引擎，供实时翻译参考。
//
//  WS 事件契约（client -> engine，JSON text frame，不需要响应）：
//    {"type":"visual-context","text":"<OCR 1..2000字>","tMs":<number>,
//     "source":"macos","capturedAtMs":<number>}
//  - 引擎 TTL 120s；相同内容重复发送会被引擎忽略；
//  - 只在已连接会话时发送；断开不排队（画面上下文过期无意义）；
//  - 本文件全是纯逻辑（事件 JSON/清洗/去重/发送决策/状态文案），网络与截图在 main.swift 异步执行，
//    --self-test 不联网即可覆盖。
//

import Foundation

// MARK: - 事件模型

struct VisualContextEvent: Codable, Equatable {
    var type: String
    var text: String
    var tMs: Double
    var source: String
    var capturedAtMs: Double

    init(text: String, tMs: Double, capturedAtMs: Double) {
        self.type = "visual-context"
        self.text = text
        self.tMs = tMs
        self.source = "macos"
        self.capturedAtMs = capturedAtMs
    }

    /// WS 发送用 JSON 字典（字段与引擎契约一致）
    var jsonObject: [String: Any] {
        [
            "type": type,
            "text": text,
            "tMs": tMs,
            "source": source,
            "capturedAtMs": capturedAtMs,
        ]
    }

    /// 编码成 JSON 文本帧（self-test 校验字段名/类型）
    func jsonText() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(self)
        guard let text = String(data: data, encoding: .utf8) else {
            throw NotesClientError.encoding("visual-context 事件编码失败")
        }
        return text
    }
}

/// 菜单/浮层展示用的运行状态（由 AppDelegate 持有）
struct VisualContextStatus: Equatable {
    var enabled: Bool = false
    var lastPushedAt: Date?
    var lastTextChars: Int = 0
    var lastError: String?

    /// 菜单一行摘要：「画面上下文：开 · 最近 15:23:45 · 上次 OCR 128 字」
    func menuTitle(timeZone: TimeZone = .current) -> String {
        VisualContextPlanner.formatStatus(
            enabled: enabled,
            lastPush: lastPushedAt,
            lastTextChars: lastTextChars,
            timeZone: timeZone
        )
    }
}

// MARK: - 决策 / 清洗 / 去重 / 状态文案（纯函数）

enum VisualContextPlanner {
    /// 引擎契约：text 1..2000 字符
    static let maxTextChars = 2_000
    /// 引擎侧画面上下文 TTL（120s；仅用于文档/自检断言，客户端不主动清）
    static let engineTTLMs = 120_000
    /// 默认推送间隔（秒）
    static let defaultIntervalSeconds: TimeInterval = 10
    static let minIntervalSeconds: TimeInterval = 8
    static let maxIntervalSeconds: TimeInterval = 15
    static let source = "macos"

    enum Decision: Equatable {
        case push
        case skip(reason: String)
    }

    /// 是否应该发起本轮画面上下文推送。
    /// - 默认关闭；未连接 / 未直播 / 暂停 / 尚无会话 id 都跳过（不排队，避免过期内容）。
    static func decide(
        enabled: Bool,
        isRunning: Bool,
        isPaused: Bool,
        connection: EngineConnectionState,
        hasSession: Bool
    ) -> Decision {
        guard enabled else { return .skip(reason: "disabled") }
        guard isRunning, hasSession else { return .skip(reason: "notRunning") }
        guard !isPaused else { return .skip(reason: "paused") }
        guard connection == .connected else { return .skip(reason: "disconnected") }
        return .push
    }

    /// OCR 原文 -> 可推送文本：清洗（去空行/去重/去控制字符）+ 截断 2000 字。
    /// 与引擎 sanitizeVisualContext 对齐：纯空白/纯标点（不含任何字母/数字）返回 nil，不浪费 WS。
    static func cleanText(_ raw: String, maxChars: Int = maxTextChars) -> String? {
        guard let cleaned = VisionText.cleanOCR(raw, maxChars: maxChars) else { return nil }
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // 至少包含一个字母/数字（CJK 汉字属字母类；纯符号/emoji 引擎也会忽略）
        guard trimmed.rangeOfCharacter(from: .alphanumerics) != nil else { return nil }
        return String(trimmed.prefix(maxChars))
    }

    /// 去重归一化：折叠所有空白 + 小写（OCR 抖动只会带来空格/大小写差异）
    static func normalizeForDedup(_ text: String) -> String {
        var out = ""
        var lastWasSpace = false
        for scalar in text.lowercased().unicodeScalars {
            if scalar.properties.isWhitespace {
                if !lastWasSpace, !out.isEmpty {
                    out.append(" ")
                    lastWasSpace = true
                }
            } else {
                out.unicodeScalars.append(scalar)
                lastWasSpace = false
            }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 同一帧 OCR 文本与上次相同（归一化后）则跳过
    static func isDuplicate(_ text: String, lastText: String?) -> Bool {
        guard let lastText, !lastText.isEmpty else { return false }
        return normalizeForDedup(text) == normalizeForDedup(lastText)
    }

    /// 构造事件：清洗/截断；空文本返回 nil；tMs 非法归零
    static func makeEvent(text: String, tMs: Double, capturedAt: Date) -> VisualContextEvent? {
        guard let cleaned = cleanText(text) else { return nil }
        let safeTMs = (tMs.isFinite && tMs > 0) ? tMs : 0
        return VisualContextEvent(
            text: cleaned,
            tMs: safeTMs,
            capturedAtMs: capturedAt.timeIntervalSince1970 * 1000
        )
    }

    /// 推送间隔钳制到 8...15s（默认 10s）
    static func clampInterval(_ raw: Double?) -> TimeInterval {
        guard let raw, raw.isFinite else { return defaultIntervalSeconds }
        return min(maxIntervalSeconds, max(minIntervalSeconds, raw))
    }

    /// 菜单/浮层状态文案
    static func formatStatus(
        enabled: Bool,
        lastPush: Date?,
        lastTextChars: Int,
        timeZone: TimeZone = .current
    ) -> String {
        guard enabled else { return "画面上下文：关" }
        var parts = ["画面上下文：开"]
        if let lastPush {
            parts.append("最近 \(formatClock(lastPush, timeZone: timeZone))")
        }
        if lastTextChars > 0 {
            parts.append("上次 OCR \(lastTextChars) 字")
        } else if lastPush == nil {
            parts.append("等待首帧")
        }
        return parts.joined(separator: " · ")
    }

    static func formatClock(_ date: Date, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    /// 跳过原因 -> 中文日志
    static func skipReasonText(_ reason: String) -> String {
        switch reason {
        case "disabled": return "开关已关闭"
        case "notRunning": return "同传未开始/无会话"
        case "paused": return "同传已暂停"
        case "disconnected": return "引擎未连接"
        default: return reason
        }
    }
}
