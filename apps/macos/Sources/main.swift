//
//  main.swift
//  livedub macOS 菜单栏 App
//
//  形态：LSUIElement 菜单栏 App（无 Dock 图标），抓取系统/应用音频（ScreenCaptureKit）
//        -> 本地 livedub 引擎（ws://127.0.0.1:8787/ws）
//        -> 置顶双语字幕浮层 + 中文配音。
//
//  v0.4：全局 ⌥N「快捷笔记」——把当前双语字幕 + 时间戳 +（可选）屏幕截图
//        记进本地引擎 Notes API（失败进离线队列，重连后自动补发）。
//  v0.5：截图上传后调用引擎视觉端点，把「画面文字（OCR）」写进笔记；
//        可选开「画面理解（VLM，慢）」；失败静默降级，不影响笔记保存。
//
//  入口参数：
//    --self-test             headless 自检（不建窗口、不请求权限、不联网），退出码 0/1
//    --simulate              不抓音频/不连引擎，循环演示字幕/状态/延迟（无权限环境验证 UI）
//    --note-once             启动后 2.5s 自动触发一条测试笔记，记录完退出（冒烟用）
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
    var noteOnce = false
    /// 调试用：本次运行强制开启「画面理解（VLM）」，不写用户设置
    var notesVision = false
    var help = false

    static let helpText = """
    livedub macOS 菜单栏 App（ScreenCaptureKit 系统音频 -> 本地引擎 -> 双语字幕 + 中文配音）

    用法：livedub [选项]

      --simulate            不抓音频/不连引擎，循环演示双语字幕、状态与延迟（无权限环境验证 UI）
      --autostart           启动后自动点一次「开始同传」（适合登录项 / 自动化冒烟）
      --note-once           调试/冒烟：启动 2.5s 后自动记一条笔记（截图/OCR/离线队列全链路），
                            记录完成后退出（配合 --engine-url 指向测试引擎）
      --notes-vision        调试用：本次运行开启「画面理解（VLM，慢）」开关（不写用户设置）
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
            case "--note-once":
                options.noteOnce = true
            case "--notes-vision":
                options.notesVision = true
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

// MARK: - 线程安全的音频时钟

/// 音频回调（采集线程）写、⌥N（主线程）读的会话时间轴毫秒
final class AtomicDouble {
    private let lock = NSLock()
    private var value: Double

    init(_ value: Double) {
        self.value = value
    }

    func set(_ newValue: Double) {
        lock.lock()
        value = newValue
        lock.unlock()
    }

    func get() -> Double {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

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

    // v0.4 快捷笔记
    private var notesClient: NotesClient?
    private var notesFlushTimer: Timer?
    private var noteOnceTimer: Timer?
    private var noteMenuItem: NSMenuItem?
    private var openNotesMenuItem: NSMenuItem?
    private var openWorkbenchMenuItem: NSMenuItem?
    private var notesScreenshotMenuItem: NSMenuItem?
    private var notesWhenPausedMenuItem: NSMenuItem?
    private var notesOCRMenuItem: NSMenuItem?
    private var notesVisionMenuItem: NSMenuItem?
    private var notesQueueMenuItem: NSMenuItem?
    private var visionStatusMenuItem: NSMenuItem?
    private var visionStatus: VisionStatus?
    private var visionHealthTimer: Timer?
    private var visionUnavailableToastShown = false
    private let lastAudioTMs = AtomicDouble(0)
    private var isEnginePaused = false
    private var lastEngineSessionId: String?
    private var lastEngineProviders: [String: String] = [:]
    private var notesInFlight = false
    private var exitAfterNote = false
    private var lastNoteClock = ""

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

        setupNotes()
        setupAutoQuit()

        if options.noteOnce {
            // 只给 --note-once 时：记录完成即退出（冒烟）；若同时显式给 --duration，则保持运行到时长
            exitAfterNote = (options.duration == nil)
            noteOnceTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
                self?.log("[notes] --note-once：触发一条测试笔记")
                self?.takeNote(trigger: "--note-once")
            }
        }

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
        notesFlushTimer?.invalidate()
        noteOnceTimer?.invalidate()
        visionHealthTimer?.invalidate()
        GlobalHotKey.shared.unregister()
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
        noteMenuItem = addMenuItem(
            to: menu,
            title: "记笔记（\(GlobalHotKey.displayName)）",
            action: #selector(takeNoteFromMenu),
            keyEquivalent: "n",
            modifiers: [.option]
        )
        noteMenuItem?.toolTip = "把当前双语字幕 + 时间戳（+ 可选截图）记进本地笔记库；全局快捷键 \(GlobalHotKey.displayName)"
        openNotesMenuItem = addMenuItem(to: menu, title: "打开笔记（工作台学习笔记）", action: #selector(openNotesPanel))
        openWorkbenchMenuItem = addMenuItem(to: menu, title: "打开工作台", action: #selector(openWorkbench))
        menu.addItem(.separator())

        overlayMenuItem = addMenuItem(to: menu, title: "显示字幕浮层", action: #selector(toggleOverlay))
        clickThroughMenuItem = addMenuItem(to: menu, title: "字幕点击穿透", action: #selector(toggleClickThrough))
        clickThroughMenuItem?.toolTip = "开启后鼠标事件穿透浮层（可点击下方窗口/播放器），但浮层不能拖动"
        dubMenuItem = addMenuItem(to: menu, title: "播放中文配音", action: #selector(toggleDub))
        dubMenuItem?.toolTip = "关闭后只显示字幕，不播放中文配音"
        sourceLineMenuItem = addMenuItem(to: menu, title: "显示原文行", action: #selector(toggleSourceLine))
        fontSizeUpMenuItem = addMenuItem(to: menu, title: "增大字幕字号", action: #selector(increaseFontSize))
        fontSizeDownMenuItem = addMenuItem(to: menu, title: "减小字幕字号", action: #selector(decreaseFontSize))

        menu.addItem(.separator())
        notesScreenshotMenuItem = addMenuItem(to: menu, title: "记笔记时附截图", action: #selector(toggleNotesScreenshot))
        notesScreenshotMenuItem?.toolTip = "开启后用 SCScreenshotManager 截当前屏幕作为笔记附件（复用屏幕录制权限，不含 livedub 浮层）"
        notesWhenPausedMenuItem = addMenuItem(to: menu, title: "暂停时仍可笔记", action: #selector(toggleNotesWhenPaused))
        notesWhenPausedMenuItem?.toolTip = "同传暂停时仍允许 \(GlobalHotKey.displayName) 记录当前字幕"
        notesOCRMenuItem = addMenuItem(to: menu, title: "识别画面文字（OCR，快）", action: #selector(toggleNotesOCR))
        notesOCRMenuItem?.toolTip = "⌥N 时识别截图中的文字并写入笔记（需要引擎 v0.5；本地 OCR，默认开）"
        notesVisionMenuItem = addMenuItem(to: menu, title: "画面理解（VLM，慢，约 20–30s）", action: #selector(toggleNotesVision))
        notesVisionMenuItem?.toolTip = "用 VLM 生成画面描述；较慢、可能产生云端费用，失败自动降级为仅 OCR（默认关）"
        notesQueueMenuItem = addMenuItem(to: menu, title: "笔记队列：空", action: nil)
        visionStatusMenuItem = addMenuItem(to: menu, title: "视觉：检测中…", action: nil)
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
        keyEquivalent: String = "",
        modifiers: NSEvent.ModifierFlags = [.command]
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        item.target = action == nil ? nil : self
        item.isEnabled = action != nil
        if !keyEquivalent.isEmpty {
            item.keyEquivalentModifierMask = modifiers
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
        notesScreenshotMenuItem?.state = settings.notesIncludeScreenshot ? .on : .off
        notesWhenPausedMenuItem?.state = settings.notesWhenPaused ? .on : .off
        notesOCRMenuItem?.state = settings.notesOCR ? .on : .off
        notesVisionMenuItem?.state = (options.notesVision || settings.notesVision) ? .on : .off
        visionStatusMenuItem?.title = visionStatus?.summaryText ?? "视觉：检测中…"
        refreshNotesQueueMenu()
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
            self?.lastAudioTMs.set(tMs)
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
        isEnginePaused = false
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
            isEnginePaused = false
            overlay?.setStatus("已连接 · 聆听中", latencyMs: currentLatencyMs)
            flushNotesQueue(reason: "引擎已连接")
            refreshVisionHealth(reason: "引擎已连接")
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
            lastEngineSessionId = sessionId
            lastEngineProviders = providers
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
                isEnginePaused = (state == "paused")
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
        isEnginePaused = false
        overlay?.setPlaceholder("已停止 · 从菜单栏「开始同传」继续")
        overlay?.setStatus("已停止", latencyMs: nil)
        refreshMenu()
        log("[app] 模拟演示已停止")
    }

    private func setupAutoQuit() {
        // --note-once 没显式给 --duration 时给一个兜底，避免记录链路异常时 App 挂住
        let fallback = options.noteOnce ? 20.0 : nil
        guard let duration = options.duration ?? fallback, duration > 0 else { return }
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
        notesClient?.updateEngineURL(settings.engineURL)
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
        lines.append("livedub macOS app（v0.5）")
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
        if let notesClient {
            lines.append(
                "笔记：队列 \(notesClient.queueCount) 条 · 快捷键 \(GlobalHotKey.displayName) "
                    + "\(GlobalHotKey.shared.isRegistered ? "已注册" : "未注册")"
                    + " · 附截图 \(settings.notesIncludeScreenshot ? "开" : "关")"
                    + " · 暂停可笔记 \(settings.notesWhenPaused ? "开" : "关")"
            )
            lines.append("Notes API：\(notesClient.baseURLString)")
            lines.append(visionStatus?.summaryText ?? "视觉：未检测")
            lines.append(
                "画面文字 OCR：\(settings.notesOCR ? "开" : "关")"
                    + " · 画面理解 VLM：\((options.notesVision || settings.notesVision) ? "开" : "关")"
            )
            if let error = notesClient.lastErrorText { lines.append("笔记最近错误：\(error)") }
        }
        if !lastNoteClock.isEmpty { lines.append("最近一条笔记：\(lastNoteClock)") }
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

    // MARK: - 快捷笔记（v0.4 · ⌥N）

    private func setupNotes() {
        let client = NotesClient(engineURL: settings.engineURL)
        client.onLog = { [weak self] message in self?.log(message) }
        notesClient = client

        GlobalHotKey.shared.onLog = { [weak self] message in self?.log(message) }
        let registered = GlobalHotKey.shared.register { [weak self] in
            self?.takeNote(trigger: "快捷键 \(GlobalHotKey.displayName)")
        }
        if registered {
            log("[notes] 全局快捷键 \(GlobalHotKey.displayName) 已就绪（记笔记）")
        } else {
            log("[notes] ⚠️ 全局快捷键 \(GlobalHotKey.displayName) 注册失败（可能被其它 App 占用），可用菜单栏「记笔记」")
        }

        notesFlushTimer?.invalidate()
        notesFlushTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.flushNotesQueue(reason: "定时器")
        }

        // 视觉能力检测（仅展示，不影响主流程；旧引擎 404 -> 菜单显示不可用）
        refreshVisionHealth(reason: "启动")
        visionHealthTimer?.invalidate()
        visionHealthTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            self?.refreshVisionHealth(reason: "定时器")
        }
        refreshNotesQueueMenu()
    }

    /// GET /api/vision/health，更新菜单「视觉：…」状态；失败只降级展示
    private func refreshVisionHealth(reason: String) {
        guard let notesClient else { return }
        Task { [weak self, notesClient] in
            let status = await notesClient.fetchVisionHealth()
            let owner = self
            DispatchQueue.main.async {
                guard let owner else { return }
                owner.visionStatus = status
                owner.log("[vision] 能力检测（\(reason)）：\(status.summaryText)")
                owner.refreshMenu()
                let visionWanted = owner.settings.notesOCR || owner.settings.notesVision || owner.options.notesVision
                if status.endpointMissing && visionWanted && !owner.visionUnavailableToastShown {
                    owner.visionUnavailableToastShown = true
                    owner.overlay?.showToast("视觉功能不可用（引擎需 v0.5）：笔记仍含截图+字幕", isError: true)
                }
            }
        }
    }

    private func refreshNotesQueueMenu() {
        guard let item = notesQueueMenuItem else { return }
        let count = notesClient?.queueCount ?? 0
        item.title = count > 0
            ? "笔记队列：\(count) 条待同步（引擎重连后自动补发）"
            : "笔记队列：空"
    }

    @objc private func takeNoteFromMenu() {
        takeNote(trigger: "菜单")
    }

    /// ⌥N / 菜单「记笔记」：收集当前上下文 ->（可选）截图上传 -> POST /api/notes/quick。
    /// 失败自动写入离线队列（UserDefaults ≤50 条），引擎重连后补发。
    private func takeNote(trigger: String) {
        guard let notesClient else {
            log("[notes] NotesClient 未初始化，忽略记笔记")
            return
        }
        if notesInFlight {
            overlay?.showToast("上一条笔记还在记录中…")
            return
        }
        if isRunning && isEnginePaused && !settings.notesWhenPaused {
            overlay?.showToast("同传已暂停：可在菜单打开「暂停时仍可笔记」", isError: true)
            log("[notes] 已暂停且「暂停时仍可笔记」关闭，忽略")
            return
        }

        notesInFlight = true
        let context = captureNoteContext()
        let includeScreenshot = settings.notesIncludeScreenshot
        let permission = ScreenAudioCapture.hasPermission()
        let ocrEnabled = settings.notesOCR
        let visionEnabled = options.notesVision || settings.notesVision
        let visionSnapshot = visionStatus
        log(
            "[notes] 触发（\(trigger)）tMs=\(Int(context.tMs)) 字幕=\(context.source.isEmpty && context.translation.isEmpty ? "无" : "有")"
                + " 截图=\(includeScreenshot ? "开" : "关") 附截图权限=\(permission ? "有" : "无")"
                + " OCR=\(ocrEnabled ? "开" : "关") VLM=\(visionEnabled ? "开" : "关")"
        )

        Task { [weak self, notesClient] in
            var imageRef: NoteAssetRef?
            var screenshotNote = "未请求"
            var screenshotLog = ""
            if !includeScreenshot {
                screenshotNote = "跳过：" + ScreenshotPlanner.reasonText("disabled")
            } else if !permission {
                screenshotNote = "跳过：" + ScreenshotPlanner.reasonText("permission")
            } else {
                do {
                    let png = try await ScreenshotService.captureDisplayPNG()
                    switch ScreenshotPlanner.decide(
                        includeScreenshot: true,
                        permissionGranted: true,
                        capturedBytes: png.count
                    ) {
                    case .attach:
                        imageRef = try await notesClient.uploadPNG(png)
                        screenshotNote = "已上传 \(png.count / 1024)KB"
                    case .textOnly(let reason):
                        screenshotNote = "降级：" + ScreenshotPlanner.reasonText(reason)
                    }
                } catch {
                    screenshotNote = "降级：" + error.localizedDescription
                    screenshotLog = "[notes] 截图/上传失败，降级纯文字：\(error.localizedDescription)"
                }
            }

            // v0.5：画面文字（OCR）/ 可选画面理解（VLM）——失败静默降级，不影响笔记保存
            let owner = self
            func showToast(_ text: String) {
                DispatchQueue.main.async { owner?.overlay?.showToast(text) }
            }
            var ocrText: String?
            var visionCaption: String?
            var visionNote = "未请求"
            var extraLogs: [String] = screenshotLog.isEmpty ? [] : [screenshotLog]

            if let imageRef {
                let ocrDecision = VisionPlanner.ocrDecision(
                    enabled: ocrEnabled,
                    hasImageAsset: true,
                    endpointMissing: notesClient.visionEndpointMissing,
                    health: visionSnapshot
                )
                switch ocrDecision {
                case .skip(let reason):
                    visionNote = "OCR 跳过：" + VisionPlanner.skipReasonText(reason)
                case .run:
                    showToast("识别画面文字…")
                    do {
                        let result = try await notesClient.recognizeImage(imagePath: imageRef.relativePath)
                        if let cleaned = VisionText.cleanOCR(result.text) {
                            ocrText = cleaned
                            let ms = result.ms.map { String(format: " %.0fms", $0) } ?? ""
                            let provider = result.provider.isEmpty ? "?" : result.provider
                            visionNote = "OCR \(cleaned.count) 字（\(provider)\(ms)）"
                        } else {
                            visionNote = "OCR 无可读文字"
                        }
                    } catch {
                        visionNote = "OCR 降级（不影响笔记）"
                        extraLogs.append("[vision] OCR 失败已降级：\(error)")
                    }
                }

                let visionDecision = VisionPlanner.visionDecision(
                    enabled: visionEnabled,
                    hasImageAsset: true,
                    endpointMissing: notesClient.visionEndpointMissing,
                    health: visionSnapshot
                )
                switch visionDecision {
                case .skip(let reason):
                    if visionEnabled {
                        visionNote += " · VLM 跳过：" + VisionPlanner.skipReasonText(reason)
                    }
                case .run:
                    showToast("画面理解中…（VLM 约 20–30s）")
                    do {
                        let analysis = try await notesClient.analyzeImage(imagePath: imageRef.relativePath, mode: "both")
                        if ocrText == nil, let analysisOCR = VisionText.cleanOCR(analysis.ocrText ?? "") {
                            ocrText = analysisOCR
                        }
                        if let caption = VisionText.cleanCaption(analysis.caption ?? "") {
                            visionCaption = caption
                            visionNote += " · VLM 已生成（\(caption.count) 字）"
                        } else {
                            visionNote += " · VLM 无描述"
                        }
                    } catch {
                        visionNote += " · VLM 降级：仅 OCR"
                        extraLogs.append("[vision] 画面理解失败已降级为仅 OCR：\(error)")
                    }
                }
            } else {
                visionNote = "跳过：无截图附件（OCR/VLM 需要画面）"
            }

            let note = NoteComposer.makeQuickRequest(
                context: context,
                image: imageRef,
                ocrText: ocrText,
                visionCaption: visionCaption
            )
            let delivery = await notesClient.record(note)
            let finalScreenshotNote = screenshotNote
            let finalVisionNote = visionNote
            let finalLogs = extraLogs
            DispatchQueue.main.async {
                guard let owner else { return }
                owner.notesInFlight = false
                for line in finalLogs { owner.log(line) }
                owner.handleNoteDelivery(
                    delivery,
                    context: context,
                    screenshotNote: finalScreenshotNote,
                    visionNote: finalVisionNote
                )
            }
        }
    }

    /// 当前字幕/时间轴/前台 App 快照（必须在主线程调用）
    private func captureNoteContext() -> NoteContext {
        let frontApp = NSWorkspace.shared.frontmostApplication
        return NoteContext(
            sessionId: lastEngineSessionId,
            sessionTitle: "macOS 系统音频 · livedub app",
            tMs: lastAudioTMs.get(),
            statusText: currentStatus,
            translation: currentTranslation,
            source: currentSource,
            latencyMs: currentLatencyMs,
            frontmostApp: frontApp?.localizedName,
            frontmostBundleId: frontApp?.bundleIdentifier,
            capturedAt: Date()
        )
    }

    private func handleNoteDelivery(
        _ delivery: QuickNoteDelivery,
        context: NoteContext,
        screenshotNote: String,
        visionNote: String = ""
    ) {
        let visionSuffix = visionNote.isEmpty ? "" : " · 画面 \(visionNote)"
        let clock = NoteComposer.formatClock(context.capturedAt)
        switch delivery {
        case let .sent(result):
            lastNoteClock = clock
            let path = result.path ?? "(服务端未返回 path)"
            log("[notes] 已记录（sent）· \(clock) · \(path) · 截图 \(screenshotNote)\(visionSuffix)")
            overlay?.showToast("已记录笔记 · \(clock)")
            if exitAfterNote { finishNoteOnce(exitCode: 0) }
        case let .queued(count):
            lastNoteClock = clock
            log("[notes] 已离线排队（queued \(count)）· \(clock) · 截图 \(screenshotNote)\(visionSuffix)")
            overlay?.showToast("引擎未连接，笔记已排队 · \(clock)", isError: true)
            if exitAfterNote {
                // --note-once 不立即退出：等引擎重连后自动补发（由 flushNotesQueue 收尾），避免测不到队列链路
                log("[notes] --note-once：等待引擎重连补发，或由 --duration/兜底计时自动退出")
            }
        case let .failed(message):
            log("[notes] 记录失败：\(message)")
            overlay?.showToast("记笔记失败：\(String(message.prefix(30)))", isError: true)
            if exitAfterNote { finishNoteOnce(exitCode: 1) }
        }
        refreshNotesQueueMenu()
        refreshMenu()
    }

    private func finishNoteOnce(exitCode: Int32) {
        exitAfterNote = false
        log("[notes] --note-once 结束（exit \(exitCode)）")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            if exitCode == 0 {
                NSApp.terminate(nil)
            } else {
                exit(exitCode)
            }
        }
    }

    private func flushNotesQueue(reason: String) {
        guard let notesClient else { return }
        let pending = notesClient.queueCount
        guard pending > 0 else { return }
        log("[notes] 开始补发离线笔记（\(reason)，\(pending) 条）")
        Task { [weak self, notesClient] in
            let outcome = await notesClient.flushOfflineQueue()
            let owner = self
            DispatchQueue.main.async {
                guard let owner else { return }
                if case let .done(sent, remaining) = outcome {
                    if sent > 0 {
                        owner.log("[notes] 离线笔记补发完成：成功 \(sent) 条，剩余 \(remaining) 条")
                    }
                    if sent > 0 && owner.exitAfterNote {
                        owner.finishNoteOnce(exitCode: 0)
                    }
                    owner.refreshNotesQueueMenu()
                }
            }
        }
    }

    @objc private func openNotesPanel() {
        openNotesURL(notes: true)
    }

    @objc private func openWorkbench() {
        openNotesURL(notes: false)
    }

    private func openNotesURL(notes: Bool) {
        let url = notes
            ? (notesClient?.studioNotesURL ?? URL(string: "http://127.0.0.1:8787/studio/?notes=1"))
            : (notesClient?.workbenchURL ?? URL(string: "http://127.0.0.1:8787/studio/"))
        guard let url else { return }
        NSWorkspace.shared.open(url)
        log("[notes] 打开 \(url.absoluteString)")
    }

    @objc private func toggleNotesScreenshot() {
        settings.notesIncludeScreenshot.toggle()
        log("[notes] 记笔记附截图 = \(settings.notesIncludeScreenshot ? "开" : "关")")
        refreshMenu()
    }

    @objc private func toggleNotesWhenPaused() {
        settings.notesWhenPaused.toggle()
        log("[notes] 暂停时仍可笔记 = \(settings.notesWhenPaused ? "开" : "关")")
        refreshMenu()
    }

    @objc private func toggleNotesOCR() {
        settings.notesOCR.toggle()
        log("[vision] 识别画面文字（OCR）= \(settings.notesOCR ? "开" : "关")")
        if settings.notesOCR { refreshVisionHealth(reason: "开启 OCR") }
        refreshMenu()
    }

    @objc private func toggleNotesVision() {
        settings.notesVision.toggle()
        log("[vision] 画面理解（VLM）= \(settings.notesVision ? "开（慢，约 20–30s）" : "关")")
        if settings.notesVision { refreshVisionHealth(reason: "开启 VLM") }
        refreshMenu()
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
