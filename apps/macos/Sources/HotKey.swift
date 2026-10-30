//
//  HotKey.swift
//  livedub macOS 菜单栏 App
//
//  v0.4 全局快捷键 ⌥N（记笔记）：
//   用 Carbon RegisterEventHotKey（系统自带，不依赖第三方，也不需要「辅助功能 / 输入监控」授权）。
//   相比 NSEvent.addGlobalMonitorForEvents：Carbon 热键由系统注册，App 不在前台时也能触发；
//   只有 UIServer 级别的组合被占用时才注册失败（失败会提示并保留菜单「记笔记」入口）。
//

import Carbon.HIToolbox
import Foundation

/// 文件级回调：Carbon 的 C 函数指针不能捕获上下文，用全局闭包转接（只注册一个热键）。
private var livedubGlobalHotKeyHandler: (() -> Void)?

private func livedubHotKeyEventCallback(
    _ callRef: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    // Carbon 事件在主线程派发；异步一跳避免在系统事件处理过程中做重活（截图/网络）。
    DispatchQueue.main.async {
        livedubGlobalHotKeyHandler?()
    }
    return noErr
}

final class GlobalHotKey {
    static let shared = GlobalHotKey()

    /// 菜单/日志里展示的快捷键文案
    static let displayName = "⌥N"
    /// kVK_ANSI_N = 45（Carbon HIToolbox；self-test 断言）
    static let keyCode: UInt32 = UInt32(kVK_ANSI_N)
    /// Carbon optionKey（⌥）
    static let modifiers: UInt32 = UInt32(optionKey)
    /// 四字符签名 'LDNT'
    private static let signature: OSType = 0x4C444E54

    var onLog: ((String) -> Void)?

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private(set) var isRegistered = false

    private init() {}

    /// 注册 ⌥N。重复调用会更新 handler。返回是否成功。
    @discardableResult
    func register(handler: @escaping () -> Void) -> Bool {
        if isRegistered {
            livedubGlobalHotKeyHandler = handler
            return true
        }
        livedubGlobalHotKeyHandler = handler

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        var handlerRef: EventHandlerRef?
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            livedubHotKeyEventCallback,
            1,
            &eventType,
            nil,
            &handlerRef
        )
        guard installStatus == noErr else {
            onLog?("[notes] InstallEventHandler 失败：\(installStatus)")
            return false
        }

        let hotKeyID = EventHotKeyID(signature: Self.signature, id: 1)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            Self.keyCode,
            Self.modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        guard status == noErr else {
            RemoveEventHandler(handlerRef)
            onLog?("[notes] RegisterEventHotKey 失败：\(status)（\(Self.displayName) 可能被其它 App 占用）")
            return false
        }

        hotKeyRef = ref
        eventHandlerRef = handlerRef
        isRegistered = true
        return true
    }

    func unregister() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        if let eventHandlerRef {
            RemoveEventHandler(eventHandlerRef)
            self.eventHandlerRef = nil
        }
        livedubGlobalHotKeyHandler = nil
        isRegistered = false
    }
}
