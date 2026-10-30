//
//  Vision.swift
//  livedub macOS 菜单栏 App
//
//  v0.5「画面文字（OCR）/ 画面理解（VLM）」纯逻辑层：
//   - 引擎视觉端点（T4 engine/server.mjs，见 task-21）：
//       GET  /api/vision/health   -> {ok, ready, ocr:{available?,provider?,...}, vision:{...}}
//       POST /api/vision/ocr      body JSON {imageUrl:"/api/notes/assets/<file>.png"}
//                                 -> {ok, text, lines, provider, ms}（≤4MB；也支持 raw PNG）
//       POST /api/vision/analyze?mode=ocr|vision|both  body 同上
//                                 -> {ok, mode, ocr?, caption?, provider, ms}（vision 慢 20-30s）
//     引擎没有 /api/vision/*（v0.4 旧版）时返回 404；视觉服务未就绪时返回 503
//     `{ok:false,error:"vision_unavailable"}` —— 这里统一做「静默降级 / 跳过」决策。
//   - 网络调用在 NotesClient.swift 的 extension 里；本文件全是纯函数，--self-test 不联网覆盖。
//

import Foundation

// MARK: - 请求 / 响应模型

struct VisionOCRRequest: Codable, Equatable {
    var imageUrl: String
}

struct VisionAnalyzeRequest: Codable, Equatable {
    var imageUrl: String
}

/// /api/vision/ocr 的 lines 可能是 [String]（旧 mock/契约早期）或
/// [{text,confidence,x,y,w,h}]（真实 macOS Vision helper 输出）；两种都兼容。
struct VisionOCRLine: Decodable, Equatable {
    var text: String?
}

struct VisionOCRResponse: Codable, Equatable {
    var ok: Bool?
    var text: String?
    var lines: [String]?
    var provider: String?
    var ms: Double?

    private enum CodingKeys: String, CodingKey {
        case ok, text, lines, provider, ms
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try? container.decodeIfPresent(Bool.self, forKey: .ok)
        text = try? container.decodeIfPresent(String.self, forKey: .text)
        provider = try? container.decodeIfPresent(String.self, forKey: .provider)
        ms = try? container.decodeIfPresent(Double.self, forKey: .ms)
        if let strings = try? container.decodeIfPresent([String].self, forKey: .lines) {
            lines = strings
        } else if let objects = try? container.decodeIfPresent([VisionOCRLine].self, forKey: .lines) {
            lines = objects.compactMap { $0.text }
        } else {
            lines = nil
        }
        // helper 只给 text 时按行拆分，保证 NoteComposer 有逐行输入
        if lines == nil, let text, !text.isEmpty {
            lines = text.components(separatedBy: .newlines)
        }
    }
}

/// /api/vision/analyze 的 ocr/caption 字段可能是 string，也可能是 {text, provider, ...} 对象。
/// 用自定义解码兼容两种形态；不认识的形态返回 nil（降级而不是丢笔记）。
struct VisionAnalyzeResponse: Decodable, Equatable {
    var ok: Bool?
    var mode: String?
    var ocrText: String?
    var caption: String?
    var provider: String?
    var ms: Double?

    private enum CodingKeys: String, CodingKey {
        case ok, mode, ocr, caption, provider, ms
    }

    init(ok: Bool? = nil, mode: String? = nil, ocrText: String? = nil, caption: String? = nil,
         provider: String? = nil, ms: Double? = nil) {
        self.ok = ok
        self.mode = mode
        self.ocrText = ocrText
        self.caption = caption
        self.provider = provider
        self.ms = ms
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try? container.decodeIfPresent(Bool.self, forKey: .ok)
        mode = try? container.decodeIfPresent(String.self, forKey: .mode)
        provider = try? container.decodeIfPresent(String.self, forKey: .provider)
        ms = try? container.decodeIfPresent(Double.self, forKey: .ms)
        ocrText = VisionJSON.flexibleText(container, key: .ocr)
        caption = VisionJSON.flexibleText(container, key: .caption)
    }
}

/// 视觉响应里 ocr/caption 的「对象形态」
private struct VisionTextObject: Decodable {
    let text: String?
    let caption: String?
    let content: String?
    let provider: String?
}

enum VisionJSON {
    /// 从 string 或 {text|caption|content} 对象里取文本
    static func flexibleText<K: CodingKey>(_ container: KeyedDecodingContainer<K>, key: K) -> String? {
        if let text = try? container.decodeIfPresent(String.self, forKey: key) {
            return text
        }
        if let object = try? container.decodeIfPresent(VisionTextObject.self, forKey: key) {
            return object.text ?? object.caption ?? object.content
        }
        return nil
    }
}

/// 单次 OCR 结果
struct VisionOCRResult: Equatable {
    var text: String
    var lines: [String]
    var provider: String
    var ms: Double?
}

/// 单次 analyze 结果（OCR + 可选画面理解）
struct VisionAnalyzeResult: Equatable {
    var ocrText: String?
    var caption: String?
    var provider: String?
    var ms: Double?
}

// MARK: - 视觉能力（health）

struct VisionCapability: Equatable {
    var available: Bool
    var detail: String

    static let unavailable = VisionCapability(available: false, detail: "")

    /// 展示文案：可用时优先显示 provider，否则「不可用」
    var label: String {
        guard available else { return detail.isEmpty ? "不可用" : "不可用（\(detail)）" }
        return detail.isEmpty ? "可用" : detail
    }
}

struct VisionStatus: Equatable {
    var ok: Bool
    var ready: Bool
    var ocr: VisionCapability
    var vision: VisionCapability
    var endpointMissing: Bool
    var error: String?
    var fetchedAt: Date?

    static func missing(fetchedAt: Date? = nil) -> VisionStatus {
        VisionStatus(
            ok: false, ready: false,
            ocr: .unavailable, vision: .unavailable,
            endpointMissing: true, error: nil, fetchedAt: fetchedAt
        )
    }

    static func unavailable(error: String?, fetchedAt: Date? = nil) -> VisionStatus {
        VisionStatus(
            ok: false, ready: false,
            ocr: .unavailable, vision: .unavailable,
            endpointMissing: false, error: error, fetchedAt: fetchedAt
        )
    }

    var isUsable: Bool { ok && (ocr.available || vision.available) }

    /// 菜单/诊断一行摘要
    var summaryText: String {
        if endpointMissing { return "视觉：不可用（引擎 < v0.5，无 /api/vision/*）" }
        if let error, !ok { return "视觉：检测失败（\(error)）" }
        return "视觉：OCR \(ocr.label) · VLM \(vision.label)"
    }
}

enum VisionHealthParser {
    /// GET /api/vision/health 响应 → VisionStatus；无法解析返回 nil
    static func parse(data: Data) -> VisionStatus? {
        guard let raw = try? JSONSerialization.jsonObject(with: data),
              let dictionary = raw as? [String: Any] else {
            return nil
        }
        return parse(dictionary: dictionary)
    }

    static func parse(dictionary: [String: Any], fetchedAt: Date? = Date()) -> VisionStatus {
        let ok = boolValue(dictionary["ok"]) ?? boolValue(dictionary["ready"]) ?? false
        let ready = boolValue(dictionary["ready"]) ?? ok
        let ocr = capability(from: dictionary["ocr"])
        let vision = capability(from: dictionary["vision"])
        return VisionStatus(
            ok: ok, ready: ready, ocr: ocr, vision: vision,
            endpointMissing: false, error: nil, fetchedAt: fetchedAt
        )
    }

    /// ocr/vision 字段可能是 bool、字符串（provider 名）或对象
    static func capability(from value: Any?) -> VisionCapability {
        if value == nil || value is NSNull { return .unavailable }
        if let flag = boolValue(value) { return VisionCapability(available: flag, detail: "") }
        if let text = value as? String {
            let detail = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return VisionCapability(available: !detail.isEmpty, detail: detail)
        }
        guard let dictionary = value as? [String: Any] else { return .unavailable }
        var available = boolValue(dictionary["available"]) ?? boolValue(dictionary["ready"])
        if available == nil { available = boolValue(dictionary["enabled"]) }
        if available == nil { available = boolValue(dictionary["configured"]) }
        if available == nil { available = boolValue(dictionary["ok"]) }
        let detailKeys = ["provider", "name", "engine", "model", "reason", "error", "message"]
        var detail = ""
        for key in detailKeys {
            if let text = dictionary[key] as? String, !text.isEmpty {
                detail = text
                break
            }
        }
        if available == nil {
            // 有 provider 等细节但没有明确布尔值：认为可用
            available = !detail.isEmpty
        }
        return VisionCapability(available: available ?? false, detail: detail)
    }

    static func boolValue(_ value: Any?) -> Bool? {
        switch value {
        case let flag as Bool: return flag
        case let number as NSNumber: return number.boolValue
        case let text as String:
            if text == "true" || text == "1" { return true }
            if text == "false" || text == "0" { return false }
            return nil
        default: return nil
        }
    }
}

// MARK: - 降级决策（纯函数）

enum VisionPlanner {
    /// OCR 请求超时（快）
    static let ocrTimeout: TimeInterval = 25
    /// analyze（VLM）请求超时：服务端慢操作 20-30s，留出余量；超时降级为仅 OCR
    static let analyzeTimeout: TimeInterval = 45
    /// OCR 文本上限（与扩展端一致）
    static let ocrMaxChars = 2_000
    /// 画面理解 caption 上限
    static let captionMaxChars = 1_000
    /// 视觉端点单次图片上限（与服务端一致）
    static let maxImageBytes = 4 * 1024 * 1024

    enum Decision: Equatable {
        case run
        case skip(reason: String)
    }

    /// 是否调用 /api/vision/ocr
    static func ocrDecision(
        enabled: Bool,
        hasImageAsset: Bool,
        endpointMissing: Bool,
        health: VisionStatus?
    ) -> Decision {
        guard enabled else { return .skip(reason: "disabled") }
        guard hasImageAsset else { return .skip(reason: "noImage") }
        guard !endpointMissing else { return .skip(reason: "endpointMissing") }
        if let health, health.ok || health.ready, !health.ocr.available {
            return .skip(reason: "ocrUnavailable")
        }
        return .run
    }

    /// 是否调用 /api/vision/analyze（VLM，慢）
    static func visionDecision(
        enabled: Bool,
        hasImageAsset: Bool,
        endpointMissing: Bool,
        health: VisionStatus?
    ) -> Decision {
        guard enabled else { return .skip(reason: "disabled") }
        guard hasImageAsset else { return .skip(reason: "noImage") }
        guard !endpointMissing else { return .skip(reason: "endpointMissing") }
        if let health, (health.ok || health.ready), !health.vision.available {
            return .skip(reason: "visionUnavailable")
        }
        return .run
    }

    /// 哪些 HTTP 状态表示「引擎没有 /api/vision/*」（旧引擎）→ 之后整个进程内跳过视觉调用
    static func endpointMissing(forHTTPStatus status: Int) -> Bool {
        status == 404 || status == 405 || status == 501
    }

    /// 视觉服务未安装/未配置（T4 在 vision 模块缺失时返回 503 vision_unavailable）
    static func serviceUnavailable(forHTTPStatus status: Int, message: String) -> Bool {
        status == 503 || message.contains("vision_unavailable")
    }

    /// 已知 NotesClientError → 是否应标记视觉端点缺失
    static func shouldMarkEndpointMissing(_ error: Error) -> Bool {
        guard case let NotesClientError.http(status, message) = error else { return false }
        return endpointMissing(forHTTPStatus: status) || serviceUnavailable(forHTTPStatus: status, message: message)
    }

    /// 降级原因 → 中文日志文案
    static func skipReasonText(_ reason: String) -> String {
        switch reason {
        case "disabled": return "已关闭"
        case "noImage": return "没有截图附件"
        case "endpointMissing": return "引擎无视觉端点（需 v0.5）"
        case "ocrUnavailable": return "引擎未配置 OCR"
        case "visionUnavailable": return "引擎未配置 VLM"
        default: return reason
        }
    }
}

// MARK: - 文本清洗 / Markdown 片段（纯函数）

enum VisionText {
    static let ocrMaxChars = VisionPlanner.ocrMaxChars
    static let captionMaxChars = VisionPlanner.captionMaxChars
    static let maxOCRLines = 80

    /// OCR 原文清洗：
    /// - 按行 trim、丢弃空行、去掉控制字符、折叠行内连续空白
    /// - 相邻重复行去重（OCR 常把同一行识别两遍）
    /// - 最多 80 行 / 2000 字符（超出加 "…"）
    /// - 清洗后为空返回 nil（调用方就不加「画面文字」段）
    static func cleanOCR(_ raw: String, maxChars: Int = ocrMaxChars, maxLines: Int = maxOCRLines) -> String? {
        var kept: [String] = []
        var lastKept = ""
        for line in raw.components(separatedBy: CharacterSet.newlines) {
            let cleaned = cleanLine(line)
            guard !cleaned.isEmpty else { continue }
            if cleaned == lastKept { continue }
            kept.append(cleaned)
            lastKept = cleaned
            if kept.count >= maxLines { break }
        }
        guard !kept.isEmpty else { return nil }
        var text = kept.joined(separator: "\n")
        if text.count > maxChars {
            text = truncate(text, maxChars: maxChars)
        }
        return text
    }

    /// 画面理解 caption 清洗：trim、折叠多余空行/空白、截断
    static func cleanCaption(_ raw: String, maxChars: Int = captionMaxChars) -> String? {
        var text = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var lines: [String] = []
        for line in text.components(separatedBy: "\n") {
            let cleaned = cleanLine(line)
            lines.append(cleaned)
        }
        // 去掉首尾空行 + 连续空行折叠成一个
        while let first = lines.first, first.isEmpty { lines.removeFirst() }
        while let last = lines.last, last.isEmpty { lines.removeLast() }
        var collapsed: [String] = []
        var previousEmpty = false
        for line in lines {
            if line.isEmpty {
                if previousEmpty { continue }
                previousEmpty = true
            } else {
                previousEmpty = false
            }
            collapsed.append(line)
        }
        text = collapsed.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.count > maxChars { text = truncate(text, maxChars: maxChars) }
        return text
    }

    /// Markdown 代码块；按内容里最长连续反引号决定 fence 长度，避免 OCR 文字打断代码块
    static func codeBlock(_ text: String) -> String {
        let fence = String(repeating: "`", count: max(3, longestBacktickRun(text) + 1))
        return "\(fence)\n\(text)\n\(fence)"
    }

    /// `**画面文字**（OCR）：` + 代码块；无文字返回 nil
    static func ocrSection(_ raw: String, maxChars: Int = ocrMaxChars) -> String? {
        guard let cleaned = cleanOCR(raw, maxChars: maxChars) else { return nil }
        return "**画面文字**（OCR）：\n\n" + codeBlock(cleaned)
    }

    /// `**画面理解**：` + caption；空返回 nil
    static func captionSection(_ raw: String, maxChars: Int = captionMaxChars) -> String? {
        guard let cleaned = cleanCaption(raw, maxChars: maxChars) else { return nil }
        return "**画面理解**：\n\n" + cleaned
    }

    /// 内容里最长连续反引号 run 长度（用于选 fence）
    static func longestBacktickRun(_ text: String) -> Int {
        var longest = 0
        var current = 0
        for character in text {
            if character == "`" {
                current += 1
                longest = max(longest, current)
            } else {
                current = 0
            }
        }
        return longest
    }

    // MARK: 内部

    private static func cleanLine(_ raw: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in raw.unicodeScalars {
            switch scalar.value {
            case 0x09:
                scalars.append(" ")
            case 0x00...0x1F, 0x7F:
                continue
            default:
                scalars.append(scalar)
            }
        }
        var text = String(scalars)
        while text.contains("  ") { text = text.replacingOccurrences(of: "  ", with: " ") }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func truncate(_ text: String, maxChars: Int) -> String {
        guard maxChars > 1, text.count > maxChars else { return text }
        return String(text.prefix(maxChars - 1)) + "…"
    }
}
