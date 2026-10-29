//
//  OverlayWindow.swift
//  livedub macOS 菜单栏 App
//
//  置顶字幕浮层：无边框透明 NSPanel（不抢焦点、可拖动、可选点击穿透）。
//  内容：译文（大字，最多 2 行）+ 原文（小字，1 行）+ 底行状态/延迟。
//  位置 / 字号 / 点击穿透持久化到 UserDefaults（Settings）。
//

import AppKit

// MARK: - 面板

final class OverlayPanel: NSPanel {
    /// 字幕浮层不抢键盘焦点，避免打断 Zoom / 播放器操作
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - 背景视图

final class OverlayContentView: NSView {
    let translationLabel = NSTextField(wrappingLabelWithString: "")
    let sourceLabel = NSTextField(wrappingLabelWithString: "")
    let statusLabel = NSTextField(wrappingLabelWithString: "")
    let latencyLabel = NSTextField(wrappingLabelWithString: "")

    private let contentInsets = NSEdgeInsets(top: 12, left: 16, bottom: 10, right: 16)
    private let cornerRadius: CGFloat = 14
    private let translationSourceSpacing: CGFloat = 4
    private let sourceStatusSpacing: CGFloat = 6
    private let statusRowHeight: CGFloat = 16

    var translationFontSize: CGFloat = 20 {
        didSet { applyFonts() }
    }
    var showSourceLine = true
    var isErrorState = false {
        didSet { statusLabel.textColor = isErrorState ? .systemRed : NSColor(calibratedWhite: 0.72, alpha: 1) }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        configureLabels()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("OverlayContentView 只支持代码布局")
    }

    override var isOpaque: Bool { false }
    /// 使用左上角原点布局（译文在上、原文在下、状态行最底），手动 frame 更直观
    override var isFlipped: Bool { true }

    private func configureLabels() {
        for label in [translationLabel, sourceLabel, statusLabel, latencyLabel] {
            label.isEditable = false
            label.isSelectable = false
            label.isBordered = false
            label.drawsBackground = false
            label.refusesFirstResponder = true
            label.cell?.wraps = true
            label.cell?.isScrollable = false
            label.translatesAutoresizingMaskIntoConstraints = true
            addSubview(label)
        }
        translationLabel.alignment = .left
        translationLabel.textColor = .white
        sourceLabel.textColor = NSColor(calibratedWhite: 0.86, alpha: 1)
        sourceLabel.maximumNumberOfLines = 1
        statusLabel.textColor = NSColor(calibratedWhite: 0.72, alpha: 1)
        statusLabel.maximumNumberOfLines = 1
        latencyLabel.textColor = NSColor(calibratedWhite: 0.72, alpha: 1)
        latencyLabel.alignment = .right
        latencyLabel.maximumNumberOfLines = 1
        statusLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        latencyLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        applyFonts()
    }

    private func applyFonts() {
        translationLabel.font = NSFont.systemFont(ofSize: translationFontSize, weight: .semibold)
        translationLabel.maximumNumberOfLines = 2
        translationLabel.lineBreakMode = .byTruncatingTail
        sourceLabel.font = NSFont.systemFont(ofSize: max(11, translationFontSize * 0.66), weight: .regular)
        sourceLabel.lineBreakMode = .byTruncatingTail
        needsLayout = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let rect = bounds.insetBy(dx: 1, dy: 1)
        guard rect.width > 4, rect.height > 4 else { return }
        let path = NSBezierPath(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius)
        NSColor.black.withAlphaComponent(0.62).setFill()
        path.fill()
        NSColor.white.withAlphaComponent(0.14).setStroke()
        path.lineWidth = 1
        path.stroke()

        let separator = NSBezierPath()
        separator.move(to: NSPoint(x: rect.minX + contentInsets.left, y: bounds.height - contentInsets.bottom - statusRowHeight - sourceStatusSpacing / 2))
        separator.line(to: NSPoint(x: rect.maxX - contentInsets.right, y: bounds.height - contentInsets.bottom - statusRowHeight - sourceStatusSpacing / 2))
        NSColor.white.withAlphaComponent(0.08).setStroke()
        separator.lineWidth = 1
        separator.stroke()
    }

    // MARK: 布局

    /// 给定面板宽度，返回内容需要的总高度。
    func desiredHeight(forWidth width: CGFloat) -> CGFloat {
        let available = max(80, width - contentInsets.left - contentInsets.right)
        var height = contentInsets.top + contentInsets.bottom
        height += labelHeight(translationLabel, width: available, maxLines: 2)
        if showSourceLine && !sourceLabel.isHidden {
            height += translationSourceSpacing
            height += labelHeight(sourceLabel, width: available, maxLines: 1)
        }
        height += sourceStatusSpacing
        height += statusRowHeight
        return ceil(max(72, height))
    }

    override func layout() {
        super.layout()
        let available = max(80, bounds.width - contentInsets.left - contentInsets.right)
        var y = contentInsets.top

        let translationHeight = labelHeight(translationLabel, width: available, maxLines: 2)
        translationLabel.frame = NSRect(x: contentInsets.left, y: y, width: available, height: translationHeight)
        y += translationHeight

        sourceLabel.isHidden = !showSourceLine || sourceLabel.stringValue.isEmpty
        if !sourceLabel.isHidden {
            y += translationSourceSpacing
            let sourceHeight = labelHeight(sourceLabel, width: available, maxLines: 1)
            sourceLabel.frame = NSRect(x: contentInsets.left, y: y, width: available, height: sourceHeight)
            y += sourceHeight
        } else {
            sourceLabel.frame = .zero
        }

        y += sourceStatusSpacing
        let statusWidth = max(60, available * 0.72)
        statusLabel.frame = NSRect(x: contentInsets.left, y: y, width: statusWidth, height: statusRowHeight)
        latencyLabel.frame = NSRect(
            x: contentInsets.left + statusWidth + 8,
            y: y,
            width: max(40, available - statusWidth - 8),
            height: statusRowHeight
        )
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

    /// 整个浮层都是拖动热区：命中测试直接返回内容视图，避免 NSTextField 吞掉鼠标事件。
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, alphaValue > 0, window != nil else { return nil }
        return bounds.contains(point) ? self : nil
    }

    /// 拖动整个浮层（配合 NSPanel.isMovableByWindowBackground；点击穿透开启时由 NSPanel.ignoresMouseEvents 处理）。
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

// MARK: - 浮层控制器

final class OverlayController: NSObject, NSWindowDelegate {
    var onVisibilityChanged: ((Bool) -> Void)?
    var onLog: ((String) -> Void)?

    private let settings: Settings
    private var panel: OverlayPanel?
    private var content: OverlayContentView?
    private var currentTranslation = ""
    private var currentSource = ""
    private var currentStatus = "未开始"
    private var currentLatencyMs: Double?
    private var isProgrammaticMove = false
    private var lastWidth: CGFloat = 0

    init(settings: Settings) {
        self.settings = settings
        super.init()
    }

    var isVisible: Bool { panel?.isVisible ?? false }

    // MARK: 显示/隐藏

    func show() {
        let panel = ensurePanel()
        if !settings.hasOverlayOrigin {
            moveProgrammatically(to: defaultOrigin(for: panel.frame.size))
        } else {
            var frame = panel.frame
            frame.origin = NSPoint(x: settings.overlayOrigin.x, y: settings.overlayOrigin.y)
            moveProgrammatically(to: frame.origin)
        }
        clampToScreen()
        panel.orderFrontRegardless()
        onVisibilityChanged?(true)
    }

    func hide() {
        panel?.orderOut(nil)
        onVisibilityChanged?(false)
    }

    func toggle() {
        if isVisible { hide() } else { show() }
    }

    func resetPosition() {
        guard let panel else { return }
        settings.clearOverlayOrigin()
        moveProgrammatically(to: defaultOrigin(for: panel.frame.size))
        clampToScreen()
    }

    func reloadFromSettings() {
        guard let panel else { return }
        panel.ignoresMouseEvents = settings.clickThrough
        panel.level = settings.alwaysOnTop ? .floating : .normal
        content?.translationFontSize = CGFloat(settings.fontSize)
        content?.showSourceLine = settings.showSourceLine
        render()
    }

    // MARK: 内容更新

    func setCaption(translation: String, source: String) {
        currentTranslation = translation
        currentSource = source
        render()
    }

    func setStatus(_ status: String, latencyMs: Double?, isError: Bool = false) {
        currentStatus = status
        currentLatencyMs = latencyMs
        content?.isErrorState = isError
        render(statusOnly: false)
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
            contentRect: NSRect(x: 0, y: 0, width: width, height: 110),
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

        let content = OverlayContentView(frame: NSRect(x: 0, y: 0, width: width, height: 110))
        content.autoresizingMask = [.width, .height]
        content.translationFontSize = CGFloat(settings.fontSize)
        content.showSourceLine = settings.showSourceLine
        panel.contentView = content
        self.panel = panel
        self.content = content
        lastWidth = width
        render()
        return panel
    }

    private func render(statusOnly: Bool = false) {
        guard let content else { return }
        let hasCaption = !currentTranslation.isEmpty || !currentSource.isEmpty
        // 已有原文、译文还在路上时留空行（不要把「等待字幕」盖在原文上面）
        content.translationLabel.stringValue = currentTranslation.isEmpty
            ? (hasCaption ? "" : "livedub · 等待字幕")
            : currentTranslation
        content.translationLabel.alphaValue = currentTranslation.isEmpty ? 0.55 : 1.0
        content.sourceLabel.stringValue = currentSource
        content.sourceLabel.isHidden = !settings.showSourceLine || currentSource.isEmpty
        content.statusLabel.stringValue = currentStatus
        content.latencyLabel.stringValue = "延迟 " + CaptionLayout.formatLatency(currentLatencyMs)
        content.latencyLabel.textColor = {
            if let ms = currentLatencyMs, ms > 3_000 { return NSColor.systemOrange }
            return NSColor(calibratedWhite: 0.72, alpha: 1)
        }()
        content.needsLayout = true
        content.layoutSubtreeIfNeeded()

        guard let panel else { return }
        let width = panelWidth()
        let height = content.desiredHeight(forWidth: width)
        guard isVisible || panel.frame.width > 0 else { return }
        var frame = panel.frame
        frame.size = NSSize(width: width, height: height)
        isProgrammaticMove = true
        panel.setFrame(frame, display: true)
        isProgrammaticMove = false
        content.frame = NSRect(origin: .zero, size: frame.size)
        content.layoutSubtreeIfNeeded()
        lastWidth = width
    }

    private func panelWidth() -> CGFloat {
        let screenWidth = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame.width ?? 1_440
        return max(480, min(920, screenWidth * 0.62))
    }

    private func defaultOrigin(for size: NSSize) -> NSPoint {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let x = visible.midX - size.width / 2
        let y = visible.minY + 72
        return NSPoint(x: x, y: y)
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
        onLog?("[overlay] 位置已保存 (\(Int(panel.frame.origin.x)), \(Int(panel.frame.origin.y)))")
    }
}
