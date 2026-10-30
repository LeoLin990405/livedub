// livedub 本地 OCR Helper（macOS Vision）
//
// 用系统 Vision 框架的 VNRecognizeTextRequest 做离线 OCR，不联网、不依赖 Tesseract。
// 由 scripts/build-ocr.sh 编译为 data/bin/ocr-macos；engine/vision/index.mjs 以子进程方式调用。
//
// 两种模式：
//
// 1) 单次模式（默认，每帧一个进程，进程启动/框架初始化约 1-6s，适合偶发调用）：
//   ocr-macos --image <png|jpg> [--langs en-US,zh-Hans] [--min-confidence 0.0] [--fast] [--text]
//   输出一行 JSON：
//     {"ok":true,"provider":"macos-vision","text":"...",
//      "lines":[{"text":"...","confidence":0.98,"x":..,"y":..,"w":..,"h":..}],
//      "ms":1234,"languages":[...],"image":{"width":1280,"height":720}}
//
// 2) 常驻模式（--serve，图文笔记逐帧 OCR 用；Vision/框架只初始化一次）：
//   ocr-macos --serve [--langs zh-Hans,en-US] [--min-confidence 0.0] [--fast]
//   - 启动后先输出一行 ready：{"ready":true,"provider":"macos-vision","pid":123,"languages":[...]}
//   - 之后从 stdin 逐行读请求：{"id":1,"image":"/tmp/frame.png","langs":["zh-Hans","en-US"],"minConfidence":0}
//     （langs/minConfidence 可省略，用启动参数默认值）
//   - stdout 每行一个响应：{"id":1,"ok":true,"provider":"macos-vision","text":...,"lines":[...],"ms":..}
//     出错时 {"id":1,"ok":false,"provider":"macos-vision","error":"image_not_found","message":"..."}，进程不退出
//   - stdin EOF 时退出 0；进程内缓存语言支持列表，请求级失败不影响后续请求。
//
// 设计约定：
// - 正常路径 stdout 里只有 JSON（Node 侧按行 JSON.parse），日志/诊断只走 stderr 且默认关闭（--verbose）；
// - 识别级别默认 accurate（幻灯片/代码小字质量明显好于 fast）；
// - 行序按「从上到下、同一行从左到右」重排（Vision 的原始顺序在幻灯片多栏时会乱）；
// - 时间 `ms` 是本次识别（含读图/handler）的墙钟耗时；serve 模式下进程初始化不计入单帧。

import Foundation
import Vision
import ImageIO
import CoreGraphics

// MARK: - 参数

struct Options {
    var imagePath: String = ""
    var languages: [String] = ["en-US", "zh-Hans"]
    var minConfidence: Float = 0
    var level: VNRequestTextRecognitionLevel = .accurate
    var plainText = false
    var verbose = false
    var serve = false
}

let usage = """
用法:
  ocr-macos --image <png|jpg> [选项]          单次识别，输出一行 JSON
  ocr-macos --serve [选项]                     常驻服务：stdin 逐行 JSON 请求，stdout 逐行 JSON 响应

选项:
  --image <path>          要识别的图片（单次模式必填；serve 模式下的请求里给 image）
  --langs a,b             识别语言优先级（默认 en-US,zh-Hans）
  --min-confidence <0-1>  低于该置信度的行丢弃（默认 0，即全部保留）
  --fast                  使用 fast 级别（更快，小字质量下降）
  --serve                 常驻模式（启动后先输出 ready 行，再处理逐行请求；stdin EOF 退出）
  --text                  只输出纯文本（仅单次模式）
  --verbose               往 stderr 打印耗时/行数等诊断信息
  -h, --help              显示帮助
"""

func writeLine(_ object: [String: Any]) {
    let data: Data
    do {
        data = try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    } catch {
        let fallback = Data("{\"ok\":false,\"provider\":\"macos-vision\",\"error\":\"encode_failed\",\"message\":\"JSON 编码失败\"}".utf8)
        FileHandle.standardOutput.write(fallback)
        FileHandle.standardOutput.write(Data("\n".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

/// 带退出码的输出（单次模式的错误路径）
func printJsonAndExit(_ object: [String: Any], exitCode: Int32) -> Never {
    writeLine(object)
    exit(exitCode)
}

func failAndExit(_ code: String, _ message: String) -> Never {
    printJsonAndExit(["ok": false, "provider": "macos-vision", "error": code, "message": message], exitCode: 1)
}

struct OcrError: Error {
    let code: String
    let message: String
}

func parseOptions(_ args: [String]) -> Options {
    var opts = Options()
    var index = 0
    func value(_ name: String) -> String {
        guard index + 1 < args.count else { failAndExit("bad_args", "参数 \(name) 缺少取值；运行 ocr-macos --help 查看用法") }
        index += 1
        return args[index]
    }
    while index < args.count {
        let arg = args[index]
        switch arg {
        case "--image":
            opts.imagePath = value("--image")
        case "--langs", "--languages":
            let raw = value(arg)
            let langs = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if langs.isEmpty { failAndExit("bad_args", "参数 \(arg) 不能为空；示例：--langs en-US,zh-Hans") }
            opts.languages = langs
        case "--min-confidence":
            let raw = value("--min-confidence")
            guard let v = Float(raw), v >= 0, v <= 1 else {
                failAndExit("bad_args", "--min-confidence 需要 0~1 的数字，收到：\(raw)")
            }
            opts.minConfidence = v
        case "--fast":
            opts.level = .fast
        case "--serve":
            opts.serve = true
        case "--text":
            opts.plainText = true
        case "--verbose", "-v":
            opts.verbose = true
        case "-h", "--help":
            FileHandle.standardOutput.write(Data((usage + "\n").utf8))
            exit(0)
        default:
            failAndExit("bad_args", "未知参数：\(arg)；运行 ocr-macos --help 查看用法")
        }
        index += 1
    }
    if !opts.serve && opts.imagePath.isEmpty {
        failAndExit("bad_args", "缺少 --image <path>；运行 ocr-macos --help 查看用法")
    }
    return opts
}

// MARK: - 工具

func stderrLog(_ message: String, verbose: Bool) {
    guard verbose else { return }
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

let recognitionRevision = VNRecognizeTextRequestRevision3

/// 请求的语言里只保留 Vision 支持的（否则 perform 会整体失败）；顺序保留调用方语义。
/// 这个函数在 serve 模式启动时调用一次并缓存结果，避免每帧重复探测。
func supportedLanguages(requested: [String], level: VNRequestTextRecognitionLevel) -> [String] {
    let available: [String]
    if let list = try? VNRecognizeTextRequest.supportedRecognitionLanguages(for: level, revision: recognitionRevision) {
        available = list
    } else {
        available = []
    }
    if available.isEmpty { return requested }
    let supported = requested.filter { language in
        available.contains { $0.caseInsensitiveCompare(language) == .orderedSame }
    }
    if !supported.isEmpty { return supported }
    // 请求的语言全都不可用时退回 Vision 的第一个可用语言（至少能出结果）
    return Array(available.prefix(1))
}

struct RecognizedLine {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let midY: Double
    let minX: Double
}

/// 按「从上到下、同一视觉行内从左到右」排序。Vision 的 boundingBox 原点在左下角。
func sortReadingOrder(_ lines: [RecognizedLine]) -> [RecognizedLine] {
    let sortedTopDown = lines.sorted { a, b in
        if abs(a.midY - b.midY) > 0.004 { return a.midY > b.midY }
        return a.minX < b.minX
    }
    var rows: [[RecognizedLine]] = []
    for line in sortedTopDown {
        if var last = rows.last, let anchor = last.first, abs(anchor.midY - line.midY) <= 0.022 {
            last.append(line)
            rows[rows.count - 1] = last
        } else {
            rows.append([line])
        }
    }
    return rows.flatMap { $0.sorted { $0.minX < $1.minX } }
}

/// 识别一张图片。request 每次新建（VNRequest 生命周期按帧隔离更稳），语言列表由调用方缓存。
func recognizeImage(path: String, languages: [String], level: VNRequestTextRecognitionLevel, minConfidence: Float) throws -> (text: String, lines: [RecognizedLine], width: Int, height: Int) {
    let expanded = (path as NSString).expandingTildeInPath
    guard FileManager.default.fileExists(atPath: expanded) else {
        throw OcrError(code: "image_not_found", message: "找不到图片：\(expanded)；请检查路径，或先用 ffmpeg 从视频抽帧")
    }
    let imageURL = URL(fileURLWithPath: expanded)
    guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil) else {
        throw OcrError(code: "image_unreadable", message: "无法读取图片（格式不支持？）：\(expanded)；请用 PNG/JPEG 重试")
    }
    guard let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw OcrError(code: "image_decode_failed", message: "图片内容解码失败：\(expanded)；请确认文件未损坏")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    request.usesLanguageCorrection = true
    request.revision = recognitionRevision
    request.recognitionLanguages = languages

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw OcrError(code: "vision_failed", message: "Vision OCR 失败：\(error.localizedDescription)；可尝试 --fast 或换更清晰的截图")
    }

    var lines: [RecognizedLine] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        if candidate.confidence < minConfidence { continue }
        let text = candidate.string
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
        let box = observation.boundingBox
        lines.append(RecognizedLine(
            text: text,
            confidence: candidate.confidence,
            x: Double(box.origin.x),
            y: Double(box.origin.y),
            width: Double(box.size.width),
            height: Double(box.size.height),
            midY: Double(box.origin.y + box.size.height / 2),
            minX: Double(box.origin.x)
        ))
    }
    lines = sortReadingOrder(lines)
    let text = lines.map { $0.text }.joined(separator: "\n")
    return (text, lines, cgImage.width, cgImage.height)
}

func lineObjects(_ lines: [RecognizedLine]) -> [[String: Any]] {
    lines.map { line in
        [
            "text": line.text,
            "confidence": line.confidence,
            "x": line.x,
            "y": line.y,
            "w": line.width,
            "h": line.height,
        ]
    }
}

// MARK: - 单次模式

func runSingleShot(_ opts: Options) -> Never {
    let startedAt = DispatchTime.now().uptimeNanoseconds
    let languages = supportedLanguages(requested: opts.languages, level: opts.level)
    do {
        let result = try recognizeImage(path: opts.imagePath, languages: languages, level: opts.level, minConfidence: opts.minConfidence)
        let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
        stderrLog("ocr-macos: \(result.lines.count) 行, \(elapsedMs)ms, level=\(opts.level == .accurate ? "accurate" : "fast"), langs=\(languages.joined(separator: ","))", verbose: opts.verbose)
        if opts.plainText {
            FileHandle.standardOutput.write(Data((result.text + "\n").utf8))
            exit(0)
        }
        printJsonAndExit([
            "ok": true,
            "provider": "macos-vision",
            "text": result.text,
            "lines": lineObjects(result.lines),
            "ms": elapsedMs,
            "languages": languages,
            "level": opts.level == .accurate ? "accurate" : "fast",
            "image": ["width": result.width, "height": result.height],
        ], exitCode: 0)
    } catch let error as OcrError {
        failAndExit(error.code, error.message)
    } catch {
        failAndExit("ocr_failed", "OCR 失败：\(error.localizedDescription)")
    }
}

// MARK: - 常驻模式

func runServe(_ opts: Options) -> Never {
    let supported = supportedLanguages(requested: opts.languages, level: opts.level)
    // 先发 ready，Node 侧等到这一行再投递请求（进程初始化/框架加载都在这之前完成）
    writeLine([
        "ready": true,
        "provider": "macos-vision",
        "pid": Int(ProcessInfo.processInfo.processIdentifier),
        "languages": supported,
        "level": opts.level == .accurate ? "accurate" : "fast",
    ])
    stderrLog("ocr-macos serve: ready (langs=\(supported.joined(separator: ",")))", verbose: opts.verbose)

    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        let requestStartedAt = DispatchTime.now().uptimeNanoseconds
        guard let data = trimmed.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            writeLine(["id": NSNull(), "ok": false, "provider": "macos-vision", "error": "bad_request", "message": "请求不是合法 JSON 对象：\(trimmed.prefix(120))"])
            continue
        }
        let id: Any = raw["id"] ?? NSNull()
        let imagePath = (raw["image"] as? String) ?? ""
        if imagePath.isEmpty {
            writeLine(["id": id, "ok": false, "provider": "macos-vision", "error": "image_not_found", "message": "请求缺少 image 字段（本地图片路径）"])
            continue
        }
        var languages = supported
        if let requested = raw["langs"] as? [String], !requested.isEmpty {
            languages = supportedLanguages(requested: requested, level: opts.level)
        }
        var minConfidence = opts.minConfidence
        if let number = raw["minConfidence"] as? NSNumber {
            minConfidence = max(0, min(1, number.floatValue))
        }
        do {
            let result = try recognizeImage(path: imagePath, languages: languages, level: opts.level, minConfidence: minConfidence)
            let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - requestStartedAt) / 1_000_000)
            stderrLog("ocr-macos serve: id=\(id) \(result.lines.count) 行 \(elapsedMs)ms", verbose: opts.verbose)
            writeLine([
                "id": id,
                "ok": true,
                "provider": "macos-vision",
                "text": result.text,
                "lines": lineObjects(result.lines),
                "ms": elapsedMs,
                "languages": languages,
                "image": ["width": result.width, "height": result.height],
            ])
        } catch let error as OcrError {
            writeLine(["id": id, "ok": false, "provider": "macos-vision", "error": error.code, "message": error.message])
        } catch {
            writeLine(["id": id, "ok": false, "provider": "macos-vision", "error": "ocr_failed", "message": "OCR 失败：\(error.localizedDescription)"])
        }
    }
    exit(0)
}

// MARK: - 入口

let opts = parseOptions(Array(CommandLine.arguments.dropFirst()))
if opts.serve {
    runServe(opts)
} else {
    runSingleShot(opts)
}
