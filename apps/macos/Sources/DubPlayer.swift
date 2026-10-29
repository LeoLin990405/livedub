//
//  DubPlayer.swift
//  livedub macOS 菜单栏 App
//
//  中文配音播放器：AVAudioEngine + AVAudioPlayerNode，调度引擎下发的 24k PCM s16le 分片。
//   - 按 dub.startMs（会话时间轴）排序，到点播放；落后超过 1.5s 直接丢弃（实时同传宁可丢句也不堆积延迟）
//   - 24k mono 连接 mainMixer，由 AVAudioEngine 负责重采样到硬件输出率（实测 48kHz 立体声可用）
//   - 可随时开关（菜单栏「播放中文配音」），关闭时清空待播队列
//
//  已知限制：ScreenCaptureKit 抓的是系统输出音频，无法自动静音原声；
//  因此原声与中文配音会同时存在（README 有说明与缓解建议）。
//

import AVFoundation
import Foundation

final class DubPlayer {
    /// 引擎默认配音采样率（config.tts.sampleRate）
    static let sampleRate: Double = 24_000

    var onLog: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat
    private var graphReady = false
    private var enabled = false
    private var timer: Timer?
    private var pending: [PendingChunk] = []
    /// 会话时间轴 0 对应的单调时钟秒；nil 时按「立即播放」处理
    private var sessionStartUptime: Double?

    private(set) var playedChunks = 0
    private(set) var skippedChunks = 0
    private(set) var lastError: String?

    private struct PendingChunk {
        let startMs: Double
        let buffer: AVAudioPCMBuffer
        let durationMs: Double
    }

    init() {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: DubPlayer.sampleRate,
            channels: 1,
            interleaved: false
        ) else {
            fatalError("无法创建 24kHz mono 音频格式")
        }
        self.format = format
    }

    var isEnabled: Bool { enabled }
    var isPlaying: Bool { player.isPlaying }

    /// 由 App 在音频采集启动时设置（与 ScreenAudioCapture.sessionStartHostTime 同一时基）。
    func setSessionStartUptime(_ uptime: Double) {
        sessionStartUptime = uptime
    }

    func setEnabled(_ on: Bool) {
        guard enabled != on else { return }
        enabled = on
        if on {
            if ensureEngineStarted() {
                onLog?("[dub] 配音已开启")
            }
        } else {
            pending.removeAll()
            stopTimer()
            player.stop()
            onLog?("[dub] 配音已关闭")
        }
    }

    /// 接收一帧配音 PCM（引擎 dub 事件）。
    func enqueue(_ chunk: DubChunk) {
        guard enabled, !chunk.samples.isEmpty else { return }
        guard let buffer = makeBuffer(samples: chunk.samples, sampleRate: chunk.sampleRate) else {
            onLog?("[dub] 无法把配音块转为 AVAudioPCMBuffer（\(chunk.samples.count) 采样 @ \(chunk.sampleRate)Hz）")
            return
        }
        pending.append(PendingChunk(startMs: chunk.startMs, buffer: buffer, durationMs: chunk.durationMs))
        pending.sort { $0.startMs < $1.startMs }
        ensureTimer()
        drain()
    }

    /// 清空待播队列（停止/重新开始会话时用）。
    func flush() {
        pending.removeAll()
        stopTimer()
        player.stop()
        if enabled {
            _ = ensureEngineStarted()
            player.play()
        }
    }

    func stop() {
        enabled = false
        pending.removeAll()
        stopTimer()
        player.stop()
        if engine.isRunning { engine.stop() }
    }

    // MARK: - 调度

    private func ensureTimer() {
        guard timer == nil else { return }
        let newTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
            self?.drain()
        }
        newTimer.tolerance = 0.005
        RunLoop.main.add(newTimer, forMode: .common)
        timer = newTimer
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    /// 每 20ms 扫一次队列：到点的立即 schedule（node 内部按调用顺序无缝衔接）。
    private func drain() {
        guard enabled else {
            stopTimer()
            return
        }
        guard !pending.isEmpty else {
            stopTimer()
            return
        }

        let nowMs: Double?
        if let sessionStartUptime {
            nowMs = (ProcessInfo.processInfo.systemUptime - sessionStartUptime) * 1000.0
        } else {
            nowMs = nil
        }
        let leadMs = 40.0
        let lateDropMs = 1_500.0

        while let first = pending.first {
            if let nowMs, first.startMs > nowMs + leadMs { break }
            if nowMs == nil && first.startMs > leadMs { break } // 没有会话时基时只播「现在或过去」的块
            pending.removeFirst()
            if let nowMs, first.startMs < nowMs - lateDropMs {
                skippedChunks += 1
                continue
            }
            guard ensureEngineStarted() else {
                pending.removeAll()
                stopTimer()
                return
            }
            player.scheduleBuffer(first.buffer, at: nil, options: [], completionHandler: nil)
            if !player.isPlaying { player.play() }
            playedChunks += 1
        }

        if pending.isEmpty { stopTimer() }
    }

    private func ensureEngineStarted() -> Bool {
        if !graphReady {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            engine.prepare()
            graphReady = true
        }
        if engine.isRunning {
            if !player.isPlaying { player.play() }
            return true
        }
        do {
            try engine.start()
            player.play()
            return true
        } catch {
            lastError = "配音输出启动失败：\(error.localizedDescription)。请检查系统音频输出设备；字幕不受影响。"
            onLog?("[dub] \(lastError ?? "启动失败")")
            return false
        }
    }

    // MARK: - PCM -> AVAudioPCMBuffer

    private func makeBuffer(samples: [Int16], sampleRate: Int) -> AVAudioPCMBuffer? {
        let rate = sampleRate > 0 ? sampleRate : Int(DubPlayer.sampleRate)
        var pcm = samples
        if rate != Int(DubPlayer.sampleRate) {
            // 非默认采样率：重采样到 24k（复用采集侧的纯 Swift 重采样器，零依赖）
            let floats = samples.map { Float($0) / 32_768.0 }
            let resampled = StreamingResampler(inputRate: Double(rate), outputRate: DubPlayer.sampleRate).process(floats)
            pcm = resampled
        }
        guard !pcm.isEmpty, let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(pcm.count)
        ) else {
            return nil
        }
        buffer.frameLength = AVAudioFrameCount(pcm.count)
        guard let channel = buffer.floatChannelData?[0] else { return nil }
        for index in 0..<pcm.count {
            channel[index] = Float(pcm[index]) / 32_768.0
        }
        return buffer
    }
}
