//
//  SettingsWindow.swift
//  livedub macOS 菜单栏 App
//
//  v0.7 设置窗口（独立 NSWindow，从菜单「设置…」打开）：
//   字幕（字号 22–26 / 显示模式）、浮层（宽度 / 位置 / 透明度 / 点击穿透）、
//   音频（中文配音）、笔记与视觉（附截图 / OCR / VLM / 画面上下文）、引擎地址（只读）。
//   所有改动即时生效并持久化；「恢复默认」仅重置呈现相关项；Esc 关闭。
//

import AppKit

/// Esc 关闭设置窗口
final class SettingsWindow: NSWindow {
    override func cancelOperation(_ sender: Any?) {
        performClose(nil)
    }
}

final class SettingsWindowController: NSObject, NSWindowDelegate {
    /// 任意设置变更后通知 App（刷新浮层/菜单/定时器）
    var onChange: (() -> Void)?
    var onOpenPermission: (() -> Void)?
    var onDiagnostics: (() -> Void)?

    private let settings: Settings
    private var window: SettingsWindow?

    private var fontSlider: NSSlider!
    private var fontValueLabel: NSTextField!
    private var captionPopup: NSPopUpButton!
    private var autoWidthCheckbox: NSButton!
    private var widthSlider: NSSlider!
    private var widthValueLabel: NSTextField!
    private var positionPopup: NSPopUpButton!
    private var opacitySlider: NSSlider!
    private var opacityValueLabel: NSTextField!
    private var clickThroughCheckbox: NSButton!
    private var dubCheckbox: NSButton!
    private var screenshotCheckbox: NSButton!
    private var ocrCheckbox: NSButton!
    private var vlmCheckbox: NSButton!
    private var visualContextCheckbox: NSButton!
    private var engineURLField: NSTextField!

    init(settings: Settings) {
        self.settings = settings
        super.init()
    }

    // MARK: 显示

    func show() {
        let window = ensureWindow()
        refreshControls()
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func close() {
        window?.performClose(nil)
    }

    // MARK: 构建窗口

    private func ensureWindow() -> SettingsWindow {
        if let window { return window }
        let window = SettingsWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 700),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "livedub 设置"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.delegate = self
        window.isReleasedWhenClosed = false

        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 6
        root.edgeInsets = NSEdgeInsets(top: 18, left: 22, bottom: 18, right: 22)
        root.translatesAutoresizingMaskIntoConstraints = false

        // 标题
        let title = NSTextField(labelWithString: "livedub 设置")
        title.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        root.addArrangedSubview(title)
        let subtitle = NSTextField(labelWithString: "改动即时生效并保存；Esc 关闭。视觉/笔记能力需要引擎 v0.5+。")
        subtitle.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        subtitle.textColor = .secondaryLabelColor
        root.addArrangedSubview(subtitle)

        // ---- 字幕 ----
        root.addArrangedSubview(sectionTitle("字幕"))
        fontSlider = NSSlider(value: settings.fontSize, minValue: 22, maxValue: 26, target: self, action: #selector(fontChanged))
        fontSlider.numberOfTickMarks = 5
        fontSlider.allowsTickMarkValuesOnly = true
        fontSlider.controlSize = .regular
        fontSlider.widthAnchor.constraint(equalToConstant: 280).isActive = true
        fontSlider.setAccessibilityLabel("译文字号")
        fontValueLabel = valueLabel("\(Int(settings.fontSize)) pt")
        root.addArrangedSubview(row("字号", control: fontSlider, value: fontValueLabel, description: "译文 22–26pt semibold；原文会按比例缩小"))

        captionPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        for mode in CaptionMode.allCases {
            captionPopup.addItem(withTitle: mode.label)
        }
        captionPopup.target = self
        captionPopup.action = #selector(captionModeChanged)
        captionPopup.setAccessibilityLabel("字幕显示模式")
        root.addArrangedSubview(row("显示", control: captionPopup, description: "双语时原文在译文下方；仅原文适合练听力"))

        // ---- 浮层 ----
        root.addArrangedSubview(sectionTitle("浮层"))
        autoWidthCheckbox = NSButton(checkboxWithTitle: "自动", target: self, action: #selector(autoWidthChanged))
        root.addArrangedSubview(rowStack(title: "宽度", control: widthControls(), description: "默认 760pt；自动时 22pt≈680 / 24pt≈760 / 26pt≈840"))

        positionPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        for mode in OverlayPositionMode.allCases {
            positionPopup.addItem(withTitle: mode.label)
        }
        positionPopup.target = self
        positionPopup.action = #selector(positionChanged)
        positionPopup.setAccessibilityLabel("浮层位置")
        root.addArrangedSubview(row("位置", control: positionPopup, description: "拖动浮层后选择「记住上次位置」可固定记忆"))

        opacitySlider = NSSlider(value: settings.overlayOpacity, minValue: 0.55, maxValue: 1.0, target: self, action: #selector(opacityChanged))
        opacitySlider.isContinuous = true
        opacitySlider.widthAnchor.constraint(equalToConstant: 300).isActive = true
        opacitySlider.setAccessibilityLabel("浮层透明度")
        opacityValueLabel = valueLabel("\(Int(settings.overlayOpacity * 100))%")
        root.addArrangedSubview(row("不透明度", control: opacitySlider, value: opacityValueLabel, description: "系统降低透明度/减少动态时自动降级纯色与关闭动效"))

        clickThroughCheckbox = NSButton(checkboxWithTitle: "点击穿透（浮层不可拖动）", target: self, action: #selector(clickThroughChanged))
        root.addArrangedSubview(row("交互", control: clickThroughCheckbox))

        // ---- 音频 ----
        root.addArrangedSubview(sectionTitle("音频"))
        dubCheckbox = NSButton(checkboxWithTitle: "播放中文配音", target: self, action: #selector(dubChanged))
        root.addArrangedSubview(row("配音", control: dubCheckbox, description: "系统原声不会被自动压低：配音与原声会同时存在（已知限制）"))

        // ---- 笔记与视觉 ----
        root.addArrangedSubview(sectionTitle("笔记与视觉（⌥N / 画面上下文）"))
        screenshotCheckbox = NSButton(checkboxWithTitle: "记笔记时附截图", target: self, action: #selector(notesChanged))
        root.addArrangedSubview(row("截图", control: screenshotCheckbox))
        ocrCheckbox = NSButton(checkboxWithTitle: "识别画面文字（OCR，快）", target: self, action: #selector(notesChanged))
        root.addArrangedSubview(row("OCR", control: ocrCheckbox))
        vlmCheckbox = NSButton(checkboxWithTitle: "画面理解（VLM，慢，约 20–30s）", target: self, action: #selector(notesChanged))
        root.addArrangedSubview(row("VLM", control: vlmCheckbox, description: "默认关；可能调用云端 provider 并产生费用"))
        visualContextCheckbox = NSButton(checkboxWithTitle: "翻译参考画面文字（每 10s 推送）", target: self, action: #selector(visualContextChanged))
        root.addArrangedSubview(row("画面上下文", control: visualContextCheckbox, description: "默认关；直播时每 10s 截屏 OCR 推给引擎，注意 CPU 与画面隐私"))

        // ---- 引擎 ----
        root.addArrangedSubview(sectionTitle("引擎"))
        engineURLField = NSTextField(labelWithString: settings.engineURL)
        engineURLField.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        engineURLField.textColor = .secondaryLabelColor
        engineURLField.lineBreakMode = .byTruncatingMiddle
        engineURLField.setAccessibilityLabel("引擎地址（只读）")
        root.addArrangedSubview(row("地址", control: engineURLField, description: "只读：在菜单栏「设置引擎地址…」或配置文件中修改"))

        let linkRow = NSStackView()
        linkRow.orientation = .horizontal
        linkRow.spacing = 8
        let permissionButton = NSButton(title: "屏幕录制权限…", target: self, action: #selector(openPermission))
        permissionButton.bezelStyle = .rounded
        permissionButton.setAccessibilityLabel("打开屏幕录制权限设置")
        let diagnosticsButton = NSButton(title: "诊断信息…", target: self, action: #selector(openDiagnostics))
        diagnosticsButton.bezelStyle = .rounded
        diagnosticsButton.setAccessibilityLabel("查看诊断信息")
        linkRow.addArrangedSubview(permissionButton)
        linkRow.addArrangedSubview(diagnosticsButton)
        root.addArrangedSubview(linkRow)

        // ---- 底部按钮 ----
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let resetButton = NSButton(title: "恢复默认", target: self, action: #selector(resetDefaults))
        resetButton.bezelStyle = .rounded
        resetButton.setAccessibilityLabel("恢复默认外观设置")
        let closeButton = NSButton(title: "关闭", target: self, action: #selector(closeWindow))
        closeButton.bezelStyle = .rounded
        closeButton.keyEquivalent = "\u{1b}" // Esc
        closeButton.setAccessibilityLabel("关闭设置窗口")
        let footer = NSStackView(views: [resetButton, spacer, closeButton])
        footer.orientation = .horizontal
        footer.spacing = 8
        footer.distribution = .fill
        footer.translatesAutoresizingMaskIntoConstraints = false
        root.addArrangedSubview(footer)
        footer.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -44).isActive = true

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = root

        let content = NSView()
        content.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: content.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            root.widthAnchor.constraint(equalToConstant: 560),
        ])
        window.contentView = content
        self.window = window
        return window
    }

    // MARK: 控件工厂

    private func sectionTitle(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        label.textColor = .labelColor
        return label
    }

    private func valueLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        label.textColor = .secondaryLabelColor
        label.alignment = .right
        label.widthAnchor.constraint(equalToConstant: 56).isActive = true
        return label
    }

    private func row(_ title: String, control: NSView, value: NSTextField? = nil, description: String? = nil) -> NSStackView {
        rowStack(title: title, control: control, value: value, description: description)
    }

    private func rowStack(title: String, control: NSView, value: NSTextField? = nil, description: String? = nil) -> NSStackView {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        titleLabel.textColor = .secondaryLabelColor
        titleLabel.widthAnchor.constraint(equalToConstant: 72).isActive = true

        let controlRow = NSStackView()
        controlRow.orientation = .horizontal
        controlRow.spacing = 8
        controlRow.alignment = .centerY
        controlRow.addArrangedSubview(titleLabel)
        controlRow.addArrangedSubview(control)
        if let value {
            controlRow.addArrangedSubview(value)
        }
        controlRow.addArrangedSubview(NSView())

        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 2
        column.addArrangedSubview(controlRow)
        if let description {
            let desc = NSTextField(wrappingLabelWithString: description)
            desc.font = NSFont.systemFont(ofSize: 10.5, weight: .regular)
            desc.textColor = .tertiaryLabelColor
            desc.maximumNumberOfLines = 2
            desc.widthAnchor.constraint(equalToConstant: 490).isActive = true
            column.addArrangedSubview(desc)
        }
        return column
    }

    private func widthControls() -> NSView {
        widthSlider = NSSlider(value: settings.overlayWidth > 0 ? settings.overlayWidth : OverlayDesign.widthDefaultAuto,
                               minValue: OverlayDesign.widthMin,
                               maxValue: OverlayDesign.widthMax,
                               target: self,
                               action: #selector(widthChanged))
        widthSlider.isContinuous = true
        widthSlider.widthAnchor.constraint(equalToConstant: 240).isActive = true
        widthSlider.setAccessibilityLabel("浮层宽度")
        widthValueLabel = valueLabel("\(Int(settings.overlayWidth > 0 ? settings.overlayWidth : OverlayDesign.widthDefaultAuto)) pt")
        let stack = NSStackView(views: [widthSlider, widthValueLabel, autoWidthCheckbox])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.alignment = .centerY
        return stack
    }

    // MARK: 同步控件

    private func refreshControls() {
        fontSlider.doubleValue = settings.fontSize
        fontValueLabel.stringValue = "\(Int(settings.fontSize)) pt"
        let captionIndex = CaptionMode.allCases.firstIndex(of: settings.captionMode) ?? 0
        captionPopup.selectItem(at: captionIndex)
        let auto = settings.overlayWidth <= 0
        autoWidthCheckbox.state = auto ? .on : .off
        widthSlider.isEnabled = !auto
        if auto {
            widthSlider.doubleValue = OverlayDesign.widthDefaultAuto
            widthValueLabel.stringValue = "自动"
        } else {
            widthSlider.doubleValue = settings.overlayWidth
            widthValueLabel.stringValue = "\(Int(settings.overlayWidth)) pt"
        }
        let positionIndex = OverlayPositionMode.allCases.firstIndex(of: settings.positionMode) ?? 0
        positionPopup.selectItem(at: positionIndex)
        opacitySlider.doubleValue = settings.overlayOpacity
        opacityValueLabel.stringValue = "\(Int(settings.overlayOpacity * 100))%"
        clickThroughCheckbox.state = settings.clickThrough ? .on : .off
        dubCheckbox.state = settings.dubEnabled ? .on : .off
        screenshotCheckbox.state = settings.notesIncludeScreenshot ? .on : .off
        ocrCheckbox.state = settings.notesOCR ? .on : .off
        vlmCheckbox.state = settings.notesVision ? .on : .off
        visualContextCheckbox.state = settings.visualContextEnabled ? .on : .off
        engineURLField.stringValue = settings.engineURL
    }

    private func notifyChanged() {
        onChange?()
    }

    // MARK: 动作

    @objc private func fontChanged() {
        settings.fontSize = fontSlider.doubleValue
        fontValueLabel.stringValue = "\(Int(settings.fontSize)) pt"
        notifyChanged()
    }

    @objc private func captionModeChanged() {
        let index = max(0, captionPopup.indexOfSelectedItem)
        settings.captionMode = CaptionMode.allCases[min(index, CaptionMode.allCases.count - 1)]
        notifyChanged()
    }

    @objc private func widthChanged() {
        guard autoWidthCheckbox.state != .on else { return }
        settings.overlayWidth = widthSlider.doubleValue
        widthValueLabel.stringValue = "\(Int(settings.overlayWidth)) pt"
        notifyChanged()
    }

    @objc private func autoWidthChanged() {
        if autoWidthCheckbox.state == .on {
            settings.overlayWidth = 0
            widthSlider.isEnabled = false
            widthValueLabel.stringValue = "自动"
        } else {
            widthSlider.isEnabled = true
            settings.overlayWidth = widthSlider.doubleValue
            widthValueLabel.stringValue = "\(Int(settings.overlayWidth)) pt"
        }
        notifyChanged()
    }

    @objc private func positionChanged() {
        let index = max(0, positionPopup.indexOfSelectedItem)
        settings.positionMode = OverlayPositionMode.allCases[min(index, OverlayPositionMode.allCases.count - 1)]
        notifyChanged()
    }

    @objc private func opacityChanged() {
        settings.overlayOpacity = opacitySlider.doubleValue
        opacityValueLabel.stringValue = "\(Int(settings.overlayOpacity * 100))%"
        notifyChanged()
    }

    @objc private func clickThroughChanged() {
        settings.clickThrough = clickThroughCheckbox.state == .on
        notifyChanged()
    }

    @objc private func dubChanged() {
        settings.dubEnabled = dubCheckbox.state == .on
        notifyChanged()
    }

    @objc private func notesChanged() {
        settings.notesIncludeScreenshot = screenshotCheckbox.state == .on
        settings.notesOCR = ocrCheckbox.state == .on
        settings.notesVision = vlmCheckbox.state == .on
        notifyChanged()
    }

    @objc private func visualContextChanged() {
        settings.visualContextEnabled = visualContextCheckbox.state == .on
        notifyChanged()
    }

    @objc private func resetDefaults() {
        settings.resetPresentationDefaults()
        refreshControls()
        notifyChanged()
    }

    @objc private func openPermission() {
        onOpenPermission?()
    }

    @objc private func openDiagnostics() {
        onDiagnostics?()
    }

    @objc private func closeWindow() {
        window?.performClose(nil)
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        // 关闭不销毁，便于再次打开；控件状态在 show() 时刷新
    }
}
