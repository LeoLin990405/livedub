//
//  EngineClient.swift
//  livedub macOS 菜单栏 App
//
//  与本地引擎的 WebSocket 客户端（URLSessionWebSocketTask，零第三方依赖）：
//   - 连接建立后发 hello JSON（docs/CONTRACTS.md §3.1）
//   - 音频走二进制帧：[0]=0x01 | [1..8]=float64BE tMs | [9..]=s16le 16k mono
//   - 接收 JSON 事件（ready/status/partial/segment/translation/dub/metrics/voice/error/pong/bye）
//   - 断线指数退避重连（0.5s 起，上限 8s，带抖动），定时 ping 保活
//   - 音频帧在连接未就绪 / 发送积压时丢弃（实时同传宁可丢帧也不排队制造延迟）
//

import Foundation

enum EngineConnectionState: String {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed

    var displayText: String {
        switch self {
        case .disconnected: return "未连接"
        case .connecting: return "连接引擎…"
        case .connected: return "已连接"
        case .reconnecting: return "重连引擎…"
        case .failed: return "连接失败"
        }
    }
}

final class EngineClient: NSObject {
    // 所有回调都派发到主线程
    var onStateChange: ((EngineConnectionState) -> Void)?
    var onEvent: ((EngineEvent) -> Void)?
    var onLog: ((String) -> Void)?

    var helloOptions: HelloOptions
    private(set) var engineURL: URL

    private let queue = DispatchQueue(label: "com.livedub.macos.engine")
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var reconnectWorkItem: DispatchWorkItem?
    private var pingTimer: DispatchSourceTimer?
    private var reconnectAttempt = 0
    private var stopped = true
    private var inFlightSends = 0
    private var stateValue: EngineConnectionState = .disconnected
    private var droppedAudioFramesValue = 0
    private var lastErrorText: String?

    struct Stats {
        let state: EngineConnectionState
        let droppedAudioFrames: Int
        let lastError: String?
    }

    init(engineURL: URL, helloOptions: HelloOptions) {
        self.engineURL = engineURL
        self.helloOptions = helloOptions
        super.init()
    }

    // MARK: - 生命周期

    func start() {
        queue.async {
            guard self.stopped else { return }
            self.stopped = false
            self.reconnectAttempt = 0
            self.connectLocked()
        }
    }

    func stop() {
        queue.async {
            self.stopped = true
            self.reconnectWorkItem?.cancel()
            self.reconnectWorkItem = nil
            self.teardownSocketLocked()
            self.setStateLocked(.disconnected)
        }
    }

    /// 切换引擎地址并重连（已有连接会被关闭）。
    func restart(with url: URL) {
        queue.async {
            self.stopped = true
            self.reconnectWorkItem?.cancel()
            self.reconnectWorkItem = nil
            self.teardownSocketLocked()
            self.engineURL = url
            self.stopped = false
            self.reconnectAttempt = 0
            self.connectLocked()
        }
    }

    var stats: Stats {
        queue.sync {
            Stats(state: stateValue, droppedAudioFrames: droppedAudioFramesValue, lastError: lastErrorText)
        }
    }

    // MARK: - 发送

    /// 发送一帧 16k mono s16le（100ms / 1600 采样）。连接未就绪或积压时丢弃。
    func sendAudioFrame(tMs: Double, samples: [Int16]) {
        guard let data = try? AudioFrameCodec.encode(tMs: tMs, pcm: samples) else { return }
        queue.async {
            guard !self.stopped, self.stateValue == .connected, let task = self.task else {
                self.droppedAudioFramesValue += 1
                return
            }
            guard self.inFlightSends < 12 else {
                self.droppedAudioFramesValue += 1
                return
            }
            self.inFlightSends += 1
            task.send(.data(data)) { [weak self] error in
                guard let self else { return }
                self.queue.async {
                    self.inFlightSends = max(0, self.inFlightSends - 1)
                    if let error { self.handleSocketErrorLocked(error) }
                }
            }
        }
    }

    func sendJSON(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        queue.async {
            guard !self.stopped, self.stateValue == .connected, let task = self.task else { return }
            task.send(.string(text)) { [weak self] error in
                guard let self, let error else { return }
                self.queue.async { self.handleSocketErrorLocked(error) }
            }
        }
    }

    /// 发送 control 消息（pause / resume / stop / seek / flush）
    func sendControl(_ action: String) {
        sendJSON(["type": "control", "action": action])
    }

    // MARK: - 连接管理（以下方法都在 queue 上执行，命名后缀 Locked）

    private func connectLocked() {
        guard !stopped else { return }
        teardownSocketLocked()
        setStateLocked(reconnectAttempt == 0 ? .connecting : .reconnecting)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 0
        configuration.waitsForConnectivity = false
        let newSession = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let newTask = newSession.webSocketTask(with: engineURL)
        session = newSession
        task = newTask
        newTask.resume()
        receiveNextLocked()
        startPingLocked()
    }

    private func teardownSocketLocked() {
        stopPingLocked()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        inFlightSends = 0
    }

    private func receiveNextLocked() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async { self.handleReceiveLocked(result) }
        }
    }

    private func handleReceiveLocked(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        guard !stopped else { return }
        switch result {
        case .success(let message):
            switch message {
            case .string(let text):
                if let event = EngineEventParser.parse(text: text) {
                    DispatchQueue.main.async { self.onEvent?(event) }
                } else {
                    logLocked("收到无法解析的文本帧 \(text.prefix(120))")
                }
            case .data(let data):
                logLocked("忽略未知二进制下行帧（\(data.count) 字节）")
            @unknown default:
                break
            }
            receiveNextLocked()
        case .failure(let error):
            handleSocketErrorLocked(error)
        }
    }

    private func handleSocketErrorLocked(_ error: Error) {
        guard !stopped else { return }
        let text = (error as NSError).localizedDescription
        lastErrorText = text
        scheduleReconnectLocked(reason: text)
    }

    /// 指数退避重连：0.5s, 1s, 2s, 4s, 8s（封顶），加 0~0.25s 抖动；成功连接后计数归零。
    private func scheduleReconnectLocked(reason: String) {
        guard !stopped, reconnectWorkItem == nil else { return }
        reconnectAttempt += 1
        let attempt = reconnectAttempt
        let base = min(8.0, 0.5 * pow(2.0, Double(attempt - 1)))
        let delay = base + Double.random(in: 0...0.25)
        teardownSocketLocked()
        setStateLocked(.reconnecting)
        logLocked(String(format: "引擎连接断开（%@），%.1fs 后第 %d 次重连", reason, delay, attempt))

        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.queue.async {
                self.reconnectWorkItem = nil
                guard !self.stopped else { return }
                self.connectLocked()
            }
        }
        reconnectWorkItem = item
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func sendHelloLocked() {
        guard let task else { return }
        do {
            let text = try HelloJSON.text(options: helloOptions)
            task.send(.string(text)) { [weak self] error in
                guard let self, let error else { return }
                self.queue.async { self.handleSocketErrorLocked(error) }
            }
        } catch {
            logLocked("构造 hello 失败：\(error)")
        }
    }

    private func startPingLocked() {
        stopPingLocked()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 10, repeating: 15, leeway: .milliseconds(500))
        timer.setEventHandler { [weak self] in
            guard let self, !self.stopped, self.stateValue == .connected, let task = self.task else { return }
            let payload: [String: Any] = ["type": "ping", "t": Int(Date().timeIntervalSince1970 * 1000)]
            if let data = try? JSONSerialization.data(withJSONObject: payload),
               let text = String(data: data, encoding: .utf8) {
                task.send(.string(text)) { _ in }
            }
            task.sendPing { [weak self] error in
                guard let self, let error else { return }
                self.queue.async { self.handleSocketErrorLocked(error) }
            }
        }
        timer.resume()
        pingTimer = timer
    }

    private func stopPingLocked() {
        pingTimer?.cancel()
        pingTimer = nil
    }

    private func setStateLocked(_ newState: EngineConnectionState) {
        guard stateValue != newState else { return }
        stateValue = newState
        DispatchQueue.main.async { self.onStateChange?(newState) }
    }

    private func logLocked(_ message: String) {
        let line = "[engine] " + message
        DispatchQueue.main.async { self.onLog?(line) }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension EngineClient: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        queue.async {
            guard !self.stopped, webSocketTask === self.task else { return }
            self.reconnectAttempt = 0
            self.setStateLocked(.connected)
            self.sendHelloLocked()
            self.logLocked("已连接 \(self.engineURL.absoluteString)")
        }
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        queue.async {
            guard !self.stopped, webSocketTask === self.task else { return }
            self.scheduleReconnectLocked(reason: "close \(closeCode.rawValue) \(reasonText)")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        queue.async {
            guard !self.stopped,
                  let wsTask = task as? URLSessionWebSocketTask,
                  wsTask === self.task else { return }
            self.handleSocketErrorLocked(error)
        }
    }
}
