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
        static let notesOCR = prefix + "notesOCR"
        static let notesVision = prefix + "notesVision"
        static let visualContextEnabled = prefix + "visualContextEnabled"
        static let visualContextInterval = prefix + "visualContextInterval"
        // v0.7 视觉设置
        static let captionMode = prefix + "captionMode"
        static let overlayWidth = prefix + "overlayWidth"
        static let overlayOpacity = prefix + "overlayOpacity"
        static let positionMode = prefix + "positionMode"
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

    /// 译文字号（pt），22...26，默认 24（v0.7 设计规范；旧值自动钳制迁移）
    var fontSize: Double {
        get {
            let stored = defaults.double(forKey: Key.fontSize)
            guard stored > 0 else { return OverlayDesign.translationDefault }
            return OverlayDesign.clampTranslationFont(stored)
        }
        set { defaults.set(OverlayDesign.clampTranslationFont(newValue), forKey: Key.fontSize) }
    }

    /// 字幕显示模式：双语 / 仅译文 / 仅原文
    var captionMode: CaptionMode {
        get {
            if let raw = defaults.string(forKey: Key.captionMode) {
                return CaptionMode.fromRaw(raw)
            }
            // 兼容 v0.6 的 showSourceLine 开关
            return showSourceLine ? .bilingual : .translationOnly
        }
        set {
            defaults.set(newValue.rawValue, forKey: Key.captionMode)
            defaults.set(newValue.showsSource, forKey: Key.showSourceLine)
        }
    }

    /// 浮层宽度：0 = 自动（随字号 680/760/840），否则 480...1100
    var overlayWidth: Double {
        get { OverlayDesign.clampOverlayWidth(defaults.double(forKey: Key.overlayWidth)) }
        set { defaults.set(OverlayDesign.clampOverlayWidth(newValue), forKey: Key.overlayWidth) }
    }

    /// 浮层背景不透明度：0.55...1.0，默认 0.92
    var overlayOpacity: Double {
        get {
            guard defaults.object(forKey: Key.overlayOpacity) != nil else {
                return OverlayDesign.opacityDefault
            }
            return OverlayDesign.clampOpacity(defaults.double(forKey: Key.overlayOpacity))
        }
        set { defaults.set(OverlayDesign.clampOpacity(newValue), forKey: Key.overlayOpacity) }
    }

    /// 浮层位置：底部居中 / 顶部居中 / 记住上次位置
    var positionMode: OverlayPositionMode {
        get { OverlayPositionMode.fromRaw(defaults.string(forKey: Key.positionMode)) }
        set { defaults.set(newValue.rawValue, forKey: Key.positionMode) }
    }

    /// 设置窗口「恢复默认」：只重置外观/字幕呈现相关项（引擎/笔记/视觉能力保持不变）
    func resetPresentationDefaults() {
        defaults.removeObject(forKey: Key.fontSize)
        defaults.removeObject(forKey: Key.captionMode)
        defaults.removeObject(forKey: Key.overlayWidth)
        defaults.removeObject(forKey: Key.overlayOpacity)
        defaults.removeObject(forKey: Key.positionMode)
        defaults.removeObject(forKey: Key.clickThrough)
        defaults.set(true, forKey: Key.showSourceLine)
        defaults.set(OverlayDesign.translationDefault, forKey: Key.fontSize)
        defaults.set(OverlayDesign.opacityDefault, forKey: Key.overlayOpacity)
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

    /// 记笔记时识别画面文字（OCR，快，默认开；需要引擎 v0.5 + 本地 OCR）
    var notesOCR: Bool {
        get { bool(forKey: Key.notesOCR, default: true) }
        set { defaults.set(newValue, forKey: Key.notesOCR) }
    }

    /// 记笔记时用 VLM 做「画面理解」（慢，约 20-30s，默认关；可能产生云端费用）
    var notesVision: Bool {
        get { bool(forKey: Key.notesVision, default: false) }
        set { defaults.set(newValue, forKey: Key.notesVision) }
    }

    var langFrom: String {
        get { string(forKey: Key.langFrom, default: "en") }
        set { defaults.set(newValue, forKey: Key.langFrom) }
    }

    var langTo: String {
        get { string(forKey: Key.langTo, default: "zh") }
        set { defaults.set(newValue, forKey: Key.langTo) }
    }

    // MARK: - 实时画面上下文（v0.6）

    /// 翻译参考画面文字（OCR，每 10s 推送 WS visual-context）——默认关闭（CPU/耗电/隐私）
    var visualContextEnabled: Bool {
        get { bool(forKey: Key.visualContextEnabled, default: false) }
        set { defaults.set(newValue, forKey: Key.visualContextEnabled) }
    }

    /// 推送间隔（秒）：可配置，钳制 8...15，默认 10
    var visualContextInterval: TimeInterval {
        get {
            guard defaults.object(forKey: Key.visualContextInterval) != nil else {
                return VisualContextPlanner.defaultIntervalSeconds
            }
            return VisualContextPlanner.clampInterval(defaults.double(forKey: Key.visualContextInterval))
        }
        set { defaults.set(VisualContextPlanner.clampInterval(newValue), forKey: Key.visualContextInterval) }
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
