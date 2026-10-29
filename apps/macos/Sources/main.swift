//
//  main.swift
//  livedub macOS 菜单栏 App
//
//  形态：LSUIElement 菜单栏 App（无 Dock 图标），抓取系统/应用音频（ScreenCaptureKit）
//        -> 本地 livedub 引擎（ws://127.0.0.1:8787/ws）
//        -> 置顶双语字幕浮层 + 中文配音。
//
//  入口参数：
//    --self-test             headless 自检（不建窗口、不请求权限、不联网），退出码 0/1
//    --simulate              不抓音频/不连引擎，循环演示字幕/状态/延迟（无权限环境验证 UI）
//    --duration <秒>         自动退出（调试/冒烟用）
//    --engine-url <url>      覆盖引擎地址
//    -h, --help              帮助
//

import AppKit
import Foundation

// MARK: - 启动参数

struct LaunchOptions {
    var selfTest = false
    var simulate = false
    var autoStart = false
    var duration: Double?
    var engineURL: String?
    var help = false

    static let helpText = """
    livedub macOS 菜单栏 App（ScreenCaptureKit 系统音频 -> 本地引擎 -> 双语字幕 + 中文配音）

    用法：livedub [选项]

      --simulate            不抓音频/不连引擎，循环演示双语字幕、状态与延迟（无权限环境验证 UI）
      --autostart           启动后自动点一次「开始同传」（适合登录项 / 自动化冒烟）
      --duration <秒>       调试用：N 秒后自动退出（配合 --simulate 可做冒烟）
      --engine-url <url>    覆盖引擎地址（默认 ws://127.0.0.1:8787/ws）
      --self-test           headless 自检（协议字节布局 / hello / 事件解析 / 字幕排版），退出码 0/1
      -h, --help            显示本帮助并退出

    正常模式从菜单栏「开始同传」启动；首次使用需在 系统设置 → 隐私与安全性 → 屏幕录制 授权。
    构建：bash scripts/build-macos.sh --check
    """

    static func parse(_ arguments: [String]) -> LaunchOptions {
        var options = LaunchOptions()
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--self-test":
                options.selfTest = true
            case "--simulate":
                options.simulate = true
            case "--autostart":
                options.autoStart = true
            case "-h", "--help":
                options.help = true
            case "--duration":
                if index + 1 < arguments.count, let value = Double(arguments[index + 1]) {
                    options.duration = value
                    index += 1
                }
            case "--engine-url":
                if index + 1 < arguments.count {
                    options.engineURL = arguments[index + 1]
                    index += 1
                }
            default:
                if argument.hasPrefix("--duration="), let value = Double(argument.dropFirst("--duration=".count)) {
                    options.duration = value
                } else if argument.hasPrefix("--engine-url=") {
                    options.engineURL = String(argument.dropFirst("--engine-url=".count))
                }
            }
            index += 1
        }
        return options
    }
}

// MARK: - 入口

let launchOptions = LaunchOptions.parse(Array(CommandLine.arguments.dropFirst()))

if launchOptions.help {
    print(LaunchOptions.helpText)
    exit(0)
}

// 自检必须在 NSApplication / WindowServer 之前：无 GUI 的 CI / SSH 环境也能跑。
if launchOptions.selfTest {
    let failures = SelfTest.run()
    exit(failures.isEmpty ? 0 : 1)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory) // 菜单栏 App：无 Dock 图标（Info.plist 也有 LSUIElement）
let delegate = AppDelegate(options: launchOptions)
application.delegate = delegate
application.run()

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let options: LaunchOptions
    private let settings = Settings.shared

    private var statusItem: NSStatusItem?
    private var menu: NSMenu?
    private var overlay: OverlayController?

    private var engine: EngineClient?
    private var capture: ScreenAudioCapture?
    private var dubPlayer: DubPlayer?

    private var permissionTimer: Timer?
    private var simulateTimer: Timer?
    private var autoQuitTimer: Timer?

    private var isRunning = false
    private var isSimulating = false
    private var simulatePhase = 0
    private var simulateTurnIndex = 0

    private var currentStatus = "未开始"
    private var currentLatencyMs: Double?
    private var currentTranslation = ""
    private var currentSource = ""
    private var lastEngineDetail = ""
    private var permissionAlertVisible = false
    private var logLines: [String] = []

    private var statusMenuItem: NSMenuItem?
    private var engineMenuItem: NSMenuItem?
    private var toggleMenuItem: NSMenuItem?
    private var overlayMenuItem: NSMenuItem?
    private var clickThroughMenuItem: NSMenuItem?
    private var dubMenuItem: NSMenuItem?
    private var sourceLineMenuItem: NSMenuItem?
    private var fontSizeUpMenuItem: NSMenuItem?
    private var fontSizeDownMenuItem: NSMenuItem?

    init(options: LaunchOptions) {
        self.options = options
        super.init()
    }

    // MARK: 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()

        let overlay = OverlayController(settings: settings)
        overlay.onLog = { [weak self] message in self?.log(message) }
        overlay.onVisibilityChanged = { [weak self] _ in self?.refreshMenu() }
        self.overlay = overlay

        if let override = options.engineURL {
            settings.engineURL = override
        }

        setupAutoQuit()

        if options.simulate {
            startSimulation()
        } else if options.autoStart || settings.autoStart {
            startSession()
        }
        refreshMenu()
    }

    func applicationWillTerminate(_ notification: Notification) {
        permissionTimer?.invalidate()
        simulateTimer?.invalidate()
        autoQuitTimer?.invalidate()
        capture?.stop()
        engine?.stop()
        dubPlayer?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // 菜单栏 App：关掉字幕浮层不退出
    }

    // MARK: 菜单栏

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            if let image = NSImage(systemSymbolName: "captions.bubble", accessibilityDescription: "livedub") {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "ld"
            }
            button.toolTip = "livedub · 实时同传（macOS 系统音频）"
        }

        let menu = NSMenu()
        menu.autoenablesItems = false

        statusMenuItem = addMenuItem(to: menu, title: "状态：未开始", action: nil)
        engineMenuItem = addMenuItem(to: menu, title: "引擎：\(settings.engineURL)", action: nil)
        menu.addItem(.separator())

        toggleMenuItem = addMenuItem(to: menu, title: "开始同传", action: #selector(toggleSession))
        overlayMenuItem = addMenuItem(to: menu, title: "显示字幕浮层", action: #selector(toggleOverlay))
        clickThroughMenuItem = addMenuItem(to: menu, title: "字幕点击穿透", action: #selector(toggleClickThrough))
        clickThroughMenuItem?.toolTip = "开启后鼠标事件穿透浮层（可点击下方窗口/播放器），但浮层不能拖动"
        dubMenuItem = addMenuItem(to: menu, title: "播放中文配音", action: #selector(toggleDub))
        dubMenuItem?.toolTip = "关闭后只显示字幕，不播放中文配音"
        sourceLineMenuItem = addMenuItem(to: menu, title: "显示原文行", action: #selector(toggleSourceLine))
        fontSizeUpMenuItem = addMenuItem(to: menu, title: "增大字幕字号", action: #selector(increaseFontSize))
        fontSizeDownMenuItem = addMenuItem(to: menu, title: "减小字幕字号", action: #selector(decreaseFontSize))

        menu.addItem(.separator())
        _ = addMenuItem(to: menu, title: "设置引擎地址…", action: #selector(editEngineURL))
        _ = addMenuItem(to: menu, title: "打开屏幕录制权限设置…", action: #selector(openPermissionSettings))
        _ = addMenuItem(to: menu, title: "重置字幕位置", action: #selector(resetOverlayPosition))
        _ = addMenuItem(to: menu, title: "诊断信息…", action: #selector(showDiagnostics))
        menu.addItem(.separator())
        _ = addMenuItem(to: menu, title: "退出 livedub", action: #selector(quitApp), keyEquivalent: "q")

        self.menu = menu
        item.menu = menu
        statusItem = item
    }

    @discardableResult
    private func addMenuItem(
        to menu: NSMenu,
        title: String,
        action: Selector?,
        keyEquivalent: String = ""
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        item.target = action == nil ? nil : self
        item.isEnabled = action != nil
        if !keyEquivalent.isEmpty {
            item.keyEquivalentModifierMask = [.command]
        }
        menu.addItem(item)
        return item
    }

    private func refreshMenu() {
        guard statusItem != nil else { return }
        statusMenuItem?.title = "状态：\(currentStatus)"
        engineMenuItem?.title = "引擎：\(settings.engineURL)"
        toggleMenuItem?.title = isSimulating ? "停止模拟演示" : (isRunning ? "停止同传" : "开始同传")
        overlayMenuItem?.title = overlay?.isVisible == true ? "隐藏字幕浮层" : "显示字幕浮层"
        overlayMenuItem?.state = overlay?.isVisible == true ? .on : .off
        clickThroughMenuItem?.state = settings.clickThrough ? .on : .off
        dubMenuItem?.state = settings.dubEnabled ? .on : .off
        sourceLineMenuItem?.state = settings.showSourceLine ? .on : .off
        fontSizeUpMenuItem?.isEnabled = settings.fontSize < 40
        fontSizeDownMenuItem?.isEnabled = settings.fontSize > 11
    }

    // MARK: 开始/停止

    @objc private func toggleSession() {
        if isSimulating {
            stopSimulation()
            return
        }
        if isRunning {
            stopSession()
        } else {
            startSession()
        }
    }

    private func startSession() {
        guard !isRunning else { return }
        isRunning = true
        currentStatus = "连接引擎…"
        currentLatencyMs = nil
        currentTranslation = ""
        currentSource = ""
        overlay?.show()
        overlay?.setPlaceholder("正在连接引擎…")
        overlay?.setStatus("连接引擎…", latencyMs: nil)

        let dub = DubPlayer()
        dub.onLog = { [weak self] message in self?.log(message) }
        dub.setEnabled(settings.dubEnabled)
        dubPlayer = dub

        connectEngine()
        prepareCapture()
        refreshMenu()
    }

    private func connectEngine() {
        guard let url = URL(string: settings.engineURL) else {
            showNotice(title: "引擎地址无效", message: "当前地址：\(settings.engineURL)。请从菜单栏「设置引擎地址…」改成 ws://127.0.0.1:8787/ws。")
            return
        }
        let options = HelloOptions(
            source: "macos",
            title: "macOS 系统音频 · livedub app",
            url: "",
            langFrom: settings.langFrom,
            langTo: settings.langTo
        )
        let client = EngineClient(engineURL: url, helloOptions: options)
        client.onStateChange = { [weak self] state in self?.handleConnectionState(state) }
        client.onEvent = { [weak self] event in self?.handleEvent(event) }
        client.onLog = { [weak self] message in self?.log(message) }
        engine = client
        client.start()
    }

    private func prepareCapture() {
        if ScreenAudioCapture.hasPermission() {
            beginCapture()
            return
        }
        currentStatus = "等待屏幕录制权限"
        overlay?.setStatus("等待屏幕录制权限 · 请在系统设置中授权", latencyMs: nil)
        refreshMenu()

        if ScreenAudioCapture.requestPermission() {
            beginCapture()
            return
        }
        showPermissionAlert()
        startPermissionPolling()
    }

    private func startPermissionPolling() {
        permissionTimer?.invalidate()
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            guard let self else { return }
            guard self.isRunning else {
                timer.invalidate()
                self.permissionTimer = nil
                return
            }
            if ScreenAudioCapture.hasPermission() {
                timer.invalidate()
                self.permissionTimer = nil
                self.log("[capture] 已获得屏幕录制权限，开始音频捕获")
                self.beginCapture()
            }
        }
    }

    private func beginCapture() {
        permissionTimer?.invalidate()
        permissionTimer = nil
        guard capture == nil else { return }

        let capture = ScreenAudioCapture()
        capture.onAudioFrame = { [weak self] tMs, samples in
            self?.engine?.sendAudioFrame(tMs: tMs, samples: samples)
        }
        capture.onLog = { [weak self] message in self?.log(message) }
        capture.onError = { [weak self] error in self?.handleCaptureError(error) }
        self.capture = capture

        currentStatus = "启动系统音频捕获…"
        overlay?.setStatus("启动系统音频捕获…", latencyMs: nil)
        refreshMenu()

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await capture.start()
                guard self.capture === capture else { return }
                self.dubPlayer?.setSessionStartUptime(capture.sessionStartHostTime)
                self.currentStatus = "聆听中"
                self.overlay?.setStatus("已连接 · 聆听中", latencyMs: self.currentLatencyMs)
                self.refreshMenu()
            } catch {
                self.handleCaptureError(error)
            }
        }
    }

    private func stopSession() {
        guard isRunning else { return }
        isRunning = false
        permissionTimer?.invalidate()
        permissionTimer = nil
        capture?.stop()
        capture = nil
        engine?.stop()
        engine = nil
        dubPlayer?.stop()
        dubPlayer = nil
        currentStatus = "已停止"
        currentLatencyMs = nil
        currentTranslation = ""
        currentSource = ""
        overlay?.setPlaceholder("已停止 · 从菜单栏「开始同传」继续")
        overlay?.setStatus("已停止", latencyMs: nil)
        refreshMenu()
        log("[app] 已停止同传")
    }

    // MARK: 引擎事件

    private func handleConnectionState(_ state: EngineConnectionState) {
        guard !isSimulating else { return }
        switch state {
        case .connecting:
            currentStatus = "连接引擎…"
            overlay?.setStatus("连接引擎…", latencyMs: nil)
        case .reconnecting:
            currentStatus = "重连引擎…"
            overlay?.setStatus("引擎重连中…", latencyMs: nil)
        case .connected:
            currentStatus = "已连接 · 等待音频"
            overlay?.setStatus("已连接 · 聆听中", latencyMs: currentLatencyMs)
        case .disconnected:
            if isRunning {
                currentStatus = "引擎未连接"
                overlay?.setStatus("引擎未连接 · 请确认 npm start 已运行", latencyMs: nil)
            } else {
                currentStatus = "未连接"
            }
        case .failed:
            currentStatus = "连接失败"
            overlay?.setStatus("引擎连接失败 · 检查地址与 npm start", latencyMs: nil, isError: true)
        }
        refreshMenu()
    }

    private func handleEvent(_ event: EngineEvent) {
        guard !isSimulating else { return }
        switch event {
        case let .ready(sessionId, _, providers, voiceMode, voiceId):
            lastEngineDetail = "session=\(sessionId.prefix(8)) asr=\(providers["asr"] ?? "?") mt=\(providers["translate"] ?? "?") tts=\(providers["tts"] ?? "?") voice=\(voiceMode)/\(voiceId)"
            log("[engine] ready \(lastEngineDetail)")
            currentStatus = "聆听中"
            let voiceLabel = voiceMode == "clone" ? "克隆音色" : "预设音色"
            overlay?.setStatus("已连接 · \(voiceLabel)", latencyMs: currentLatencyMs)
        case let .status(state, detail, _):
            if state == "error" {
                currentStatus = "引擎错误"
                overlay?.setStatus("引擎错误\(detail.map { "：\($0)" } ?? "")", latencyMs: currentLatencyMs, isError: true)
            } else {
                currentStatus = CaptionLayout.statusLabel(state)
                if let detail, !detail.isEmpty { lastEngineDetail = detail }
                overlay?.setStatus(currentStatus, latencyMs: currentLatencyMs)
            }
        case let .partial(_, text):
            currentSource = text
            overlay?.setCaption(translation: currentTranslation, source: text)
        case let .segment(_, text, _):
            currentSource = text
            overlay?.setCaption(translation: currentTranslation, source: text)
        case let .translation(_, text, _):
            currentTranslation = text
            overlay?.setCaption(translation: text, source: currentSource)
        case let .dub(chunk):
            if settings.dubEnabled {
                dubPlayer?.enqueue(chunk)
            }
        case let .metrics(_, e2eLagMs, _, _, _, _):
            if let e2eLagMs { currentLatencyMs = e2eLagMs }
            overlay?.setStatus(currentStatus, latencyMs: currentLatencyMs)
        case let .voice(mode, voiceId, degraded, reason):
            lastEngineDetail = "voice=\(mode)/\(voiceId)" + (degraded ? "（降级：\(reason ?? "原因未知")）" : "")
            log("[engine] \(lastEngineDetail)")
            if degraded {
                overlay?.setStatus("音色降级：\(reason ?? "原因未知")", latencyMs: currentLatencyMs)
            }
        case let .error(scope, message, recoverable):
            log("[engine][\(scope)] \(message)")
            currentStatus = "\(scope) 错误"
            overlay?.setStatus("\(scope) 错误：\(message)", latencyMs: currentLatencyMs, isError: true)
            if !recoverable {
                showNotice(title: "引擎会话结束", message: message)
            }
        case let .bye(reason):
            log("[engine] bye：\(reason)")
            currentStatus = "引擎关闭会话"
            overlay?.setStatus("引擎关闭会话：\(reason)", latencyMs: nil)
        case .pong, .unknown:
            break
        }
        refreshMenu()
    }

    private func handleCaptureError(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        log("[capture] \(message)")
        currentStatus = "音频捕获失败"
        overlay?.setStatus("音频捕获失败：\(String(message.prefix(60)))", latencyMs: nil, isError: true)
        if message.contains("屏幕录制") || message.contains("权限") {
            showPermissionAlert()
            if isRunning { startPermissionPolling() }
        } else {
            showNotice(title: "无法开始音频捕获", message: message)
        }
        refreshMenu()
    }

    // MARK: 模拟演示（--simulate）

    private func startSimulation() {
        guard !isSimulating else { return }
        isSimulating = true
        isRunning = false
        simulatePhase = 0
        simulateTurnIndex = 0
        overlay?.show()
        applySimulationStep()

        simulateTimer?.invalidate()
        simulateTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.simulatePhase += 1
            self.applySimulationStep()
        }
        refreshMenu()
        log("[app] 模拟演示已启动（不抓音频、不连引擎）")
    }

    private func applySimulationStep() {
        let turns = SimulatedSession.turns
        guard !turns.isEmpty else { return }
        let turn = turns[simulateTurnIndex % turns.count]
        let phase = simulatePhase % 2

        if phase == 0 {
            // 阶段 A：原文已出，正在翻译
            currentSource = turn.en
            currentTranslation = ""
            currentStatus = "翻译中"
            overlay?.setCaption(translation: "", source: turn.en)
            overlay?.setStatus("模拟演示 · 翻译中", latencyMs: nil)
        } else {
            // 阶段 B：译文/延迟就绪（配音在真实模式下由引擎事件驱动）
            currentTranslation = turn.zh
            currentSource = turn.en
            let latency = Double.random(in: 1_100...2_600)
            currentLatencyMs = latency
            currentStatus = "播放配音"
            overlay?.setCaption(translation: turn.zh, source: turn.en)
            overlay?.setStatus("模拟演示 · 播放配音", latencyMs: latency)
            simulateTurnIndex += 1
        }
        refreshMenu()
    }

    private func stopSimulation() {
        isSimulating = false
        simulateTimer?.invalidate()
        simulateTimer = nil
        currentStatus = "已停止"
        currentLatencyMs = nil
        currentTranslation = ""
        currentSource = ""
        overlay?.setPlaceholder("已停止 · 从菜单栏「开始同传」继续")
        overlay?.setStatus("已停止", latencyMs: nil)
        refreshMenu()
        log("[app] 模拟演示已停止")
    }

    private func setupAutoQuit() {
        guard let duration = options.duration, duration > 0 else { return }
        autoQuitTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { _ in
            NSApp.terminate(nil)
        }
        log("[app] \(String(format: "%.0f", duration))s 后自动退出（--duration）")
    }

    // MARK: 菜单动作

    @objc private func toggleOverlay() {
        guard let overlay else { return }
        overlay.toggle()
        refreshMenu()
    }

    @objc private func toggleClickThrough() {
        settings.clickThrough.toggle()
        overlay?.reloadFromSettings()
        log("[app] 点击穿透 = \(settings.clickThrough ? "开（浮层不可拖动）" : "关")")
        refreshMenu()
    }

    @objc private func toggleDub() {
        settings.dubEnabled.toggle()
        dubPlayer?.setEnabled(settings.dubEnabled)
        log("[app] 中文配音 = \(settings.dubEnabled ? "开" : "关")")
        refreshMenu()
    }

    @objc private func toggleSourceLine() {
        settings.showSourceLine.toggle()
        overlay?.reloadFromSettings()
        refreshMenu()
    }

    @objc private func increaseFontSize() {
        setFontSize(settings.fontSize + 2)
    }

    @objc private func decreaseFontSize() {
        setFontSize(settings.fontSize - 2)
    }

    private func setFontSize(_ value: Double) {
        settings.fontSize = value
        overlay?.reloadFromSettings()
        overlay?.show()
        log("[app] 字幕字号 = \(Int(settings.fontSize))pt")
        refreshMenu()
    }

    @objc private func resetOverlayPosition() {
        overlay?.resetPosition()
        overlay?.show()
        refreshMenu()
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    @objc private func openPermissionSettings() {
        openScreenRecordingSettings()
    }

    private func openScreenRecordingSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
        ]
        for candidate in candidates {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                return
            }
        }
        showNotice(title: "请手动打开系统设置", message: "系统设置 → 隐私与安全性 → 屏幕录制 → 勾选 livedub。")
    }

    @objc private func editEngineURL() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "引擎 WebSocket 地址"
        alert.informativeText = "默认 ws://127.0.0.1:8787/ws。保存后若正在同传会立即重连引擎。"
        alert.addButton(withTitle: "保存并重连")
        alert.addButton(withTitle: "取消")
        let field = NSTextField(string: settings.engineURL)
        field.frame = NSRect(x: 0, y: 0, width: 340, height: 24)
        alert.accessoryView = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        settings.engineURL = field.stringValue
        log("[app] 引擎地址改为 \(settings.engineURL)")
        refreshMenu()
        if isRunning {
            engine?.stop()
            engine = nil
            connectEngine()
        }
    }

    @objc private func showDiagnostics() {
        NSApp.activate(ignoringOtherApps: true)
        var lines: [String] = []
        lines.append("livedub macOS app（v0.3）")
        lines.append("状态：\(currentStatus)")
        lines.append("引擎地址：\(settings.engineURL)")
        if let engine {
            let stats = engine.stats
            lines.append("连接：\(stats.state.displayText) · 丢帧 \(stats.droppedAudioFrames)")
            if let error = stats.lastError { lines.append("最近错误：\(error)") }
        } else {
            lines.append("连接：未启动")
        }
        if let capture {
            lines.append("音频捕获：\(capture.capturedFrames) 帧（100ms/帧）")
        } else {
            lines.append("音频捕获：未启动")
        }
        if let dubPlayer {
            lines.append("配音：played=\(dubPlayer.playedChunks) skipped=\(dubPlayer.skippedChunks) enabled=\(dubPlayer.isEnabled)")
            if let error = dubPlayer.lastError { lines.append("配音错误：\(error)") }
        }
        if !lastEngineDetail.isEmpty { lines.append("引擎详情：\(lastEngineDetail)") }
        lines.append("")
        lines.append("最近日志：")
        lines.append(contentsOf: logLines.suffix(12))
        let text = lines.joined(separator: "\n")

        let alert = NSAlert()
        alert.messageText = "诊断信息"
        alert.informativeText = String(text.prefix(3_000))
        alert.addButton(withTitle: "复制")
        alert.addButton(withTitle: "关闭")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            log("[app] 诊断信息已复制到剪贴板")
        }
    }

    // MARK: 提示 / 日志

    private func showPermissionAlert() {
        guard !permissionAlertVisible else { return }
        permissionAlertVisible = true
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "需要「屏幕录制」权限才能捕获系统音频"
        alert.informativeText = """
        macOS 用「屏幕录制」权限管控系统音频捕获。livedub 只读取音频流，不截屏、不保存画面。

        打开：系统设置 → 隐私与安全性 → 屏幕录制 → 勾选 livedub（从终端启动时勾选终端 App）。
        授权后回到菜单栏 livedub → 开始同传。若仍失败，退出并重新打开 livedub。
        """
        alert.addButton(withTitle: "打开系统设置")
        alert.addButton(withTitle: "稍后")
        if alert.runModal() == .alertFirstButtonReturn {
            openScreenRecordingSettings()
        }
        permissionAlertVisible = false
    }

    private func showNotice(title: String, message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    private func log(_ message: String) {
        let line = "[\(Self.timeFormatter.string(from: Date()))] \(message)"
        logLines.append(line)
        if logLines.count > 80 {
            logLines.removeFirst(logLines.count - 80)
        }
        print(line)
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}
