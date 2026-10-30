//
//  OverlayWindow.swift
//  livedub macOS 菜单栏 App
//
//  v0.7 视觉重设计（与 docs/DESIGN.md 对齐）：
//   品牌小标 + 状态 pill + 译文 22–26pt semibold + 原文次级 + accent 呼吸线 +
//   20pt 圆角 + NSVisualEffectView 材质（降低透明度/减少动态时降级）+ 亮暗自适应 +
//   150–200ms 动效 + 悬停微型工具条（暂停/记笔记/设置/关闭）。
//   保留整层拖动、点击穿透、位置记忆、toast（图标 + 文案 + 语义色）。
//

import AppKit

// MARK: - 面板

final class OverlayPanel: NSPanel {
    /// 字幕浮层不抢键盘焦点，避免打断 Zoom / 播放器操作
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - 基础控件

/// 不参与鼠标命中的文本/装饰视图：点击穿透到浮层背景，保证整层可拖动
class PassthroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class PassthroughLabel: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// 28×28 icon 按钮（命中区 ≥28pt，hover ghost 底，VoiceOver label）
final class OverlayIconButton: NSButton {
    private let hoverLayer = PassthroughView()
    var symbolName: String = "circle" {
        didSet { updateSymbol() }
    }

    init(symbolName: String, accessibilityLabel: String, toolTip: String? = nil) {
        super.init(frame: .zero)
        self.symbolName = symbolName
        self.isBordered = false
        self.bezelStyle = .regularSquare
        self.imagePosition = .imageOnly
        self.imageScaling = .scaleProportionallyDown
        self.focusRingType = .default
        self.setAccessibilityLabel(accessibilityLabel)
        self.toolTip = toolTip
        self.target = nil
        self.action = nil
        hoverLayer.wantsLayer = true
        hoverLayer.layer?.cornerRadius = 8
        hoverLayer.layer?.backgroundColor = NSColor.clear.cgColor
        hoverLayer.isHidden = true
        addSubview(hoverLayer)
        updateSymbol()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("OverlayIconButton 只支持代码布局")
    }

    override var isFlipped: Bool { true }

    private func updateSymbol() {
        let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        image?.isTemplate = true
        self.image = image
        self.contentTintColor = .secondaryLabelColor
    }

    override func layout() {
        super.layout()
        hoverLayer.frame = bounds
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        hoverLayer.isHidden = false
        hoverLayer.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.08).cgColor
    }

    override func mouseExited(with event: NSEvent) {
        hoverLayer.layer?.backgroundColor = NSColor.clear.cgColor
        hoverLayer.isHidden = true
    }

    override func mouseDown(with event: NSEvent) {
        hoverLayer.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.14).cgColor
        super.mouseDown(with: event)
        hoverLayer.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.08).cgColor
    }
}

/// 状态 pill：圆点（语义色）+ 状态文字 + 延迟
final class StatusPillView: PassthroughView {
    private let dot = NSView()
    private let label = PassthroughLabel(labelWithString: "")
    private var tone: OverlayStatusTone = .idle

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 10
        addSubview(dot)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        label.font = NSFont.systemFont(ofSize: OverlayDesign.statusFontSize, weight: .medium)
        label.alignment = .left
        label.lineBreakMode = .byTruncatingTail
        addSubview(label)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(OverlayA11y.statusPillRole)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("StatusPillView 只支持代码布局")
    }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func apply(text: String, tone: OverlayStatusTone, isDark: Bool, animate: Bool) {
        self.tone = tone
        label.stringValue = text
        let toneColor = OverlayTheme.toneRGBA(tone, isDark: isDark).nsColor
        let surface = OverlayTheme.surfaceRGBA(isDark: isDark).nsColor
        if animate {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = OverlayDesign.animationFast
                self.layer?.backgroundColor = surface.cgColor
                self.dot.layer?.backgroundColor = toneColor.cgColor
                self.label.textColor = NSColor.labelColor.withAlphaComponent(0.92)
            }
        } else {
            layer?.backgroundColor = surface.cgColor
            dot.layer?.backgroundColor = toneColor.cgColor
            label.textColor = NSColor.labelColor.withAlphaComponent(0.92)
        }
        setAccessibilityValue(text)
        needsLayout = true
    }

    func intrinsicSize() -> NSSize {
        let fitting = label.sizeThatFits(NSSize(width: 500, height: 20))
        // 左右内边距 10+10；圆点 6 + 间距 8；再留 8pt 给中文字体测量误差，避免省略号
        let padding: CGFloat = 42
        let width: CGFloat = ceil(fitting.width) + padding
        return NSSize(width: width, height: 20)
    }

    override func layout() {
        super.layout()
        let height = max(20, bounds.height)
        dot.frame = NSRect(x: 10, y: (height - 6) / 2, width: 6, height: 6)
        let labelWidth: CGFloat = max(10, bounds.width - 34)
        label.frame = NSRect(x: 24, y: (height - 15) / 2, width: labelWidth, height: 15)
    }
}

/// accent 呼吸线：2pt，reduceMotion 时静止
final class AccentLineView: NSView {
    private var breathing = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 1
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("AccentLineView 只支持代码布局")
    }

    override var isFlipped: Bool { true }

    func apply(isDark: Bool, reduceMotion: Bool) {
        layer?.backgroundColor = OverlayTheme.accentRGBA(isDark: isDark).nsColor.cgColor
        layer?.removeAnimation(forKey: "breathing")
        layer?.opacity = reduceMotion ? 0.6 : 0.75
        guard !reduceMotion else {
            breathing = false
            return
        }
        breathing = true
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 0.35
        animation.toValue = 0.92
        animation.duration = OverlayDesign.accentPulseDuration
        animation.autoreverses = true
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer?.add(animation, forKey: "breathing")
    }
}

/// 顶部 toast：图标 + 文案 + 语义色（成功/排队/失败）
final class OverlayToastView: PassthroughView {
    private let iconView = NSImageView()
    private let label = PassthroughLabel(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.borderWidth = 1
        iconView.imageScaling = .scaleProportionallyDown
        addSubview(iconView)
        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        addSubview(label)
        isHidden = true
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("OverlayToastView 只支持代码布局")
    }

    override var isFlipped: Bool { true }

    func apply(_ model: OverlayToastModel, isDark: Bool) {
        label.stringValue = model.text
        label.textColor = .labelColor
        iconView.image = NSImage(systemSymbolName: model.symbolName, accessibilityDescription: nil)
        iconView.contentTintColor = OverlayTheme.toneRGBA(model.tone, isDark: isDark).nsColor
        layer?.backgroundColor = OverlayTheme.surfaceRGBA(isDark: isDark).nsColor.cgColor
        layer?.borderColor = OverlayTheme.toneRGBA(model.tone, isDark: isDark).nsColor.withAlphaComponent(0.35).cgColor
        setAccessibilityLabel(model.text)
        needsLayout = true
    }

    func intrinsicSize() -> NSSize {
        let font = label.font ?? NSFont.systemFont(ofSize: 12)
        let textSize = (label.stringValue as NSString).size(withAttributes: [.font: font])
        return NSSize(width: ceil(textSize.width) + 16 + 16 + 10 + 16, height: 30)
    }

    override func layout() {
        super.layout()
        iconView.frame = NSRect(x: 12, y: (bounds.height - 14) / 2, width: 14, height: 14)
        label.frame = NSRect(x: 32, y: (bounds.height - 16) / 2, width: max(10, bounds.width - 44), height: 16)
    }
}

// MARK: - 浮层内容视图

final class OverlayContentView: NSView {
    var onPauseToggle: (() -> Void)?
    var onNoteAction: (() -> Void)?
    var onSettingsAction: (() -> Void)?
    var onCloseAction: (() -> Void)?

    let translationLabel = PassthroughLabel(wrappingLabelWithString: "")
    let sourceLabel = PassthroughLabel(wrappingLabelWithString: "")
    private let brandLabel = PassthroughLabel(labelWithString: OverlayA11y.brand)
    private let statusPill = StatusPillView(frame: .zero)
    private let effectView = NSVisualEffectView()
    private let tintView = PassthroughView()
    private let accentLine = AccentLineView(frame: .zero)
    private let hintLabel = PassthroughLabel(labelWithString: "")
    private let toolbar = PassthroughView()
    private let toast = OverlayToastView(frame: .zero)
    private var toastHideWorkItem: DispatchWorkItem?
    private var toolbarHideWorkItem: DispatchWorkItem?
    private var toolbarVisible = false
    private var trackingArea: NSTrackingArea?

    private var pauseButton: OverlayIconButton!
    private var noteButton: OverlayIconButton!
    private var settingsButton: OverlayIconButton!
    private var closeButton: OverlayIconButton!

    private(set) var translationFontSize: CGFloat = CGFloat(OverlayDesign.translationDefault)
    private(set) var captionMode: CaptionMode = .bilingual
    private(set) var opacity: Double = OverlayDesign.opacityDefault
    private(set) var isPaused = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = OverlayDesign.cornerRadius
        layer?.masksToBounds = true
        configureBackground()
        configureLabels()
        configureToolbar()
        addSubview(toast)
        configureAccessibility()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("OverlayContentView 只支持代码布局")
    }

    override var isOpaque: Bool { false }
    override var isFlipped: Bool { true }

    // MARK: 配置

    private func configureBackground() {
        effectView.material = .hudWindow
        effectView.blendingMode = .behindWindow
        effectView.state = .active
        effectView.wantsLayer = true
        effectView.layer?.cornerRadius = OverlayDesign.cornerRadius
        effectView.layer?.masksToBounds = true
        addSubview(effectView)
        tintView.wantsLayer = true
        tintView.layer?.cornerRadius = OverlayDesign.cornerRadius
        addSubview(tintView)
        addSubview(accentLine)
    }

    private func configureLabels() {
        brandLabel.font = NSFont.systemFont(ofSize: OverlayDesign.brandFontSize, weight: .semibold)
        brandLabel.textColor = NSColor.secondaryLabelColor
        brandLabel.setAccessibilityLabel(OverlayA11y.brand)
        addSubview(brandLabel)
        addSubview(statusPill)

        translationLabel.font = NSFont.systemFont(ofSize: translationFontSize, weight: .semibold)
        translationLabel.textColor = .labelColor
        translationLabel.maximumNumberOfLines = OverlayDesign.maxTranslationLines
        translationLabel.lineBreakMode = .byTruncatingTail
        translationLabel.alignment = .left
        translationLabel.setAccessibilityLabel(OverlayA11y.translationRole)
        addSubview(translationLabel)

        sourceLabel.font = NSFont.systemFont(ofSize: OverlayDesign.sourceFontSize, weight: .regular)
        sourceLabel.textColor = NSColor.secondaryLabelColor
        sourceLabel.maximumNumberOfLines = OverlayDesign.maxSourceLines
        sourceLabel.lineBreakMode = .byTruncatingTail
        sourceLabel.setAccessibilityLabel(OverlayA11y.sourceRole)
        addSubview(sourceLabel)

        hintLabel.font = NSFont.systemFont(ofSize: 10, weight: .medium)
        hintLabel.textColor = NSColor.tertiaryLabelColor
        hintLabel.alignment = .right
        addSubview(hintLabel)
    }

    private func configureToolbar() {
        toolbar.wantsLayer = true
        toolbar.layer?.cornerRadius = 10
        toolbar.layer?.backgroundColor = NSColor.clear.cgColor
        toolbar.alphaValue = 0
        toolbar.isHidden = true
        addSubview(toolbar)

        pauseButton = OverlayIconButton(
            symbolName: MenuDesign.pauseSymbol,
            accessibilityLabel: OverlayA11y.pauseButton,
            toolTip: "暂停 / 继续同传"
        )
        noteButton = OverlayIconButton(
            symbolName: MenuDesign.noteSymbol,
            accessibilityLabel: OverlayA11y.noteButton,
            toolTip: "记笔记（⌥N）"
        )
        settingsButton = OverlayIconButton(
            symbolName: MenuDesign.settingsSymbol,
            accessibilityLabel: OverlayA11y.settingsButton,
            toolTip: "打开设置"
        )
        closeButton = OverlayIconButton(
            symbolName: "xmark",
            accessibilityLabel: OverlayA11y.closeButton,
            toolTip: "隐藏字幕浮层"
        )
        pauseButton.target = self
        pauseButton.action = #selector(handlePause)
        noteButton.target = self
        noteButton.action = #selector(handleNote)
        settingsButton.target = self
        settingsButton.action = #selector(handleSettings)
        closeButton.target = self
        closeButton.action = #selector(handleClose)
        let buttons: [OverlayIconButton] = [pauseButton, noteButton, settingsButton, closeButton]
        for button in buttons {
            toolbar.addSubview(button)
        }
    }

    private func configureAccessibility() {
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(OverlayA11y.overlayGroup)
    }

    // MARK: 状态更新

    func applySettings(_ settings: Settings) {
        translationFontSize = CGFloat(OverlayDesign.clampTranslationFont(settings.fontSize))
        captionMode = settings.captionMode
        opacity = settings.overlayOpacity
        translationLabel.font = NSFont.systemFont(ofSize: translationFontSize, weight: .semibold)
        applyTheme()
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    func setCaption(translation: String, source: String, animate: Bool) {
        let oldTranslation = translationLabel.stringValue
        let oldSource = sourceLabel.stringValue
        let translationPending = translation.isEmpty && !source.isEmpty
        translationLabel.stringValue = translation.isEmpty ? (translationPending ? "…" : "") : translation
        translationLabel.alphaValue = translation.isEmpty ? (translationPending ? 0.42 : 0.6) : 1.0
        sourceLabel.stringValue = source
        sourceLabel.isHidden = !captionMode.showsSource || source.isEmpty
        translationLabel.isHidden = !captionMode.showsTranslation
        setAccessibilityValueForLabels(translation: translation, source: source)

        guard animate, translation != oldTranslation || source != oldSource else { return }
        let duration = OverlayTheme.animationDuration(OverlayDesign.animationBase, reduceMotion: reduceMotion)
        guard duration > 0 else { return }
        translationLabel.alphaValue = 0.65
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            translationLabel.animator().alphaValue = translation.isEmpty ? 0.6 : 1.0
        }
    }

    var currentConnected = false

    func setStatus(
        status: String,
        latencyMs: Double?,
        isError: Bool,
        connected: Bool,
        isPaused: Bool,
        animate: Bool
    ) {
        self.isPaused = isPaused
        currentConnected = connected
        let tone = OverlayStatusFormatter.tone(status: status, isError: isError)
        let text = OverlayStatusFormatter.pillText(status: status, latencyMs: latencyMs, connected: connected)
        statusPill.apply(text: text, tone: tone, isDark: isDark, animate: animate && canAnimate)
        hintLabel.stringValue = OverlayStatusFormatter.duckHint(status: status, dubEnabled: true)
            ?? (connected ? "悬停显示操作 · \(MenuDesign.noteShortcut) 记笔记" : "")
        pauseButton.symbolName = isPaused ? MenuDesign.resumeSymbol : MenuDesign.pauseSymbol
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    func setPaused(_ paused: Bool) {
        isPaused = paused
        pauseButton.symbolName = paused ? MenuDesign.resumeSymbol : MenuDesign.pauseSymbol
    }

    func applyTheme() {
        let backdrop = OverlayTheme.backdropRGBA(
            isDark: isDark,
            reduceTransparency: reduceTransparency,
            opacity: opacity
        )
        tintView.layer?.backgroundColor = backdrop.nsColor.cgColor
        accentLine.apply(isDark: isDark, reduceMotion: reduceMotion)
        needsLayout = true
    }

    // MARK: Toast

    func showToast(_ model: OverlayToastModel) {
        toast.apply(model, isDark: isDark)
        toast.isHidden = false
        toast.alphaValue = 1
        toastHideWorkItem?.cancel()
        needsLayout = true
        layoutSubtreeIfNeeded()
        layoutToast()
        let work = DispatchWorkItem { [weak self] in
            self?.hideToast(animated: true)
        }
        toastHideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + OverlayDesign.toastDuration, execute: work)
    }

    func hideToast(animated: Bool) {
        toastHideWorkItem?.cancel()
        toastHideWorkItem = nil
        guard !toast.isHidden else { return }
        let duration = OverlayTheme.animationDuration(OverlayDesign.animationBase, reduceMotion: reduceMotion)
        guard animated, duration > 0 else {
            toast.isHidden = true
            toast.alphaValue = 1
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            toast.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            self?.toast.isHidden = true
            self?.toast.alphaValue = 1
        }
    }

    // MARK: 悬停工具条

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        toolbarHideWorkItem?.cancel()
        showToolbar(animated: canAnimate)
    }

    override func mouseExited(with event: NSEvent) {
        guard toolbarVisible else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.hideToolbar(animated: self?.canAnimate ?? false)
        }
        toolbarHideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    private func showToolbar(animated: Bool) {
        guard !toolbarVisible else { return }
        toolbarVisible = true
        toolbar.isHidden = false
        needsLayout = true
        layoutSubtreeIfNeeded()
        let duration = OverlayTheme.animationDuration(OverlayDesign.animationFast, reduceMotion: reduceMotion)
        if animated, duration > 0 {
            toolbar.alphaValue = 0
            NSAnimationContext.runAnimationGroup { context in
                context.duration = duration
                toolbar.animator().alphaValue = 1
            }
        } else {
            toolbar.alphaValue = 1
        }
    }

    private func hideToolbar(animated: Bool) {
        guard toolbarVisible else { return }
        toolbarVisible = false
        let duration = OverlayTheme.animationDuration(OverlayDesign.animationFast, reduceMotion: reduceMotion)
        guard animated, duration > 0 else {
            toolbar.isHidden = true
            toolbar.alphaValue = 0
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            toolbar.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            self?.toolbar.isHidden = true
            self?.toolbar.alphaValue = 0
        }
    }

    // MARK: 环境

    private var isDark: Bool {
        effectiveDarkAppearance
    }

    private var effectiveDarkAppearance: Bool {
        // 通过 view 的 effectiveAppearance 判读；纯函数 OverlayTheme.isDark 负责解析
        let best = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua])
        return OverlayTheme.isDark(appearanceName: best?.rawValue ?? "aqua")
    }

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    private var reduceTransparency: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }

    private var canAnimate: Bool {
        OverlayTheme.shouldAnimate(reduceMotion: reduceMotion)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyTheme()
    }

    // MARK: 布局

    func desiredHeight(forWidth width: CGFloat) -> CGFloat {
        let contentWidth = max(80, width - OverlayDesign.contentInsetH * 2)
        var height = OverlayDesign.contentInsetV * 2 + OverlayDesign.brandRowHeight + OverlayDesign.brandToContent
        if captionMode.showsTranslation {
            height += labelHeight(translationLabel, width: contentWidth, maxLines: OverlayDesign.maxTranslationLines)
            if captionMode.showsSource && !sourceLabel.stringValue.isEmpty {
                height += OverlayDesign.translationToSource
            }
        }
        if captionMode.showsSource && !sourceLabel.stringValue.isEmpty {
            height += labelHeight(sourceLabel, width: contentWidth, maxLines: OverlayDesign.maxSourceLines)
        }
        height += OverlayDesign.contentToStatus + OverlayDesign.statusRowHeight
        return ceil(max(OverlayDesign.minHeight, height))
    }

    override func layout() {
        super.layout()
        // 背景铺满 + 20pt 圆角
        effectView.frame = bounds
        tintView.frame = bounds
        // accent 呼吸线（顶部，避开圆角）
        accentLine.frame = NSRect(
            x: OverlayDesign.contentInsetH,
            y: 1,
            width: max(4, bounds.width - OverlayDesign.contentInsetH * 2),
            height: 2
        )

        let contentWidth = max(80, bounds.width - OverlayDesign.contentInsetH * 2)
        var y = OverlayDesign.contentInsetV

        // 品牌 + 状态 pill 同一行
        statusPill.frame = NSRect(
            x: bounds.width - OverlayDesign.contentInsetH - statusPill.intrinsicSize().width,
            y: y,
            width: statusPill.intrinsicSize().width,
            height: OverlayDesign.brandRowHeight
        )
        brandLabel.frame = NSRect(
            x: OverlayDesign.contentInsetH,
            y: y + 1,
            width: max(40, statusPill.frame.minX - OverlayDesign.contentInsetH - 8),
            height: 16
        )
        y += OverlayDesign.brandRowHeight + OverlayDesign.brandToContent

        // 译文
        if captionMode.showsTranslation {
            let translationHeight = labelHeight(
                translationLabel,
                width: contentWidth,
                maxLines: OverlayDesign.maxTranslationLines
            )
            translationLabel.frame = NSRect(x: OverlayDesign.contentInsetH, y: y, width: contentWidth, height: translationHeight)
            y += translationHeight
        } else {
            translationLabel.frame = .zero
        }

        // 原文
        if captionMode.showsSource && !sourceLabel.stringValue.isEmpty {
            if captionMode.showsTranslation {
                y += OverlayDesign.translationToSource
            }
            let sourceHeight = labelHeight(sourceLabel, width: contentWidth, maxLines: OverlayDesign.maxSourceLines)
            sourceLabel.frame = NSRect(x: OverlayDesign.contentInsetH, y: y, width: contentWidth, height: sourceHeight)
            y += sourceHeight
        } else {
            sourceLabel.frame = .zero
        }

        // 状态行：hint + 工具条（右侧，悬停出现）
        y += OverlayDesign.contentToStatus
        let statusRowY = min(y, bounds.height - OverlayDesign.contentInsetV - OverlayDesign.statusRowHeight)
        hintLabel.frame = NSRect(
            x: OverlayDesign.contentInsetH,
            y: statusRowY + 6,
            width: max(40, contentWidth * 0.4),
            height: 14
        )
        let buttonSize = OverlayDesign.hitTargetMin
        let spacing: CGFloat = 2
        let toolbarWidth = buttonSize * 4 + spacing * 3
        let toolbarX = bounds.width - OverlayDesign.contentInsetH - toolbarWidth
        toolbar.frame = NSRect(x: toolbarX, y: statusRowY, width: toolbarWidth, height: buttonSize)
        let buttons: [OverlayIconButton] = [pauseButton, noteButton, settingsButton, closeButton]
        for (index, button) in buttons.enumerated() {
            button.frame = NSRect(
                x: CGFloat(index) * (buttonSize + spacing),
                y: 0,
                width: buttonSize,
                height: buttonSize
            )
        }
        layoutToast()
    }

    private func layoutToast() {
        guard !toast.isHidden else { return }
        let size = toast.intrinsicSize()
        let width = min(bounds.width - 32, max(120, size.width))
        toast.frame = NSRect(x: (bounds.width - width) / 2, y: 10, width: width, height: size.height)
    }

    private func labelHeight(_ label: NSTextField, width: CGFloat, maxLines: Int) -> CGFloat {
        guard let font = label.font, width > 8 else { return 0 }
        let lineHeight = ceil(font.ascender - font.descender + font.leading)
        let text = label.stringValue.isEmpty ? " " : label.stringValue
        let attributed = NSAttributedString(string: text, attributes: [.font: font])
        let bounding = attributed.boundingRect(
            with: NSSize(width: width, height: 10_000),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        let capped = min(ceil(bounding.height), lineHeight * CGFloat(maxLines))
        return max(lineHeight, capped)
    }

    private func setAccessibilityValueForLabels(translation: String, source: String) {
        translationLabel.setAccessibilityValue(translation)
        sourceLabel.setAccessibilityValue(source)
    }

    // MARK: 事件

    @objc private func handlePause() {
        onPauseToggle?()
    }

    @objc private func handleNote() {
        onNoteAction?()
    }

    @objc private func handleSettings() {
        onSettingsAction?()
    }

    @objc private func handleClose() {
        onCloseAction?()
    }

    /// 只有工具条按钮参与命中；其他区域交给浮层背景（整层可拖动）
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, alphaValue > 0, window != nil else { return nil }
        if toolbarVisible && !toolbar.isHidden {
            let local = convert(point, to: toolbar)
            if toolbar.bounds.contains(local) {
                for case let button as NSButton in toolbar.subviews {
                    let buttonPoint = button.convert(local, from: toolbar)
                    if button.bounds.contains(buttonPoint) { return button }
                }
                return toolbar
            }
        }
        return bounds.contains(point) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

// MARK: - 浮层控制器

final class OverlayController: NSObject, NSWindowDelegate {
    var onVisibilityChanged: ((Bool) -> Void)?
    var onLog: ((String) -> Void)?
    var onPauseToggle: (() -> Void)?
    var onNoteAction: (() -> Void)?
    var onSettingsAction: (() -> Void)?
    var onCloseAction: (() -> Void)?

    private let settings: Settings
    private var panel: OverlayPanel?
    private var content: OverlayContentView?
    private var currentTranslation = ""
    private var currentSource = ""
    private var currentStatus = "未开始"
    private var currentLatencyMs: Double?
    private var currentConnected = false
    private var currentPaused = false
    private var currentError = false
    private var isProgrammaticMove = false

    init(settings: Settings) {
        self.settings = settings
        super.init()
    }

    var isVisible: Bool { panel?.isVisible ?? false }

    // MARK: 显示/隐藏

    func show() {
        let panel = ensurePanel()
        applyPositionMode(panel)
        clampToScreen()
        panel.orderFrontRegardless()
        onVisibilityChanged?(true)
    }

    func hide() {
        content?.hideToast(animated: false)
        panel?.orderOut(nil)
        onVisibilityChanged?(false)
    }

    func toggle() {
        if isVisible { hide() } else { show() }
    }

    func resetPosition() {
        settings.positionMode = .bottom
        settings.clearOverlayOrigin()
        guard let panel else { return }
        applyPositionMode(panel)
        clampToScreen()
        render()
    }

    func reloadFromSettings() {
        guard let panel else { return }
        panel.ignoresMouseEvents = settings.clickThrough
        panel.level = settings.alwaysOnTop ? .floating : .normal
        content?.applySettings(settings)
        content?.applyTheme()
        render()
    }

    /// 设置窗口调整「位置」后调用：按位置预设重新摆位
    func applyPositionPreset() {
        guard let panel else { return }
        applyPositionMode(panel)
        clampToScreen()
        render()
    }

    // MARK: 内容更新

    func showToast(_ text: String, isError: Bool = false) {
        showToast(model: OverlayToastFactory.generic(text, isError: isError))
    }

    func showToast(model: OverlayToastModel) {
        guard let content, isVisible else {
            onLog?("[overlay] \(model.text)")
            return
        }
        content.showToast(model)
    }

    func setCaption(translation: String, source: String) {
        guard currentTranslation != translation || currentSource != source else { return }
        currentTranslation = translation
        currentSource = source
        render()
    }

    func setStatus(_ status: String, latencyMs: Double?, isError: Bool = false) {
        currentStatus = status
        currentLatencyMs = latencyMs
        currentError = isError
        render()
    }

    func setConnection(connected: Bool) {
        currentConnected = connected
        render()
    }

    func setPaused(_ paused: Bool) {
        currentPaused = paused
        content?.setPaused(paused)
        render()
    }

    func setPlaceholder(_ text: String) {
        currentTranslation = text
        currentSource = ""
        render()
    }

    func clearCaptions() {
        currentTranslation = ""
        currentSource = ""
        render()
    }

    // MARK: 内部

    private func ensurePanel() -> OverlayPanel {
        if let panel { return panel }
        let width = panelWidth()
        let panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: OverlayDesign.minHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = settings.alwaysOnTop ? .floating : .normal
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .utilityWindow
        panel.ignoresMouseEvents = settings.clickThrough
        panel.delegate = self

        let content = OverlayContentView(frame: NSRect(x: 0, y: 0, width: width, height: OverlayDesign.minHeight))
        content.autoresizingMask = [.width, .height]
        content.applySettings(settings)
        content.onPauseToggle = { [weak self] in self?.onPauseToggle?() }
        content.onNoteAction = { [weak self] in self?.onNoteAction?() }
        content.onSettingsAction = { [weak self] in self?.onSettingsAction?() }
        content.onCloseAction = { [weak self] in self?.onCloseAction?() }
        panel.contentView = content
        self.panel = panel
        self.content = content
        render()
        return panel
    }

    private func render() {
        guard let content else { return }
        let animate = OverlayTheme.shouldAnimate(reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        content.setCaption(translation: currentTranslation, source: currentSource, animate: animate)
        content.setStatus(
            status: currentStatus,
            latencyMs: currentLatencyMs,
            isError: currentError,
            connected: currentConnected,
            isPaused: currentPaused,
            animate: animate
        )
        content.needsLayout = true
        content.layoutSubtreeIfNeeded()

        guard let panel else { return }
        let width = panelWidth()
        let height = content.desiredHeight(forWidth: width)
        var frame = panel.frame
        let topEdge = frame.maxY
        frame.size = NSSize(width: width, height: height)
        if settings.positionMode == .top {
            frame.origin.y = topEdge - height
        }
        isProgrammaticMove = true
        panel.setFrame(frame, display: true)
        isProgrammaticMove = false
        content.frame = NSRect(origin: .zero, size: frame.size)
        content.layoutSubtreeIfNeeded()
    }

    private func panelWidth() -> CGFloat {
        let screenWidth = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame.width ?? 1_440
        let target = OverlayDesign.effectiveWidth(
            explicitWidth: settings.overlayWidth,
            fontSize: settings.fontSize
        )
        return min(screenWidth - 32, target)
    }

    private func applyPositionMode(_ panel: OverlayPanel) {
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let size = panel.frame.size
        switch settings.positionMode {
        case .bottom:
            moveProgrammatically(to: NSPoint(x: visible.midX - size.width / 2, y: visible.minY + 72))
        case .top:
            moveProgrammatically(to: NSPoint(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 24))
        case .memory:
            if settings.hasOverlayOrigin {
                moveProgrammatically(to: NSPoint(x: settings.overlayOrigin.x, y: settings.overlayOrigin.y))
            } else {
                moveProgrammatically(to: NSPoint(x: visible.midX - size.width / 2, y: visible.minY + 72))
            }
        }
    }

    private func moveProgrammatically(to origin: NSPoint) {
        guard let panel else { return }
        isProgrammaticMove = true
        panel.setFrameOrigin(origin)
        isProgrammaticMove = false
    }

    private func clampToScreen() {
        guard let panel else { return }
        let screen = panel.screen ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        var frame = panel.frame
        if frame.origin.x < visible.minX { frame.origin.x = visible.minX + 8 }
        if frame.origin.y < visible.minY { frame.origin.y = visible.minY + 8 }
        if frame.maxX > visible.maxX { frame.origin.x = visible.maxX - frame.width - 8 }
        if frame.maxY > visible.maxY { frame.origin.y = visible.maxY - frame.height - 8 }
        if frame.origin != panel.frame.origin {
            moveProgrammatically(to: frame.origin)
        }
    }

    // MARK: NSWindowDelegate

    func windowDidMove(_ notification: Notification) {
        guard !isProgrammaticMove, let panel, panel.isVisible else { return }
        settings.overlayOrigin = (Double(panel.frame.origin.x), Double(panel.frame.origin.y))
    }
}

// MARK: - RGBA -> NSColor

extension OverlayRGBA {
    var nsColor: NSColor {
        NSColor(
            calibratedRed: CGFloat(r),
            green: CGFloat(g),
            blue: CGFloat(b),
            alpha: CGFloat(a)
        )
    }
}
