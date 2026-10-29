//
//  ScreenAudioCapture.swift
//  livedub macOS 菜单栏 App
//
//  用 ScreenCaptureKit「只抓系统/应用音频」（不抓画面）：
//   SCShareableContent -> SCStream(capturesAudio=true) -> CMSampleBuffer
//     -> 单声道 Float32（输入采样率，通常 48kHz）-> StreamingResampler -> 16k s16le
//     -> FrameChunker 按 100ms / 1600 采样分帧 -> EngineClient 二进制帧
//
//  权限：macOS 用「屏幕录制」权限管控系统音频捕获（用户看到的提示是屏幕录制，
//  但 livedub 只读取音频流，不截屏、不落盘）。
//

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

enum ScreenCaptureError: LocalizedError {
    case permissionDenied
    case noDisplay
    case apiFailure(String)

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "没有「屏幕录制」权限：打开 系统设置 → 隐私与安全性 → 屏幕录制，勾选 livedub（或启动它的终端），然后重新开始同传。"
        case .noDisplay:
            return "找不到可捕获的显示器：确认当前有登录的图形会话（远程/无头环境不支持 ScreenCaptureKit）。"
        case .apiFailure(let message):
            return message
        }
    }
}

final class ScreenAudioCapture: NSObject {
    /// 音频帧回调（在内部串行 audioQueue 上调用）：tMs = 会话时间轴毫秒，pcm = 16k mono s16le
    var onAudioFrame: ((Double, [Int16]) -> Void)?
    /// 失败回调（主线程）
    var onError: ((Error) -> Void)?
    /// 日志（主线程）
    var onLog: ((String) -> Void)?

    /// 采集启动时刻（单调时钟秒，与 ProcessInfo.systemUptime 同一时基），用于配音按 startMs 对齐
    private(set) var sessionStartHostTime: Double = 0
    private(set) var capturedFrames = 0

    private var stream: SCStream?
    private let audioQueue = DispatchQueue(label: "com.livedub.macos.capture.audio")
    private var resampler: StreamingResampler?
    private var chunker = FrameChunker()
    private var loggedInputFormat = false
    private var inputSampleRate: Double = 48_000
    private var running = false

    // MARK: - 权限

    /// 只查询、不弹窗（macOS 10.15+）
    static func hasPermission() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    /// 触发系统授权弹窗；首次调用会返回 false，授权后需要轮询 hasPermission()。
    @discardableResult
    static func requestPermission() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    // MARK: - 生命周期

    /// 开始采集。会先检查/请求屏幕录制权限，再枚举显示器并启动音频流。
    func start() async throws {
        if !Self.hasPermission() {
            let granted = Self.requestPermission()
            guard granted else { throw ScreenCaptureError.permissionDenied }
        }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            throw ScreenCaptureError.apiFailure(
                "枚举屏幕内容失败：\(error.localizedDescription)。请确认已授予「屏幕录制」权限，并重启 App 后再试。"
            )
        }
        guard let display = content.displays.first else { throw ScreenCaptureError.noDisplay }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        // 只要音频：把视频尺寸压到最小、帧率降到 1fps（未注册 .screen 输出，实际不会编码视频）
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.showsCursor = false
        configuration.queueDepth = 6

        let newStream = SCStream(filter: filter, configuration: configuration, delegate: self)
        do {
            try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        } catch {
            throw ScreenCaptureError.apiFailure("注册音频输出失败：\(error.localizedDescription)")
        }

        audioQueue.sync {
            self.resampler = nil
            self.chunker = FrameChunker()
            self.loggedInputFormat = false
            self.capturedFrames = 0
            self.sessionStartHostTime = ProcessInfo.processInfo.systemUptime
        }

        do {
            try await newStream.startCapture()
        } catch {
            throw ScreenCaptureError.apiFailure(
                "启动音频捕获失败：\(error.localizedDescription)。若刚授权，请在系统设置里确认 livedub 已勾选后重试。"
            )
        }

        stream = newStream
        running = true
        emitLog("已开始系统音频捕获（display \(display.width)x\(display.height)，音频 only）")
    }

    /// 停止采集（幂等；异步清理 SCStream）。
    func stop() {
        guard running || stream != nil else { return }
        running = false
        let current = stream
        stream = nil
        guard let current else { return }
        Task {
            try? await current.stopCapture()
        }
        emitLog("已停止系统音频捕获")
    }

    // MARK: - 音频转换

    /// CMSampleBuffer（系统音频，通常 48kHz 立体声 Float32）-> 单声道 Float32 采样。
    private func monoFloatSamples(from sampleBuffer: CMSampleBuffer) -> (samples: [Float], sampleRate: Double)? {
        guard CMSampleBufferDataIsReady(sampleBuffer),
              let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return nil
        }
        let asbd = asbdPointer.pointee
        let sampleRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48_000
        let channelCount = max(1, Int(asbd.mChannelsPerFrame))
        let flags = asbd.mFormatFlags
        let isFloat = (flags & AudioFormatFlags.isFloat) != 0
        let isSignedInteger = (flags & AudioFormatFlags.isSignedInteger) != 0
        let isNonInterleaved = (flags & AudioFormatFlags.isNonInterleaved) != 0
        let bytesPerSample = isFloat ? 4 : 2
        guard isFloat || isSignedInteger else { return nil }

        var neededSize = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &neededSize,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: nil
        )
        guard neededSize > 0 else { return nil }

        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: neededSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        let audioBufferListPointer = raw.assumingMemoryBound(to: AudioBufferList.self)
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferListPointer,
            bufferListSize: neededSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return nil }

        let bufferList = UnsafeMutableAudioBufferListPointer(audioBufferListPointer)
        guard !bufferList.isEmpty else { return nil }

        var samples: [Float] = []
        if isNonInterleaved && bufferList.count >= channelCount {
            // 每声道一个 buffer
            let frames = bufferList.map { Int($0.mDataByteSize) / bytesPerSample }.min() ?? 0
            guard frames > 0 else { return nil }
            samples = [Float](repeating: 0, count: frames)
            for channel in 0..<channelCount {
                let buffer = bufferList[channel]
                guard let data = buffer.mData else { return nil }
                for frame in 0..<frames {
                    let value: Float
                    if isFloat {
                        value = data.assumingMemoryBound(to: Float.self)[frame]
                    } else {
                        value = Float(data.assumingMemoryBound(to: Int16.self)[frame]) / 32_768.0
                    }
                    samples[frame] += value / Float(channelCount)
                }
            }
        } else {
            // 交织：单 buffer 内 L R L R ...
            guard let first = bufferList.first, let data = first.mData else { return nil }
            let bytesPerFrame = bytesPerSample * channelCount
            let frames = bytesPerFrame > 0 ? Int(first.mDataByteSize) / bytesPerFrame : 0
            guard frames > 0 else { return nil }
            samples = [Float](repeating: 0, count: frames)
            for frame in 0..<frames {
                var sum: Float = 0
                for channel in 0..<channelCount {
                    let offset = frame * channelCount + channel
                    if isFloat {
                        sum += data.assumingMemoryBound(to: Float.self)[offset]
                    } else {
                        sum += Float(data.assumingMemoryBound(to: Int16.self)[offset]) / 32_768.0
                    }
                }
                samples[frame] = sum / Float(channelCount)
            }
        }

        if !loggedInputFormat {
            loggedInputFormat = true
            emitLog(String(
                format: "系统音频格式：%.0fHz / %dch / %@ / %@ -> 重采样 16kHz mono s16le",
                sampleRate,
                channelCount,
                isFloat ? "float32" : "int16",
                isNonInterleaved ? "non-interleaved" : "interleaved"
            ))
        }
        return (samples, sampleRate)
    }

    private func emitLog(_ message: String) {
        DispatchQueue.main.async { self.onLog?(message) }
    }

    private func emitError(_ error: Error) {
        DispatchQueue.main.async { self.onError?(error) }
    }
}

// MARK: - SCStreamOutput

extension ScreenAudioCapture: SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, running else { return }
        guard let (monoSamples, sampleRate) = monoFloatSamples(from: sampleBuffer) else { return }

        if resampler == nil || inputSampleRate != sampleRate {
            inputSampleRate = sampleRate
            resampler = StreamingResampler(inputRate: sampleRate)
        }
        guard let resampler else { return }
        let pcm16k = resampler.process(monoSamples)
        guard !pcm16k.isEmpty else { return }

        for frame in chunker.push(pcm16k) {
            capturedFrames += 1
            onAudioFrame?(frame.tMs, frame.pcm)
        }
    }
}

// MARK: - SCStreamDelegate

extension ScreenAudioCapture: SCStreamDelegate {
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard running else { return }
        running = false
        emitError(ScreenCaptureError.apiFailure(
            "系统音频捕获被系统停止：\(error.localizedDescription)。请重新点「开始同传」；若反复失败，检查屏幕录制权限并重启 App。"
        ))
    }
}

// MARK: - CoreAudio 格式 flags（避免额外 import 依赖，数值与 CoreAudioTypes 一致）

private enum AudioFormatFlags {
    /// kAudioFormatFlagIsFloat
    static let isFloat: UInt32 = 1 << 0
    /// kAudioFormatFlagIsSignedInteger
    static let isSignedInteger: UInt32 = 1 << 2
    /// kAudioFormatFlagIsNonInterleaved
    static let isNonInterleaved: UInt32 = 1 << 5
}
