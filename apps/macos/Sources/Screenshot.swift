//
//  Screenshot.swift
//  livedub macOS 菜单栏 App
//
//  v0.4 快捷笔记的可选截图：
//   - SCScreenshotManager.captureImage（macOS 14+，ScreenCaptureKit）抓当前显示器
//   - 复用「屏幕录制」权限（与系统音频捕获同一个 TCC 授权，不需要额外权限）
//   - 排除 livedub 自己的浮层/窗口（截图里是用户正在看的 VSCode/会议/播放器内容）
//   - PNG <= 4MB（与服务端 Notes assets 契约一致）；超过则逐步降采样，仍超限就降级为纯文字
//
//  纯决策函数 ScreenshotPlanner 不触系统 API，--self-test 覆盖（不真截图）。
//

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

// MARK: - 决策（纯函数）

enum ScreenshotDecision: Equatable {
    case attach
    case textOnly(reason: String)
}

enum ScreenshotPlanner {
    /// 服务端 Notes assets 上限（契约：<= 4MB）
    static let maxAssetBytes = 4 * 1024 * 1024
    /// 超限时的降采样比例（依次尝试）
    static let scaleSteps: [CGFloat] = [1.0, 0.75, 0.55, 0.4]

    /// 根据开关 / 权限 / 截图字节数决定「附加截图」还是「降级纯文字」。
    static func decide(
        includeScreenshot: Bool,
        permissionGranted: Bool,
        capturedBytes: Int?
    ) -> ScreenshotDecision {
        guard includeScreenshot else { return .textOnly(reason: "disabled") }
        guard permissionGranted else { return .textOnly(reason: "permission") }
        guard let capturedBytes else { return .textOnly(reason: "captureFailed") }
        guard capturedBytes > 0 else { return .textOnly(reason: "empty") }
        guard capturedBytes <= maxAssetBytes else { return .textOnly(reason: "tooLarge") }
        return .attach
    }

    /// 降级原因 -> 中文日志文案
    static func reasonText(_ reason: String) -> String {
        switch reason {
        case "disabled": return "附截图已关闭"
        case "permission": return "没有屏幕录制权限"
        case "captureFailed": return "截图失败"
        case "empty": return "截图内容为空"
        case "tooLarge": return "截图超过 4MB 且无法降采样"
        default: return reason
        }
    }
}

// MARK: - 截图服务

enum ScreenshotError: LocalizedError {
    case permissionDenied
    case noDisplay
    case captureFailed(String)
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "没有「屏幕录制」权限，无法截图（App 会降级为纯文字笔记）"
        case .noDisplay:
            return "找不到可截图的显示器"
        case .captureFailed(let message):
            return "截图失败：\(message)"
        case .encodingFailed:
            return "截图无法编码为 PNG"
        }
    }
}

enum ScreenshotService {
    /// 抓当前显示器，返回 <=4MB 的 PNG（排除 livedub 自己的窗口）。
    static func captureDisplayPNG(excludeOwnApp: Bool = true) async throws -> Data {
        guard CGPreflightScreenCaptureAccess() else {
            throw ScreenshotError.permissionDenied
        }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            throw ScreenshotError.captureFailed(error.localizedDescription)
        }
        guard let display = content.displays.first else {
            throw ScreenshotError.noDisplay
        }

        var excludedApplications: [SCRunningApplication] = []
        if excludeOwnApp, let ownApp = content.applications.first(where: { $0.processID == getpid() }) {
            excludedApplications = [ownApp]
        }
        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludedApplications,
            exceptingWindows: []
        )

        let configuration = SCStreamConfiguration()
        configuration.width = Int(display.width)
        configuration.height = Int(display.height)
        configuration.showsCursor = false

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            throw ScreenshotError.captureFailed(error.localizedDescription)
        }
        guard let data = compressedPNG(from: image) else {
            throw ScreenshotError.encodingFailed
        }
        return data
    }

    /// CGImage -> PNG，按比例缩放（1.0 = 原尺寸）
    static func pngData(from image: CGImage, scale: CGFloat = 1.0) -> Data? {
        let scale = max(0.1, min(1.0, scale))
        let width = max(1, Int((CGFloat(image.width) * scale).rounded()))
        let height = max(1, Int((CGFloat(image.height) * scale).rounded()))
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width,
            pixelsHigh: height,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            return nil
        }
        rep.size = NSSize(width: width, height: height)
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.cgContext.interpolationQuality = .high
        context.cgContext.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }

    /// 依次尝试降采样，返回第一个 <=maxBytes 的 PNG；全超限返回 nil（调用方降级纯文字）。
    static func compressedPNG(from image: CGImage, maxBytes: Int = ScreenshotPlanner.maxAssetBytes) -> Data? {
        for scale in ScreenshotPlanner.scaleSteps {
            if let data = pngData(from: image, scale: scale), data.count <= maxBytes {
                return data
            }
        }
        return nil
    }
}
