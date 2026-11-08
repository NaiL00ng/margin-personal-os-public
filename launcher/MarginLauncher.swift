import AppKit
import Foundation

// Local, dependency-free macOS front end. Only its own Python child is stopped.
final class LauncherDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var statusLabel: NSTextField!
    var detailLabel: NSTextField!
    var openButton: NSButton!
    var closeButton: NSButton!
    var child: Process?
    var ownsService = false
    var busy = false
    var stopping = false
    var readyURL: URL?
    let project: URL
    let python: String

    override init() {
        let beside = Bundle.main.bundleURL.deletingLastPathComponent()
        let recorded = Bundle.main.object(forInfoDictionaryKey: "MarginProjectPath") as? String ?? ""
        project = FileManager.default.fileExists(atPath: beside.appendingPathComponent("launcher.py").path)
            ? beside : URL(fileURLWithPath: recorded, isDirectory: true)
        python = Bundle.main.object(forInfoDictionaryKey: "MarginPythonPath") as? String ?? "/usr/bin/python3"
        super.init()
    }

    func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular) -> NSTextField {
        let view = NSTextField(wrappingLabelWithString: text)
        view.font = .systemFont(ofSize: size, weight: weight)
        view.textColor = NSColor(calibratedRed: 0.19, green: 0.23, blue: 0.21, alpha: 1)
        view.alignment = .center
        view.maximumNumberOfLines = 0
        return view
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出余白启动器", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 340),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "余白 · 本机启动器"
        window.backgroundColor = NSColor(calibratedRed: 0.97, green: 0.96, blue: 0.93, alpha: 1)
        window.isReleasedWhenClosed = false
        window.delegate = self
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 13
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -32),
            stack.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor)
        ])
        let icon = NSImageView()
        icon.image = NSImage(named: NSImage.Name("AppIcon")) ?? NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.widthAnchor.constraint(equalToConstant: 54).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 54).isActive = true
        stack.addArrangedSubview(icon)
        stack.addArrangedSubview(label("余白  MARGIN", size: 25, weight: .semibold))
        stack.addArrangedSubview(label("留一点时间，给自己。", size: 13))
        statusLabel = label("正在检查本机服务…", size: 14, weight: .medium)
        stack.addArrangedSubview(statusLabel)
        detailLabel = label("便利贴保存在项目内的 SQLite 数据库。", size: 12)
        stack.addArrangedSubview(detailLabel)
        detailLabel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 12
        openButton = NSButton(title: "打开看板", target: self, action: #selector(openBoard))
        openButton.bezelStyle = .rounded
        openButton.keyEquivalent = "\r"
        closeButton = NSButton(title: "关闭启动器", target: NSApp, action: #selector(NSApplication.terminate(_:)))
        closeButton.bezelStyle = .rounded
        actions.addArrangedSubview(openButton)
        actions.addArrangedSubview(closeButton)
        stack.addArrangedSubview(actions)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        start()
    }

    func start() {
        guard !busy, !stopping else { return }
        if child?.isRunning == true {
            statusLabel.stringValue = "正在等候上次启动退出…"
            detailLabel.stringValue = "前一个辅助进程仍在收尾，请稍后再点重试。不会重复启动服务。"
            return
        }
        busy = true
        ownsService = false
        readyURL = nil
        openButton.isEnabled = false
        statusLabel.stringValue = "正在检查本机服务…"
        guard FileManager.default.fileExists(atPath: project.appendingPathComponent("launcher.py").path),
              FileManager.default.isExecutableFile(atPath: python) else {
            showError("找不到项目文件或 Python。请将启动器放回项目目录，或在项目中重新构建。")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-B", project.appendingPathComponent("launcher.py").path]
        process.currentDirectoryURL = project
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                guard let self = self, self.child === ended, !self.stopping, self.ownsService else { return }
                self.showError("本次启动的服务已停止。已保存的便利贴仍在，点击重试即可重新启动。")
            }
        }
        do { try process.run() }
        catch { showError("Python 未能启动。请检查项目路径和执行权限。") ; return }
        child = process
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self = self, self.child === process, self.busy, !self.stopping else { return }
            self.showError("启动等待超时，请检查项目和数据库是否可访问，然后重试。")
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var line = Data()
            while line.count < 65536 {
                guard let byte = try? output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else { break }
                if byte == Data([10]) { break }
                line.append(byte)
            }
            let reply = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
            DispatchQueue.main.async {
                guard let self = self, self.child === process, self.busy, !self.stopping else { return }
                self.busy = false
                guard let reply = reply, let status = reply["status"] as? String,
                      status == "started" || status == "reused",
                      let address = reply["url"] as? String,
                      address == "http://127.0.0.1:4317", let url = URL(string: address) else {
                    self.showError(reply?["message"] as? String ?? "启动器未收到有效响应，请重试或查看后端使用说明。")
                    return
                }
                self.ownsService = status == "started"
                if self.ownsService && !process.isRunning {
                    self.showError("服务启动后提前退出，请重试或检查数据库权限。")
                    return
                }
                self.readyURL = url
                self.statusLabel.stringValue = status == "started" ? "本机服务已启动" : "已连接正在运行的本机服务"
                self.detailLabel.stringValue = self.ownsService
                    ? "关闭网页不影响保存。退出启动器会停止本次服务，下次打开继续读取原记录。"
                    : "已复用同一项目、同一数据库的服务。退出此启动器不会停止原有服务。"
                self.closeButton.title = self.ownsService ? "停止服务并退出" : "关闭启动器"
                self.openButton.title = "打开看板"
                self.openButton.isEnabled = true
                self.openPage()
            }
        }
    }

    func showError(_ message: String) {
        if let process = child, process.isRunning { process.terminate() }
        busy = false
        ownsService = false
        readyURL = nil
        statusLabel.stringValue = "暂时无法打开看板"
        detailLabel.stringValue = message
        openButton.title = "重试启动"
        openButton.isEnabled = true
        closeButton.title = "关闭启动器"
    }

    @objc func openBoard() {
        if ownsService, child?.isRunning == true, readyURL != nil { openPage() }
        else { start() } // Re-check a reused service: its external owner may have stopped it.
    }

    func openPage() {
        if let url = readyURL {
            if !NSWorkspace.shared.open(url) {
                detailLabel.stringValue = "服务已就绪，请在浏览器打开 http://127.0.0.1:4317。"
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard !stopping else { return false }
        window.makeKeyAndOrderFront(nil)
        if !busy { openBoard() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        stopping = true
        // The helper itself owns the server, so a reused external server is never signalled.
        guard let process = child, process.isRunning else { return .terminateNow }
        statusLabel.stringValue = "正在停止本次服务…"
        detailLabel.stringValue = "正在等候已接收的请求结束，已保存的便利贴会保留。"
        openButton.isEnabled = false
        closeButton.isEnabled = false
        process.terminate()
        DispatchQueue.global(qos: .userInitiated).async {
            process.waitUntilExit()
            DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}

func renderIcon(to path: String) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor(calibratedRed: 0.96, green: 0.94, blue: 0.88, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 48, y: 48, width: 928, height: 928), xRadius: 214, yRadius: 214).fill()
    let colours: [(CGFloat, CGFloat, CGFloat)] = [(0.58,0.69,0.61),(0.80,0.58,0.44),(0.73,0.72,0.65),(0.71,0.66,0.48)]
    let points = [(200,544),(544,544),(200,200),(544,200)]
    for (i, point) in points.enumerated() {
        let c = colours[i]
        NSColor(calibratedRed: c.0, green: c.1, blue: c.2, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: point.0, y: point.1, width: 280, height: 280), xRadius: 46, yRadius: 46).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--render-icon" {
    do { try renderIcon(to: CommandLine.arguments[2]) } catch { exit(1) }
} else {
    let app = NSApplication.shared
    let delegate = LauncherDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
