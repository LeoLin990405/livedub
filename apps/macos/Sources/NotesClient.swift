//
//  NotesClient.swift
//  livedub macOS 菜单栏 App
//
//  v0.4「边看边实现」快捷笔记：
//   - 把当前双语字幕 + 会话时间戳 + 状态 (+ 可选截图) 通过本地引擎 Notes API 记录：
//       POST /api/notes/quick  JSON -> {ok, path, markdown}
//       POST /api/notes/assets raw PNG -> {ok, url}
//   - 引擎未启动 / 请求失败 -> 写入 UserDefaults 离线队列（最多 50 条），
//     引擎重连或每分钟自动 flush（业务侧调用 flushOfflineQueue）。
//   - 本文件同时放「纯函数」：视频标题/ID 推导、时间格式、quick note 文本/JSON 构造、
//     离线队列（存储后端可注入，便于 --self-test 在内存里测试，不写用户偏好）。
//
//  契约（与 T4 engine/server.mjs Notes API 对齐，见 task-17）：
//    POST /api/notes/quick  body {video:{id,title,url?}, tMs, text, quotes?, source, tags?}
//                           -> {ok, path, markdown}
//    POST /api/notes/assets raw PNG (content-type: image/png, <=4MB) -> {ok, url}
//    Note.source 联合类型含 'macos'；quotes 元素 {t0Ms?,t1Ms?,src?,dst?}
//
//  截图附加：text 里用绝对 URL 写 Markdown 图片；quick 的 imageUrl 扩展字段按服务端契约
//  传**相对路径** /api/notes/assets/<file>.png（T4 会校验，绝对 URL 会 400）。
//  若服务端仍因 imageUrl 返回 400（例如旧版引擎白名单），自动去掉 imageUrl 重试，
//  截图链接仍在 text 的 Markdown 里，不会丢笔记。
//

import Foundation

// MARK: - Notes API 模型

struct NoteVideoRef: Codable, Equatable {
    var id: String
    var title: String
    var url: String?
}

struct NoteQuote: Codable, Equatable {
    var t0Ms: Double?
    var t1Ms: Double?
    var src: String?
    var dst: String?
}

/// POST /api/notes/quick 请求体
struct QuickNoteRequest: Codable, Equatable {
    var video: NoteVideoRef
    var tMs: Double
    var text: String
    var quotes: [NoteQuote]?
    var source: String
    var tags: [String]?
    /// 扩展字段（可选）：服务端若支持会存 Note.imageUrl；不支持时客户端自动降级重试
    var imageUrl: String?
}

/// POST /api/notes/quick 响应
struct QuickNoteResult: Codable, Equatable {
    var ok: Bool?
    var path: String?
    var markdown: String?
}

/// POST /api/notes/assets 响应
struct NoteAssetResult: Codable, Equatable {
    var ok: Bool?
    var url: String?
}

/// 截图上传结果：Markdown 用绝对 URL，Note.imageUrl 用服务端契约要求的相对路径
struct NoteAssetRef: Equatable {
    var absoluteURL: String
    var relativePath: String
}

/// 一条待同步的离线笔记（queue 里存 request + 入队时间，便于排序/排障）
struct QueuedQuickNote: Codable, Equatable {
    var request: QuickNoteRequest
    var queuedAt: Double
}

enum QuickNoteDelivery: Equatable {
    /// 已直接写入引擎笔记库（path 为服务端返回的文件路径）
    case sent(QuickNoteResult)
    /// 引擎不可用 / 请求失败，已进入离线队列（Int = 当前队列条数）
    case queued(Int)
    /// 队列也不可用（理论上不应发生）
    case failed(String)
}

enum NotesFlushOutcome: Equatable {
    case idle
    case done(sent: Int, remaining: Int)
}

// MARK: - HTTP 基址/URL（纯函数，self-test 覆盖）

enum NotesHTTP {
    static let defaultBaseURLString = "http://127.0.0.1:8787"

    /// 把 WebSocket 引擎地址转成 Notes API 的 HTTP 基址：
    ///   ws://127.0.0.1:8787/ws        -> http://127.0.0.1:8787
    ///   wss://host/ws                 -> https://host
    ///   http(s)://host:port/anything  -> http(s)://host:port
    /// 非法输入 -> 默认 http://127.0.0.1:8787
    static func baseURLString(fromEngineURL raw: String) -> String {
        let normalized = Settings.normalizeEngineURL(raw)
        guard var components = URLComponents(string: normalized) else {
            return defaultBaseURLString
        }
        let scheme: String
        switch components.scheme {
        case "wss", "https": scheme = "https"
        case "ws", "http": scheme = "http"
        default: return defaultBaseURLString
        }
        guard let host = components.host, !host.isEmpty else { return defaultBaseURLString }
        var base = URLComponents()
        base.scheme = scheme
        base.host = host
        base.port = components.port
        components = base
        guard let value = components.string else { return defaultBaseURLString }
        return value
    }

    static func baseURL(fromEngineURL raw: String) -> URL? {
        URL(string: baseURLString(fromEngineURL: raw))
    }

    static func quickURL(base: URL) -> URL {
        base.appendingPathComponent("api").appendingPathComponent("notes").appendingPathComponent("quick")
    }

    static func assetsURL(base: URL) -> URL {
        base.appendingPathComponent("api").appendingPathComponent("notes").appendingPathComponent("assets")
    }

    /// 工作台 URL：notes=true 时打开学习笔记面板（?notes=1）
    static func studioURL(fromEngineURL raw: String, notes: Bool) -> URL? {
        let base = baseURLString(fromEngineURL: raw)
        guard var components = URLComponents(string: base) else { return nil }
        components.path = "/studio/"
        components.query = notes ? "notes=1" : nil
        return components.url
    }

    /// 服务端 assets 返回的可能是相对路径（/api/notes/assets/x.png），转成绝对 URL 便于 Markdown 渲染
    static func absoluteAssetURLString(base: String, assetPath: String) -> String {
        let trimmed = assetPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return base }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") { return trimmed }
        let baseTrimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        return trimmed.hasPrefix("/") ? baseTrimmed + trimmed : baseTrimmed + "/" + trimmed
    }
}

// MARK: - 笔记上下文 / 纯函数构造（self-test 覆盖）

/// 按下 ⌥N 那一刻的 App 状态快照（主线程收集，纯数据交给 NoteComposer）
struct NoteContext {
    var sessionId: String?
    var sessionTitle: String
    var tMs: Double
    var statusText: String
    var translation: String
    var source: String
    var latencyMs: Double?
    var frontmostApp: String?
    var frontmostBundleId: String?
    var capturedAt: Date
    var timeZone: TimeZone = .current
}

enum NoteComposer {
    static let source = "macos"
    static let emptyCaption = "（无字幕）"
    static let maxTextChars = 4_000
    static let maxTitleChars = 200
    static let maxIdChars = 200
    static let maxQuoteChars = 2_000

    /// 前台 App 命中这些关键词时，大概率它就是声音来源（会议 / 播放器 / 浏览器视频）
    static let mediaAppHints: [String] = [
        "zoom", "tencent", "腾讯会议", "meeting", "webex", "teams", "quicktime",
        "iina", "vlc", "movist", "potplayer", "obs", "spotify", "music",
        "chrome", "safari", "firefox", "edge", "bilibili", "哔哩哔哩", "youtube",
    ]

    // MARK: 视频身份

    /// 视频标题推导：
    /// 1) 前台是媒体类 App -> "<App> · 系统音频同传"（它就是声音来源的概率最高）
    /// 2) 有会话标题 -> 用会话标题
    /// 3) 否则 -> "macOS 系统音频同传 · yyyy-MM-dd"
    static func deriveVideoTitle(
        sessionTitle: String,
        frontmostApp: String?,
        date: Date,
        timeZone: TimeZone = .current
    ) -> String {
        let cleanedSessionTitle = normalizeInline(sessionTitle, maxLength: maxTitleChars)
        if let app = normalizeInline(frontmostApp ?? "", maxLength: 60).nilIfEmpty, isMediaApp(app) {
            return normalizeInline("\(app) · 系统音频同传", maxLength: maxTitleChars)
        }
        if !cleanedSessionTitle.isEmpty { return cleanedSessionTitle }
        return "macOS 系统音频同传 · \(formatDateStamp(date, timeZone: timeZone))"
    }

    /// 视频 ID（稳定分组用，只含 [a-z0-9-]，<=200）：
    /// - 媒体类前台 App -> "macos-<app-slug>"（同一个会议/播放器当天笔记聚合）
    /// - 有引擎会话 id -> "macos-<session-id-slug>"
    /// - 否则 "macos-live"
    static func deriveVideoID(
        sessionId: String?,
        frontmostApp: String?,
        frontmostBundleId: String? = nil
    ) -> String {
        if let app = normalizeInline(frontmostApp ?? "", maxLength: 60).nilIfEmpty, isMediaApp(app) {
            return normalizeInline("macos-" + slug(app), maxLength: maxIdChars)
        }
        if let bundle = normalizeInline(frontmostBundleId ?? "", maxLength: 80).nilIfEmpty, isMediaApp(bundle) {
            return normalizeInline("macos-" + slug(bundle), maxLength: maxIdChars)
        }
        if let session = normalizeInline(sessionId ?? "", maxLength: 100).nilIfEmpty {
            return normalizeInline("macos-" + slug(session), maxLength: maxIdChars)
        }
        return "macos-live"
    }

    static func isMediaApp(_ name: String) -> Bool {
        let lower = name.lowercased()
        return mediaAppHints.contains { lower.contains($0) }
    }

    /// 只保留 [a-z0-9-]（连续分隔符合并成一个 "-"，去首尾 "-"）
    static func slug(_ raw: String) -> String {
        var out = ""
        var lastWasDash = false
        for scalar in raw.lowercased().unicodeScalars {
            let isAlnum = (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
            if isAlnum {
                out.unicodeScalars.append(scalar)
                lastWasDash = false
            } else if !lastWasDash && !out.isEmpty {
                out.append("-")
                lastWasDash = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out.isEmpty ? "live" : out
    }

    // MARK: 截图资源路径（服务端契约：imageUrl 必须是 /api/notes/assets/<file>.png）

    /// 把 assets 返回的 URL / 相对路径统一成服务端要求的相对路径；不合法返回 nil
    static func relativeAssetPath(from raw: String) -> String? {
        let trimmed = normalizeInline(raw, maxLength: 1_000)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("/api/notes/assets/") { return trimmed }
        if let url = URL(string: trimmed), url.path.hasPrefix("/api/notes/assets/") {
            return url.path
        }
        return nil
    }

    /// 严格校验相对路径：/api/notes/assets/<file>.png，文件名仅 [A-Za-z0-9._-]
    static func isValidAssetPath(_ path: String) -> Bool {
        let prefix = "/api/notes/assets/"
        guard path.hasPrefix(prefix) else { return false }
        let file = String(path.dropFirst(prefix.count))
        guard !file.isEmpty, file.hasSuffix(".png"), !file.contains("/"), !file.contains("..") else {
            return false
        }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        return file.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    // MARK: 时间格式

    /// 会话时间轴毫秒 -> "MM:SS.d"（>=1 小时用 "H:MM:SS.d"）。
    /// 例：0 -> "00:00.0"；83400 -> "01:23.4"；3723456 -> "1:02:03.4"
    static func formatSessionTime(_ ms: Double) -> String {
        let safe = (ms.isFinite && ms > 0) ? ms : 0
        let totalTenths = Int((safe / 100).rounded(.down))
        let tenths = totalTenths % 10
        let totalSeconds = totalTenths / 10
        let seconds = totalSeconds % 60
        let totalMinutes = totalSeconds / 60
        let minutes = totalMinutes % 60
        let hours = totalMinutes / 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d.%d", hours, minutes, seconds, tenths)
        }
        return String(format: "%02d:%02d.%d", minutes, seconds, tenths)
    }

    /// 墙钟时间 "HH:MM:SS"（toast「已记录笔记 · HH:MM:SS」）
    static func formatClock(_ date: Date, timeZone: TimeZone = .current) -> String {
        formatter("HH:mm:ss", timeZone: timeZone).string(from: date)
    }

    /// 日期 "yyyy-MM-dd"
    static func formatDateStamp(_ date: Date, timeZone: TimeZone = .current) -> String {
        formatter("yyyy-MM-dd", timeZone: timeZone).string(from: date)
    }

    private static func formatter(_ format: String, timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        return formatter
    }

    // MARK: 文本 / JSON 构造

    /// 生成 quick note 的 text（Markdown 片段）。
    /// 有字幕：原文/译文双语引用；无字幕："（无字幕）"；总是带视频标题/时间戳/状态/来源/前台 App。
    static func quickText(context: NoteContext, videoTitle: String, imageURL: String?) -> String {
        var lines: [String] = []
        let src = normalizeInline(context.source, maxLength: maxQuoteChars)
        let dst = normalizeInline(context.translation, maxLength: maxQuoteChars)
        let title = normalizeInline(videoTitle, maxLength: maxTitleChars)
        if !title.isEmpty {
            lines.append("**视频**：\(title)")
        }
        if !src.isEmpty { lines.append("**原文**：\(src)") }
        if !dst.isEmpty { lines.append("**译文**：\(dst)") }
        if src.isEmpty && dst.isEmpty { lines.append(emptyCaption) }

        var meta: [String] = ["时间 \(formatSessionTime(context.tMs))"]
        let status = normalizeInline(context.statusText, maxLength: 60)
        if !status.isEmpty { meta.append("状态 \(status)") }
        if let latency = context.latencyMs {
            meta.append("延迟 \(CaptionLayout.formatLatency(latency))")
        }
        if let app = normalizeInline(context.frontmostApp ?? "", maxLength: 60).nilIfEmpty {
            meta.append("前台 \(app)")
        }
        lines.append("**记录**：" + meta.joined(separator: " · "))
        lines.append(
            "**来源**：macOS 系统音频（livedub app）· "
                + formatDateStamp(context.capturedAt, timeZone: context.timeZone) + " "
                + formatClock(context.capturedAt, timeZone: context.timeZone)
        )
        if let imageURL = normalizeInline(imageURL ?? "", maxLength: 500).nilIfEmpty {
            lines.append("")
            lines.append("![截图](\(imageURL))")
        }
        let text = lines.joined(separator: "\n")
        return String(text.prefix(maxTextChars))
    }

    /// 构造 POST /api/notes/quick 请求体。
    /// - image: 截图上传结果；text 用绝对 URL 渲染 Markdown，imageUrl 字段用相对路径（服务端契约）
    static func makeQuickRequest(
        context: NoteContext,
        image: NoteAssetRef? = nil,
        tags: [String]? = nil
    ) -> QuickNoteRequest {
        let title = deriveVideoTitle(
            sessionTitle: context.sessionTitle,
            frontmostApp: context.frontmostApp,
            date: context.capturedAt,
            timeZone: context.timeZone
        )
        let videoID = deriveVideoID(
            sessionId: context.sessionId,
            frontmostApp: context.frontmostApp,
            frontmostBundleId: context.frontmostBundleId
        )
        let safeTMs = (context.tMs.isFinite && context.tMs > 0) ? context.tMs : 0
        let src = normalizeInline(context.source, maxLength: maxQuoteChars)
        let dst = normalizeInline(context.translation, maxLength: maxQuoteChars)
        var quotes: [NoteQuote]?
        if !src.isEmpty || !dst.isEmpty {
            quotes = [
                NoteQuote(
                    t0Ms: safeTMs,
                    t1Ms: nil,
                    src: src.isEmpty ? nil : src,
                    dst: dst.isEmpty ? nil : dst
                ),
            ]
        }
        let cleanTags = (tags ?? [])
            .map { normalizeInline($0, maxLength: 40) }
            .filter { !$0.isEmpty }
        let imagePath = image.flatMap { isValidAssetPath($0.relativePath) ? $0.relativePath : nil }
        return QuickNoteRequest(
            video: NoteVideoRef(id: videoID, title: title, url: nil),
            tMs: safeTMs,
            text: quickText(context: context, videoTitle: title, imageURL: image?.absoluteURL),
            quotes: quotes,
            source: source,
            tags: cleanTags.isEmpty ? nil : Array(cleanTags.prefix(20)),
            imageUrl: imagePath
        )
    }

    /// 单行文本清洗：trim、折叠换行/多余空白、截断
    static func normalizeInline(_ raw: String?, maxLength: Int) -> String {
        guard let raw else { return "" }
        var text = raw.replacingOccurrences(of: "\r\n", with: " ")
        text = text.replacingOccurrences(of: "\n", with: " ")
        text = text.replacingOccurrences(of: "\t", with: " ")
        while text.contains("  ") { text = text.replacingOccurrences(of: "  ", with: " ") }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count > maxLength { text = String(text.prefix(maxLength)) }
        return text
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - 离线队列（存储后端可注入）

protocol NotesQueueStore: AnyObject {
    func loadNotesQueueData(_ key: String) -> Data?
    func saveNotesQueueData(_ key: String, data: Data?)
}

final class UserDefaultsNotesStore: NotesQueueStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func loadNotesQueueData(_ key: String) -> Data? {
        defaults.data(forKey: key)
    }

    func saveNotesQueueData(_ key: String, data: Data?) {
        if let data {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

/// 内存存储：供 --self-test 使用，不触碰用户偏好文件
final class InMemoryNotesStore: NotesQueueStore {
    private(set) var storage: [String: Data] = [:]

    func loadNotesQueueData(_ key: String) -> Data? { storage[key] }

    func saveNotesQueueData(_ key: String, data: Data?) {
        storage[key] = data
    }
}

final class NotesOfflineQueue {
    static let maxItems = 50
    static let storageKey = "livedub.macos.notes.offlineQueue"

    private let store: NotesQueueStore
    private let key: String
    private(set) var items: [QueuedQuickNote] = []

    init(store: NotesQueueStore, key: String = NotesOfflineQueue.storageKey) {
        self.store = store
        self.key = key
        load()
    }

    var count: Int { items.count }

    /// 从存储加载；损坏数据直接丢弃（并把存储清干净，避免每次启动都报错）
    @discardableResult
    func load() -> Int {
        guard let data = store.loadNotesQueueData(key) else {
            items = []
            return 0
        }
        do {
            var decoded = try JSONDecoder().decode([QueuedQuickNote].self, from: data)
            if decoded.count > Self.maxItems {
                decoded = Array(decoded.suffix(Self.maxItems))
                persist()
            }
            items = decoded
        } catch {
            items = []
            persist()
        }
        return items.count
    }

    /// 入队（末尾追加）；超过上限丢最旧的。返回当前条数。
    @discardableResult
    func enqueue(_ request: QuickNoteRequest, queuedAt: Date = Date()) -> Int {
        items.append(QueuedQuickNote(request: request, queuedAt: queuedAt.timeIntervalSince1970))
        if items.count > Self.maxItems {
            items.removeFirst(items.count - Self.maxItems)
        }
        persist()
        return items.count
    }

    /// 插回队首（flush 失败时把已弹出的一条放回去，保持顺序）
    func enqueueFront(_ request: QuickNoteRequest, queuedAt: Double) {
        items.insert(QueuedQuickNote(request: request, queuedAt: queuedAt), at: 0)
        if items.count > Self.maxItems {
            items.removeLast(items.count - Self.maxItems)
        }
        persist()
    }

    func peekFirst() -> QueuedQuickNote? { items.first }

    @discardableResult
    func removeFirst() -> QueuedQuickNote? {
        guard !items.isEmpty else { return nil }
        let removed = items.removeFirst()
        persist()
        return removed
    }

    func clear() {
        items = []
        persist()
    }

    private func persist() {
        if items.isEmpty {
            store.saveNotesQueueData(key, data: nil)
            return
        }
        if let data = try? JSONEncoder().encode(items) {
            store.saveNotesQueueData(key, data: data)
        }
    }
}

// MARK: - 网络客户端

enum NotesClientError: Error, CustomStringConvertible {
    case notConfigured
    case http(status: Int, message: String)
    case invalidResponse(String)
    case encoding(String)

    var description: String {
        switch self {
        case .notConfigured: return "引擎地址无效，无法连接 Notes API"
        case .http(let status, let message): return "Notes API HTTP \(status)：\(message)"
        case .invalidResponse(let message): return "Notes API 响应异常：\(message)"
        case .encoding(let message): return "笔记编码失败：\(message)"
        }
    }
}

final class NotesClient {
    static let requestTimeout: TimeInterval = 8
    static let maxAssetBytes = 4 * 1024 * 1024

    var onLog: ((String) -> Void)?
    private(set) var lastErrorText: String?

    private let lock = NSLock()
    private let session: URLSession
    private let offlineQueue: NotesOfflineQueue
    private var engineURL: String
    private var flushing = false

    init(engineURL: String, queueStore: NotesQueueStore = UserDefaultsNotesStore()) {
        self.engineURL = engineURL
        self.offlineQueue = NotesOfflineQueue(store: queueStore)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = NotesClient.requestTimeout
        configuration.timeoutIntervalForResource = NotesClient.requestTimeout + 4
        configuration.waitsForConnectivity = false
        self.session = URLSession(configuration: configuration)
    }

    deinit {
        session.invalidateAndCancel()
    }

    // MARK: 配置 / 状态

    var baseURLString: String {
        lock.lock()
        defer { lock.unlock() }
        return NotesHTTP.baseURLString(fromEngineURL: engineURL)
    }

    var baseURL: URL? { URL(string: baseURLString) }

    var studioNotesURL: URL? {
        lock.lock()
        let url = engineURL
        lock.unlock()
        return NotesHTTP.studioURL(fromEngineURL: url, notes: true)
    }

    var workbenchURL: URL? {
        lock.lock()
        let url = engineURL
        lock.unlock()
        return NotesHTTP.studioURL(fromEngineURL: url, notes: false)
    }

    var queueCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return offlineQueue.count
    }

    func updateEngineURL(_ raw: String) {
        lock.lock()
        engineURL = raw
        lock.unlock()
    }

    // MARK: 直接发送

    /// POST /api/notes/quick。
    /// 若服务端因扩展字段 imageUrl 返回 400，去掉该字段重试（截图链接已在 text 的 Markdown 里）。
    func sendQuick(_ request: QuickNoteRequest) async throws -> QuickNoteResult {
        do {
            return try await postQuick(request)
        } catch let NotesClientError.http(status, message) where status == 400 && request.imageUrl != nil {
            onLog?("[notes] quick 不接受 imageUrl（\(String(message.prefix(120)))），去掉扩展字段重试（截图链接仍写在 text）")
            var retry = request
            retry.imageUrl = nil
            return try await postQuick(retry)
        }
    }

    /// POST /api/notes/assets（raw PNG），返回 Markdown 绝对 URL + 服务端契约相对路径。
    func uploadPNG(_ data: Data) async throws -> NoteAssetRef {
        guard data.count <= Self.maxAssetBytes else {
            throw NotesClientError.invalidResponse("PNG 超过 4MB（\(data.count) 字节），请降采样后再传")
        }
        let baseString = baseURLString
        guard let base = URL(string: baseString) else {
            throw NotesClientError.notConfigured
        }
        var request = URLRequest(url: NotesHTTP.assetsURL(base: base), timeoutInterval: Self.requestTimeout)
        request.httpMethod = "POST"
        request.setValue("image/png", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let (body, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw NotesClientError.http(status: status, message: Self.bodySnippet(body))
        }
        let result = try JSONDecoder().decode(NoteAssetResult.self, from: body)
        guard result.ok != false, let assetURL = result.url?.nilIfEmpty else {
            throw NotesClientError.invalidResponse("assets 响应缺少 url")
        }
        let absoluteURL = NotesHTTP.absoluteAssetURLString(base: baseString, assetPath: assetURL)
        let relativePath = NoteComposer.relativeAssetPath(from: assetURL) ?? assetURL
        return NoteAssetRef(absoluteURL: absoluteURL, relativePath: relativePath)
    }

    // MARK: 记录（失败进队列）

    /// 记录一条 quick note：成功直接写引擎；失败写离线队列。永不 throw。
    func record(_ request: QuickNoteRequest) async -> QuickNoteDelivery {
        do {
            let result = try await sendQuick(request)
            return .sent(result)
        } catch {
            lastErrorText = "\(error)"
            let count = enqueueOffline(request)
            onLog?("[notes] 发送失败，已离线排队（\(count) 条）：\(error)")
            return .queued(count)
        }
    }

    /// 把离线队列逐条补发；遇到网络失败立刻停止（保留剩余，等下次重连/定时器）。
    @discardableResult
    func flushOfflineQueue() async -> NotesFlushOutcome {
        guard beginFlush() else { return .idle }
        var sent = 0
        while let next = peekQueued() {
            do {
                _ = try await sendQuick(next.request)
                removeFirstQueued()
                sent += 1
            } catch {
                lastErrorText = "\(error)"
                onLog?("[notes] 队列补发失败（已保留 \(queueCount) 条）：\(error)")
                break
            }
        }
        return .done(sent: sent, remaining: endFlush())
    }

    // MARK: 内部（同步锁包装：避免在 async 上下文里直接 NSLock，Swift 6 更安全）

    private func beginFlush() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !flushing else { return false }
        flushing = true
        return true
    }

    private func endFlush() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let remaining = offlineQueue.count
        flushing = false
        return remaining
    }

    private func peekQueued() -> QueuedQuickNote? {
        lock.lock()
        defer { lock.unlock() }
        return offlineQueue.peekFirst()
    }

    private func removeFirstQueued() {
        lock.lock()
        defer { lock.unlock() }
        offlineQueue.removeFirst()
    }

    private func enqueueOffline(_ request: QuickNoteRequest) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return offlineQueue.enqueue(request)
    }

    private func postQuick(_ request: QuickNoteRequest) async throws -> QuickNoteResult {
        let baseString = baseURLString
        guard let base = URL(string: baseString) else {
            throw NotesClientError.notConfigured
        }
        var urlRequest = URLRequest(url: NotesHTTP.quickURL(base: base), timeoutInterval: Self.requestTimeout)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        do {
            urlRequest.httpBody = try JSONEncoder().encode(request)
        } catch {
            throw NotesClientError.encoding("\(error)")
        }
        let (data, response) = try await session.data(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw NotesClientError.http(status: status, message: Self.bodySnippet(data))
        }
        let result: QuickNoteResult
        do {
            result = try JSONDecoder().decode(QuickNoteResult.self, from: data)
        } catch {
            throw NotesClientError.invalidResponse("无法解析 quick 响应：\(error)")
        }
        if result.ok == false {
            throw NotesClientError.invalidResponse("服务端返回 ok=false")
        }
        return result
    }

    private static func bodySnippet(_ data: Data) -> String {
        let text = String(data: data.prefix(400), encoding: .utf8) ?? "<\(data.count) bytes>"
        return text.replacingOccurrences(of: "\n", with: " ")
    }
}
