//
//  EngineLauncher.swift
//  livedub macOS 菜单栏 App
//
//  打开 App 时把本机引擎一起拉起来。已经在听的引擎直接复用；
//  退出时只关掉这次由 App 拉起的进程，不误伤用户另开的引擎。
//  --simulate / --self-test 不拉起。决策函数不联网、不创建进程，供 self-test 覆盖。
//

import Foundation

enum EngineBootKind: Equatable {
    case alreadyRunning
    case adopt
    case spawn
    case skipped
    case failed
}

struct EngineBootOutcome: Equatable {
    var kind: EngineBootKind
    var detail: String
    var ownsProcess: Bool
}

enum EngineLaunchPlanner {
    static func healthURL(engineWebSocket raw: String) -> URL? {
        let normalized = Settings.normalizeEngineURL(raw)
        guard var components = URLComponents(string: normalized) else { return nil }
        switch components.scheme {
        case "ws":
            components.scheme = "http"
        case "wss":
            components.scheme = "https"
        default:
            return nil
        }
        guard let host = components.host, !host.isEmpty else { return nil }
        components.path = "/health"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    static func isLoopback(_ host: String) -> Bool {
        switch host.lowercased() {
        case "127.0.0.1", "localhost", "::1", "[::1]":
            return true
        default:
            return false
        }
    }

    /// 只有非默认端口才传 `--port`，避免改掉引擎自己的默认值。
    static func serverArguments(engineURL: String) -> [String] {
        var args = ["engine/server.mjs"]
        let normalized = Settings.normalizeEngineURL(engineURL)
        if let port = URLComponents(string: normalized)?.port, port != LiveDubProtocol.enginePort {
            args.append("--port")
            args.append(String(port))
        }
        return args
    }

    static func looksLikeLivedubRoot(_ root: String, fileExists: (String) -> Bool) -> Bool {
        let script = (root as NSString).appendingPathComponent("engine/server.mjs")
        return fileExists(script)
    }

    static func commandOwnsEngine(_ command: String?) -> Bool {
        guard let command else { return false }
        return command.contains("engine/server.mjs")
    }

    static func candidateRoots(executablePath: String, envRoot: String?, homeDirectory: String) -> [String] {
        var roots: [String] = []
        if let envRoot {
            let trimmed = envRoot.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { roots.append(trimmed) }
        }
        var dir = (executablePath as NSString).deletingLastPathComponent
        if !dir.isEmpty && dir != "/" {
            for _ in 0..<8 {
                roots.append(dir)
                let parent = (dir as NSString).deletingLastPathComponent
                if parent == dir || parent.isEmpty || parent == "/" { break }
                dir = parent
            }
        }
        if !homeDirectory.isEmpty {
            roots.append((homeDirectory as NSString).appendingPathComponent("livedub"))
        }
        var seen = Set<String>()
        return roots.filter { seen.insert($0).inserted }
    }

    static func resolveNode(candidates: [String], isExecutable: (String) -> Bool) -> String? {
        candidates.first(where: { !$0.isEmpty && isExecutable($0) })
    }

    static func isLivedubHealth(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return object["ok"] as? Bool == true && object["name"] as? String == "livedub"
    }

    static func menuTitle(detail: String, engineURL: String) -> String {
        if detail.isEmpty { return "引擎：\(engineURL)" }
        return "引擎：\(detail)"
    }

    /// 纯决策：健康则复用；本机回环且不健康才拉起；远端地址、模拟模式、缺项目或 node 则跳过。
    static func decide(
        engineURL: String,
        healthOK: Bool,
        simulate: Bool,
        ownedCommand: String?,
        roots: [String],
        nodeCandidates: [String],
        fileExists: (String) -> Bool,
        isExecutable: (String) -> Bool
    ) -> EngineBootOutcome {
        if simulate {
            return EngineBootOutcome(kind: .skipped, detail: "模拟模式，未拉起", ownsProcess: false)
        }
        guard let health = healthURL(engineWebSocket: engineURL),
              let host = URLComponents(url: health, resolvingAgainstBaseURL: false)?.host,
              isLoopback(host) else {
            return EngineBootOutcome(kind: .skipped, detail: "外部地址，不在本机拉起", ownsProcess: false)
        }
        if healthOK {
            if commandOwnsEngine(ownedCommand) {
                return EngineBootOutcome(kind: .adopt, detail: "已随 App 启动", ownsProcess: true)
            }
            return EngineBootOutcome(kind: .alreadyRunning, detail: "本机已在运行", ownsProcess: false)
        }
        guard roots.contains(where: { looksLikeLivedubRoot($0, fileExists: fileExists) }) else {
            return EngineBootOutcome(kind: .skipped, detail: "找不到 livedub 项目，未能自动启动", ownsProcess: false)
        }
        guard resolveNode(candidates: nodeCandidates, isExecutable: isExecutable) != nil else {
            return EngineBootOutcome(kind: .skipped, detail: "找不到 node，未能自动启动", ownsProcess: false)
        }
        return EngineBootOutcome(kind: .spawn, detail: "正在启动…", ownsProcess: true)
    }
}

/// 真正拉起 `node engine/server.mjs`。子进程由 bash 照看：App 退出或被杀掉后，引擎会收到 SIGTERM 并自己收掉 whisper。
final class LocalEngineSupervisor {
    static let pidKey = "livedub.macos.ownedEnginePID"
    /// bash 照看脚本。node 路径和参数走 argv，不拼进脚本文本。
    static let watchScript = """
    node="$1"
    shift
    parent=$PPID
    trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
    "$node" engine/server.mjs "$@" &
    child=$!
    while kill -0 "$parent" 2>/dev/null; do
      if ! kill -0 "$child" 2>/dev/null; then
        wait "$child"
        exit $?
      fi
      sleep 1
    done
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
    """

    var onLog: ((String) -> Void)?

    private let defaults: UserDefaults
    private let queue = DispatchQueue(label: "com.livedub.macos.engine-launch")
    private let stateLock = NSLock()
    private var stopped = false
    private var process: Process?
    private var adoptedPID: Int32?
    private var outputTail = ""

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func ensureRunning(engineURL: String, simulate: Bool, completion: @escaping (EngineBootOutcome) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            completion(self.ensureRunningSync(engineURL: engineURL, simulate: simulate))
        }
    }

    func stopIfOwned() {
        stateLock.lock()
        stopped = true
        let process = self.process
        let adopted = self.adoptedPID
        stateLock.unlock()
        if let process, process.isRunning {
            process.terminate()
        } else if let adopted, adopted > 0 {
            Self.signal(pid: adopted)
        }
        defaults.removeObject(forKey: Self.pidKey)
    }

    private func ensureRunningSync(engineURL: String, simulate: Bool) -> EngineBootOutcome {
        if isStopped {
            return EngineBootOutcome(kind: .skipped, detail: "App 正在退出", ownsProcess: false)
        }
        stateLock.lock()
        if let process, process.isRunning {
            stateLock.unlock()
            return EngineBootOutcome(kind: .spawn, detail: "已随 App 启动", ownsProcess: true)
        }
        stateLock.unlock()

        let health = EngineLaunchPlanner.healthURL(engineWebSocket: engineURL)
        let healthOK = health.map { Self.probe($0) } ?? false
        let saved = Int32(defaults.integer(forKey: Self.pidKey))
        let ownedCommand = saved > 0 ? Self.command(for: saved) : nil
        if saved > 0 && !EngineLaunchPlanner.commandOwnsEngine(ownedCommand) {
            defaults.removeObject(forKey: Self.pidKey)
        }

        let executable = Bundle.main.executableURL?.path ?? CommandLine.arguments.first ?? ""
        let roots = EngineLaunchPlanner.candidateRoots(
            executablePath: executable,
            envRoot: ProcessInfo.processInfo.environment["LIVEDUB_ROOT"],
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser.path
        )
        var nodeCandidates = Self.nodeCandidates()
        if EngineLaunchPlanner.resolveNode(candidates: nodeCandidates, isExecutable: Self.isExecutable) == nil,
           let shellNode = Self.shellNode() {
            nodeCandidates.insert(shellNode, at: 0)
        }
        let outcome = EngineLaunchPlanner.decide(
            engineURL: engineURL,
            healthOK: healthOK,
            simulate: simulate,
            ownedCommand: ownedCommand,
            roots: roots,
            nodeCandidates: nodeCandidates,
            fileExists: { FileManager.default.fileExists(atPath: $0) },
            isExecutable: Self.isExecutable
        )
        switch outcome.kind {
        case .alreadyRunning, .skipped:
            return outcome
        case .adopt:
            if saved > 0 { rememberAdopted(saved) }
            return EngineBootOutcome(kind: .adopt, detail: "已随 App 启动", ownsProcess: true)
        case .spawn:
            guard let root = roots.first(where: { EngineLaunchPlanner.looksLikeLivedubRoot($0, fileExists: { FileManager.default.fileExists(atPath: $0) }) }),
                  let node = EngineLaunchPlanner.resolveNode(candidates: nodeCandidates, isExecutable: Self.isExecutable) else {
                return EngineBootOutcome(kind: .failed, detail: "启动失败", ownsProcess: false)
            }
            if isStopped {
                return EngineBootOutcome(kind: .skipped, detail: "App 正在退出", ownsProcess: false)
            }
            do {
                try spawn(root: root, node: node, engineURL: engineURL)
            } catch {
                return EngineBootOutcome(kind: .failed, detail: "启动失败：\(error.localizedDescription)", ownsProcess: false)
            }
            guard let health else {
                return EngineBootOutcome(kind: .failed, detail: "启动失败", ownsProcess: true)
            }
            if waitUntilHealthy(health) {
                return EngineBootOutcome(kind: .spawn, detail: "已随 App 启动", ownsProcess: true)
            }
            let tail = failureTail()
            return EngineBootOutcome(
                kind: .failed,
                detail: tail.isEmpty ? "启动失败" : "启动失败：\(tail)",
                ownsProcess: true
            )
        case .failed:
            return outcome
        }
    }

    private var isStopped: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stopped
    }

    private func rememberAdopted(_ pid: Int32) {
        stateLock.lock()
        adoptedPID = pid
        stateLock.unlock()
        defaults.set(Int(pid), forKey: Self.pidKey)
    }

    private func spawn(root: String, node: String, engineURL: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        var arguments = ["-c", Self.watchScript, "livedub-engine", node]
        let serverArgs = EngineLaunchPlanner.serverArguments(engineURL: engineURL)
        if serverArgs.count > 1 {
            arguments.append(contentsOf: serverArgs.dropFirst())
        }
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: root, isDirectory: true)
        var env = ProcessInfo.processInfo.environment
        let nodeBin = (node as NSString).deletingLastPathComponent
        let path = env["PATH"] ?? ""
        env["PATH"] = "\(nodeBin):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(path)"
        process.environment = env
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
        try process.run()
        stateLock.lock()
        self.process = process
        self.adoptedPID = nil
        stateLock.unlock()
        defaults.set(Int(process.processIdentifier), forKey: Self.pidKey)
        onLog?("[engine-boot] 拉起 \(node) \(root)/engine/server.mjs")
    }

    private func waitUntilHealthy(_ health: URL) -> Bool {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if isStopped { return false }
            stateLock.lock()
            let running = process?.isRunning ?? false
            stateLock.unlock()
            if !running { return false }
            if Self.probe(health) { return true }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return false
    }

    private func consume(_ data: Data) {
        guard !data.isEmpty, let text = String(data: data, encoding: .utf8), !text.isEmpty else { return }
        stateLock.lock()
        outputTail.append(text)
        if outputTail.count > 4_000 {
            outputTail.removeFirst(outputTail.count - 4_000)
        }
        stateLock.unlock()
    }

    private func failureTail() -> String {
        stateLock.lock()
        let tail = outputTail
        stateLock.unlock()
        let line = tail
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .last { !$0.isEmpty } ?? ""
        if line.count > 160 { return String(line.suffix(160)) }
        return line
    }

    private static func nodeCandidates() -> [String] {
        var candidates: [String] = []
        if let env = ProcessInfo.processInfo.environment["LIVEDUB_NODE"] {
            candidates.append(env)
        }
        candidates.append(contentsOf: ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                candidates.append("\(dir)/node")
            }
        }
        return candidates
    }

    private static func isExecutable(_ path: String) -> Bool {
        FileManager.default.isExecutableFile(atPath: path)
    }

    private static func shellNode() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let text, text.hasPrefix("/") else { return nil }
        return text
    }

    private static func probe(_ url: URL) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1.2
        config.timeoutIntervalForResource = 1.5
        let session = URLSession(configuration: config)
        var ok = false
        let task = session.dataTask(with: url) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200, let data, EngineLaunchPlanner.isLivedubHealth(data) {
                ok = true
            }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 1.8)
        session.invalidateAndCancel()
        return ok
    }

    private static func command(for pid: Int32) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-p", String(pid), "-o", "command="]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { return nil }
        process.waitUntilExit()
        let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let text, !text.isEmpty else { return nil }
        return text
    }

    private static func signal(pid: Int32) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/kill")
        process.arguments = ["-TERM", String(pid)]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try? process.run()
        process.waitUntilExit()
    }
}
