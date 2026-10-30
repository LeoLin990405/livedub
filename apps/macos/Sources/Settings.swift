//
//  Settings.swift
//  livedub macOS 菜单栏 App
//
//  用户设置持久化（UserDefaults）。所有字段都有安全的默认值 / 清洗逻辑，
//  偏好损坏或手工改坏时不会让 App 崩溃。normalizeEngineURL 是纯函数，self-test 覆盖。
//

import Foundation

final class Settings {
    static let shared = Settings()

    private let defaults: UserDefaults

    private enum Key {
        static let prefix = "livedub.macos."
        static let engineURL = prefix + "engineURL"
        static let fontSize = prefix + "fontSize"
        static let clickThrough = prefix + "clickThrough"
        static let dubEnabled = prefix + "dubEnabled"
        static let alwaysOnTop = prefix + "alwaysOnTop"
        static let showSourceLine = prefix + "showSourceLine"
        static let overlayOriginX = prefix + "overlayOriginX"
        static let overlayOriginY = prefix + "overlayOriginY"
        static let hasOverlayOrigin = prefix + "hasOverlayOrigin"
        static let langFrom = prefix + "langFrom"
        static let langTo = prefix + "langTo"
        static let autoStart = prefix + "autoStart"
        static let notesIncludeScreenshot = prefix + "notesIncludeScreenshot"
        static let notesWhenPaused = prefix + "notesWhenPaused"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - 引擎

    /// 引擎 WebSocket 地址，默认 ws://127.0.0.1:8787/ws
    var engineURL: String {
        get {
            let raw = defaults.string(forKey: Key.engineURL) ?? LiveDubProtocol.defaultEngineURL
            return Settings.normalizeEngineURL(raw)
        }
        set { defaults.set(Settings.normalizeEngineURL(newValue), forKey: Key.engineURL) }
    }

    /// 清洗用户输入的引擎地址：
    /// - 空 -> 默认地址
    /// - 无 scheme -> 补 ws://
    /// - http(s) -> ws(s)
    /// - 无端口：ws:// 补 8787（本地引擎默认）；wss:// 保持 443（远端引擎）
    /// - 路径为空或 "/" -> 补 /ws
    /// - 解析失败 -> 默认地址
    static func normalizeEngineURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return LiveDubProtocol.defaultEngineURL }
        var candidate = trimmed
        if candidate.hasPrefix("http://") {
            candidate = "ws://" + candidate.dropFirst("http://".count)
        } else if candidate.hasPrefix("https://") {
            candidate = "wss://" + candidate.dropFirst("https://".count)
        } else if !candidate.hasPrefix("ws://") && !candidate.hasPrefix("wss://") {
            candidate = "ws://" + candidate
        }
        guard var components = URLComponents(string: candidate) else {
            return LiveDubProtocol.defaultEngineURL
        }
        if components.port == nil && components.scheme == "ws" {
            components.port = LiveDubProtocol.enginePort
        }
        if components.path.isEmpty || components.path == "/" { components.path = LiveDubProtocol.wsPath }
        components.query = nil
        components.fragment = nil
        guard let host = components.host, !host.isEmpty, let value = components.string else {
            return LiveDubProtocol.defaultEngineURL
        }
        return value
    }

    // MARK: - 浮层

    /// 译文字号（pt），11...40
    var fontSize: Double {
        get {
            let stored = defaults.double(forKey: Key.fontSize)
            guard stored > 0 else { return 20 }
            return min(40, max(11, stored))
        }
        set { defaults.set(min(40, max(11, newValue)), forKey: Key.fontSize) }
    }

    var clickThrough: Bool {
        get { bool(forKey: Key.clickThrough, default: false) }
        set { defaults.set(newValue, forKey: Key.clickThrough) }
    }

    var alwaysOnTop: Bool {
        get { bool(forKey: Key.alwaysOnTop, default: true) }
        set { defaults.set(newValue, forKey: Key.alwaysOnTop) }
    }

    var showSourceLine: Bool {
        get { bool(forKey: Key.showSourceLine, default: true) }
        set { defaults.set(newValue, forKey: Key.showSourceLine) }
    }

    var hasOverlayOrigin: Bool {
        get { bool(forKey: Key.hasOverlayOrigin, default: false) }
        set { defaults.set(newValue, forKey: Key.hasOverlayOrigin) }
    }

    var overlayOrigin: (x: Double, y: Double) {
        get {
            let x = defaults.double(forKey: Key.overlayOriginX)
            let y = defaults.double(forKey: Key.overlayOriginY)
            return (x, y)
        }
        set {
            defaults.set(newValue.x, forKey: Key.overlayOriginX)
            defaults.set(newValue.y, forKey: Key.overlayOriginY)
            defaults.set(true, forKey: Key.hasOverlayOrigin)
        }
    }

    func clearOverlayOrigin() {
        defaults.removeObject(forKey: Key.overlayOriginX)
        defaults.removeObject(forKey: Key.overlayOriginY)
        defaults.set(false, forKey: Key.hasOverlayOrigin)
    }

    // MARK: - 配音 / 语言

    var dubEnabled: Bool {
        get { bool(forKey: Key.dubEnabled, default: true) }
        set { defaults.set(newValue, forKey: Key.dubEnabled) }
    }

    var autoStart: Bool {
        get { bool(forKey: Key.autoStart, default: false) }
        set { defaults.set(newValue, forKey: Key.autoStart) }
    }

    // MARK: - 快捷笔记（v0.4）

    /// 记笔记时附屏幕截图（默认开；复用屏幕录制权限）
    var notesIncludeScreenshot: Bool {
        get { bool(forKey: Key.notesIncludeScreenshot, default: true) }
        set { defaults.set(newValue, forKey: Key.notesIncludeScreenshot) }
    }

    /// 同传暂停时仍允许 ⌥N 记笔记（默认开）
    var notesWhenPaused: Bool {
        get { bool(forKey: Key.notesWhenPaused, default: true) }
        set { defaults.set(newValue, forKey: Key.notesWhenPaused) }
    }

    var langFrom: String {
        get { string(forKey: Key.langFrom, default: "en") }
        set { defaults.set(newValue, forKey: Key.langFrom) }
    }

    var langTo: String {
        get { string(forKey: Key.langTo, default: "zh") }
        set { defaults.set(newValue, forKey: Key.langTo) }
    }

    // MARK: - 私有

    private func bool(forKey key: String, default fallback: Bool) -> Bool {
        guard defaults.object(forKey: key) != nil else { return fallback }
        return defaults.bool(forKey: key)
    }

    private func string(forKey key: String, default fallback: String) -> String {
        guard let value = defaults.string(forKey: key), !value.isEmpty else { return fallback }
        return value
    }
}
