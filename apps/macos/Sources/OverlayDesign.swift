//
//  OverlayDesign.swift
//  livedub macOS 菜单栏 App
//
//  v0.7 视觉重设计的设计语言与纯逻辑（与 docs/DESIGN.md 对齐）：
//   - 设计 token：jade/ink 色板、字号、圆角、间距、动效时长、命中区
//   - 浮层布局纯函数：字号/宽度联动、估算行数与高度（self-test 不建窗口即可验证）
//   - 状态 pill / 菜单摘要 / toast 文案 / VoiceOver label
//   - 亮暗外观、降低透明度、reduceMotion 的降级决策
//

import Foundation

// MARK: - 字幕显示模式 / 浮层位置

enum CaptionMode: String, CaseIterable, Equatable {
    case bilingual
    case translationOnly
    case sourceOnly

    var label: String {
        switch self {
        case .bilingual: return "双语（原文 + 译文）"
        case .translationOnly: return "仅译文"
        case .sourceOnly: return "仅原文"
        }
    }

    var showsTranslation: Bool {
        switch self {
        case .bilingual, .translationOnly: return true
        case .sourceOnly: return false
        }
    }

    var showsSource: Bool {
        switch self {
        case .bilingual, .sourceOnly: return true
        case .translationOnly: return false
        }
    }

    static func fromRaw(_ raw: String?) -> CaptionMode {
        guard let raw, let mode = CaptionMode(rawValue: raw) else { return .bilingual }
        return mode
    }
}

enum OverlayPositionMode: String, CaseIterable, Equatable {
    case bottom
    case top
    case memory

    var label: String {
        switch self {
        case .bottom: return "底部居中"
        case .top: return "顶部居中"
        case .memory: return "记住上次位置"
        }
    }

    static func fromRaw(_ raw: String?) -> OverlayPositionMode {
        guard let raw, let mode = OverlayPositionMode(rawValue: raw) else { return .bottom }
        return mode
    }
}

// MARK: - 设计 token

enum OverlayDesign {
    // 与 docs/DESIGN.md §4/§6 对齐
    static let cornerRadius: CGFloat = 20
    static let contentInsetH: CGFloat = 20
    static let contentInsetV: CGFloat = 16
    static let brandRowHeight: CGFloat = 18
    static let brandToContent: CGFloat = 10
    static let translationToSource: CGFloat = 6
    static let contentToStatus: CGFloat = 12
    static let statusRowHeight: CGFloat = 28
    static let minHeight: CGFloat = 92
    static let maxTranslationLines = 2
    static let maxSourceLines = 1

    static let translationMin: Double = 22
    static let translationMax: Double = 26
    static let translationDefault: Double = 24
    static let sourceFontSize: CGFloat = 14
    static let statusFontSize: CGFloat = 11
    static let brandFontSize: CGFloat = 11

    static let widthMin: Double = 480
    static let widthMax: Double = 1_100
    static let widthDefaultAuto: Double = 760
    static let widthAutoFontStep: Double = 40

    static let opacityMin: Double = 0.55
    static let opacityMax: Double = 1.0
    static let opacityDefault: Double = 0.92

    static let hoverToolbarHeight: CGFloat = 28
    static let hitTargetMin: CGFloat = 28
    static let panelShadowRadius: CGFloat = 24

    // 动效：120–240ms（docs/DESIGN.md §4），默认 180ms
    static let animationFast: TimeInterval = 0.16
    static let animationBase: TimeInterval = 0.18
    static let animationSlow: TimeInterval = 0.24
    static let toastDuration: TimeInterval = 3.0
    static let accentPulseDuration: TimeInterval = 2.4

    // 语义色（jade/ink）
    static let accentHexDark = "#5eead4"
    static let accentHexLight = "#0f9488"
    static let surfaceDark = "#141722"
    static let surfaceLight = "#ffffff"

    // MARK: 设置清洗（Settings 使用）

    static func clampTranslationFont(_ raw: Double) -> Double {
        guard raw.isFinite, raw > 0 else { return translationDefault }
        return min(translationMax, max(translationMin, raw))
    }

    static func clampOverlayWidth(_ raw: Double) -> Double {
        guard raw.isFinite, raw > 0 else { return 0 } // 0 = 自动（随字号）
        return min(widthMax, max(widthMin, raw))
    }

    static func clampOpacity(_ raw: Double) -> Double {
        guard raw.isFinite, raw > 0 else { return opacityDefault }
        return min(opacityMax, max(opacityMin, raw))
    }

    /// 实际浮层宽度：显式宽度优先；0（自动）时随字号 22→680 / 24→760 / 26→840，钳制 480...1100
    static func effectiveWidth(explicitWidth: Double, fontSize: Double) -> CGFloat {
        let clampedFont = clampTranslationFont(fontSize)
        if explicitWidth > 0 {
            return CGFloat(clampOverlayWidth(explicitWidth))
        }
        let auto = widthDefaultAuto + (clampedFont - translationDefault) * widthAutoFontStep
        return CGFloat(min(widthMax, max(widthMin, auto)))
    }

    // MARK: 布局估算（纯函数）

    /// 一段文本在给定字号/宽度下估算占几行（CJK 按 2 列宽；上限 maxLines）
    static func estimatedLines(text: String, fontSize: CGFloat, width: CGFloat, maxLines: Int) -> Int {
        guard width > 40, fontSize > 0, !text.isEmpty else { return 1 }
        let perLineColumns = max(4, Int(width / (fontSize * 0.52)))
        let columns = max(1, CaptionLayout.textWidth(text))
        let rawLines = Int(ceil(Double(columns) / Double(perLineColumns)))
        return min(maxLines, max(1, rawLines))
    }

    /// 浮层内容高度估算（用于 self-test 与初始 frame；实际渲染仍会用 AppKit 精确测量后校正）
    static func desiredHeight(
        translation: String,
        source: String,
        mode: CaptionMode,
        fontSize: CGFloat,
        width: CGFloat
    ) -> CGFloat {
        let contentWidth = max(40, width - contentInsetH * 2)
        let translationLineHeight = ceil(fontSize * 1.32)
        let sourceLineHeight = ceil(sourceFontSize * 1.45)
        var height = contentInsetV * 2 + brandRowHeight + brandToContent

        if mode.showsTranslation {
            let lines = estimatedLines(
                text: translation.isEmpty ? " " : translation,
                fontSize: fontSize,
                width: contentWidth,
                maxLines: maxTranslationLines
            )
            height += CGFloat(lines) * translationLineHeight
            if mode.showsSource && !source.isEmpty {
                height += translationToSource
            }
        }
        if mode.showsSource && !source.isEmpty {
            let lines = estimatedLines(
                text: source,
                fontSize: sourceFontSize,
                width: contentWidth,
                maxLines: maxSourceLines
            )
            height += CGFloat(lines) * sourceLineHeight
        }
        height += contentToStatus + statusRowHeight
        return ceil(max(minHeight, height))
    }
}

// MARK: - 状态 pill / duck 提示

enum OverlayStatusTone: String, Equatable {
    case ok
    case busy
    case warn
    case err
    case idle
}

enum OverlayStatusFormatter {
    static func tone(status: String, isError: Bool) -> OverlayStatusTone {
        if isError { return .err }
        if status.contains("错误") || status.contains("出错") || status.contains("失败") || status.contains("error") {
            return .err
        }
        if status.contains("暂停") || status.contains("等待屏幕录制") || status.contains("重连") || status.contains("连接引擎") {
            return .warn
        }
        if status.contains("翻译中") || status.contains("播放配音") || status.contains("识别")
            || status.contains("translating") || status.contains("speaking") || status.contains("模拟演示") {
            return .busy
        }
        if status.contains("聆听") || status.contains("就绪") {
            return .ok
        }
        return .idle
    }

    /// 状态 pill 文案：连接断开显示「未连接」；连接后「状态 · 延迟」
    static func pillText(status: String, latencyMs: Double?, connected: Bool) -> String {
        guard connected else { return "未连接" }
        var text = status.isEmpty ? "就绪" : status
        if let latencyMs {
            text += " · " + CaptionLayout.formatLatency(latencyMs)
        }
        return text
    }

    /// 配音播放时提示「系统原声不会自动压低」（macOS 已知限制）
    static func duckHint(status: String, dubEnabled: Bool) -> String? {
        guard dubEnabled else { return nil }
        return (status.contains("播放配音") || status.contains("speaking")) ? "原声未压低" : nil
    }
}

// MARK: - Toast 模型（图标 + 文案 + 语义色）

enum NoteToastKind: String, Equatable {
    case success
    case queued
    case failure

    var symbolName: String {
        switch self {
        case .success: return "checkmark.circle.fill"
        case .queued: return "tray.and.arrow.down.fill"
        case .failure: return "exclamationmark.triangle.fill"
        }
    }

    var tone: OverlayStatusTone {
        switch self {
        case .success: return .ok
        case .queued: return .warn
        case .failure: return .err
        }
    }

    func text(clock: String) -> String {
        switch self {
        case .success: return "已记录笔记 · \(clock)"
        case .queued: return "引擎未连接，笔记已排队 · \(clock)"
        case .failure: return "记笔记失败 · \(clock)"
        }
    }
}

struct OverlayToastModel: Equatable {
    var text: String
    var symbolName: String
    var tone: OverlayStatusTone
}

enum OverlayToastFactory {
    static func note(_ kind: NoteToastKind, clock: String) -> OverlayToastModel {
        OverlayToastModel(text: kind.text(clock: clock), symbolName: kind.symbolName, tone: kind.tone)
    }

    static func generic(_ text: String, isError: Bool = false) -> OverlayToastModel {
        OverlayToastModel(
            text: text,
            symbolName: isError ? "exclamationmark.triangle.fill" : "info.circle.fill",
            tone: isError ? .err : .idle
        )
    }

    static func visualContextStarted(chars: Int, clock: String) -> OverlayToastModel {
        OverlayToastModel(
            text: "画面上下文已开始推送 · \(chars) 字 · \(clock)",
            symbolName: "sparkles",
            tone: .busy
        )
    }
}

// MARK: - 菜单文案 / 符号

enum MenuDesign {
    static let brandSymbol = "captions.bubble"
    static let startSymbol = "play.fill"
    static let stopSymbol = "stop.fill"
    static let pauseSymbol = "pause.fill"
    static let resumeSymbol = "play.fill"
    static let noteSymbol = "square.and.pencil"
    static let settingsSymbol = "gearshape"
    static let openNotesSymbol = "note.text"
    static let workbenchSymbol = "macwindow"
    static let overlaySymbol = "rectangle.on.rectangle"
    static let permissionSymbol = "hand.raised"
    static let diagnosticsSymbol = "stethoscope"
    static let quitSymbol = "power"
    static let engineSymbol = "bolt.horizontal.circle"

    static let noteShortcut = "⌥N"
    static let settingsShortcut = "⌘,"
    static let quitShortcut = "⌘Q"

    static func startStopTitle(isRunning: Bool) -> String {
        isRunning ? "停止同传" : "开始同传"
    }

    static func pauseTitle(isPaused: Bool) -> String {
        isPaused ? "继续同传" : "暂停同传"
    }

    static func noteTitle() -> String {
        "记笔记（\(noteShortcut)）"
    }

    static func settingsTitle() -> String {
        "设置…（\(settingsShortcut)）"
    }

    static func quitTitle() -> String {
        "退出 livedub（\(quitShortcut)）"
    }

    /// 菜单第一行状态摘要：「已连接 · 聆听中 · 1.8s · OCR ✓ · 画面上下文 关」
    static func statusSummary(
        state: String,
        latencyMs: Double?,
        connectionText: String,
        ocrAvailable: Bool?,
        vlmAvailable: Bool?,
        visualContextEnabled: Bool
    ) -> String {
        var parts: [String] = []
        parts.append(connectionText)
        if !state.isEmpty { parts.append(state) }
        if let latencyMs { parts.append(CaptionLayout.formatLatency(latencyMs)) }
        if let ocrAvailable {
            parts.append(ocrAvailable ? "OCR ✓" : "OCR ×")
        }
        if let vlmAvailable, vlmAvailable {
            parts.append("VLM ✓")
        }
        parts.append(visualContextEnabled ? "画面上下文 开" : "画面上下文 关")
        return parts.joined(separator: " · ")
    }
}

// MARK: - 可访问性

enum OverlayA11y {
    static let overlayGroup = "livedub 同传字幕浮层"
    static let brand = "livedub 同传"
    static let translationRole = "当前译文"
    static let sourceRole = "当前原文"
    static let statusPillRole = "同传状态"
    static let pauseButton = "暂停或继续同传"
    static let noteButton = "记笔记，快捷键 Option N"
    static let settingsButton = "打开设置"
    static let closeButton = "隐藏字幕浮层"
    static let hitTargetMin: CGFloat = OverlayDesign.hitTargetMin

    static func statusValue(status: String, latencyMs: Double?) -> String {
        var text = status.isEmpty ? "就绪" : status
        if let latencyMs { text += "，延迟 " + CaptionLayout.formatLatency(latencyMs) }
        return text
    }

    static func buttonLabels() -> [String] {
        [pauseButton, noteButton, settingsButton, closeButton]
    }
}

// MARK: - 亮暗 / 透明 / 动效降级

struct OverlayRGBA: Equatable {
    var r: Double
    var g: Double
    var b: Double
    var a: Double
}

enum OverlayTheme {
    static func isDark(appearanceName: String) -> Bool {
        appearanceName.lowercased().contains("dark")
    }

    /// 浮层底色：正常 = 材质上的 tint（半透明）；系统「降低透明度」= 纯色不透明（降级）
    static func backdropRGBA(isDark: Bool, reduceTransparency: Bool, opacity: Double) -> OverlayRGBA {
        let alpha = reduceTransparency ? 1.0 : max(0.12, OverlayDesign.clampOpacity(opacity) * 0.55)
        if isDark {
            return OverlayRGBA(r: 0.078, g: 0.090, b: 0.133, a: alpha) // #141722
        }
        return OverlayRGBA(r: 1.0, g: 1.0, b: 1.0, a: min(0.96, alpha + 0.25)) // 亮色下更实一些保证对比
    }

    /// pill / 工具条的 surface 色
    static func surfaceRGBA(isDark: Bool) -> OverlayRGBA {
        isDark
            ? OverlayRGBA(r: 0.15, g: 0.17, b: 0.24, a: 0.72)
            : OverlayRGBA(r: 0.96, g: 0.97, b: 0.99, a: 0.9)
    }

    static func accentRGBA(isDark: Bool) -> OverlayRGBA {
        isDark
            ? OverlayRGBA(r: 0.369, g: 0.918, b: 0.831, a: 1) // #5eead4
            : OverlayRGBA(r: 0.059, g: 0.580, b: 0.533, a: 1) // #0f9488
    }

    static func toneRGBA(_ tone: OverlayStatusTone, isDark: Bool) -> OverlayRGBA {
        switch tone {
        case .ok: return isDark ? OverlayRGBA(r: 0.204, g: 0.827, b: 0.600, a: 1) : OverlayRGBA(r: 0.059, g: 0.616, b: 0.459, a: 1)
        case .busy: return isDark ? OverlayRGBA(r: 0.376, g: 0.647, b: 0.980, a: 1) : OverlayRGBA(r: 0.145, g: 0.388, b: 0.922, a: 1)
        case .warn: return isDark ? OverlayRGBA(r: 0.984, g: 0.749, b: 0.141, a: 1) : OverlayRGBA(r: 0.706, g: 0.325, b: 0.035, a: 1)
        case .err: return isDark ? OverlayRGBA(r: 0.984, g: 0.443, b: 0.522, a: 1) : OverlayRGBA(r: 0.863, g: 0.149, b: 0.149, a: 1)
        case .idle: return isDark ? OverlayRGBA(r: 0.62, g: 0.65, b: 0.72, a: 1) : OverlayRGBA(r: 0.42, g: 0.46, b: 0.52, a: 1)
        }
    }

    /// 动效时长：respect reduceMotion（0 = 立即生效）
    static func animationDuration(_ base: TimeInterval, reduceMotion: Bool) -> TimeInterval {
        reduceMotion ? 0 : base
    }

    /// accent 呼吸线/点：reduceMotion 时固定中等透明度，不做循环动画
    static func accentBreathingAlpha(reduceMotion: Bool) -> Float? {
        reduceMotion ? nil : 0.55
    }

    static func shouldAnimate(reduceMotion: Bool) -> Bool {
        !reduceMotion
    }
}
