import AppKit
import Darwin
import CoreFoundation

// AppKit can enter a nested termination run loop. Schedule completion callbacks
// in its modes as well, so Quit never waits on a blocked main dispatch callback.
private func onMain(_ block: @escaping () -> Void) {
    RunLoop.main.perform(inModes: [.default, .common, .modalPanel, .eventTracking], block: block)
    CFRunLoopWakeUp(CFRunLoopGetMain())
}

// A small native supervisor for the same browser app shipped through npm.
// Session URLs stay in memory; stdout is consumed over a pipe, never logged to disk.
final class CodeFlowApp: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var child: Process?
    private var output = ""
    private var recent = ""
    private var ownerURL: URL?
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Code Flow"
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Code Flow", action: #selector(openApp), keyEquivalent: "o").target = self
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Quit Code Flow", action: #selector(quit), keyEquivalent: "q").target = self
        item.menu = menu
        start()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openApp()
        return true
    }

    @objc private func openApp() {
        if let url = ownerURL { NSWorkspace.shared.open(url) }
        else if child == nil { start() }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func start() {
        guard let resources = Bundle.main.resourceURL else { return }
        let process = Process()
        let pipe = Pipe()
        process.executableURL = resources.appendingPathComponent("node/bin/node")
        process.arguments = [resources.appendingPathComponent("app/bin/codeflow.mjs").path]
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var env = ProcessInfo.processInfo.environment
        // Finder starts with a minimal PATH. Include common CLI installations; use
        // the login shell only to obtain PATH, never to evaluate the launch command.
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let fallback = "\(home)/.local/bin:\(home)/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        let shellPath = env["SHELL"] ?? "/bin/zsh"
        let shell = Process()
        let shellPipe = Pipe()
        shell.executableURL = URL(fileURLWithPath: shellPath)
        shell.arguments = ["-ilc", "printf '\\nCODEFLOW_PATH=%s\\n' \"$PATH\""]
        shell.standardOutput = shellPipe
        shell.standardError = FileHandle.nullDevice
        shell.standardInput = FileHandle.nullDevice
        // Bound startup even when a shell profile stalls or emits too much output.
        var shellOutput = Data()
        let shellQueue = DispatchQueue(label: "codeflow.path")
        shellPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            shellQueue.sync { if shellOutput.count < 131072 { shellOutput.append(data.prefix(131072 - shellOutput.count)) } }
        }
        do {
            try shell.run()
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { if shell.isRunning { kill(shell.processIdentifier, SIGKILL) } }
            shell.waitUntilExit()
        } catch {}
        shellPipe.fileHandleForReading.readabilityHandler = nil
        let pathText = shellQueue.sync { String(data: shellOutput, encoding: .utf8) ?? "" }
        let loginPath = pathText.components(separatedBy: "\n").last(where: { $0.hasPrefix("CODEFLOW_PATH=") }).map { String($0.dropFirst(14)) }
        env["PATH"] = resources.appendingPathComponent("node/bin").path + ":" + (loginPath ?? env["PATH"] ?? fallback) + ":" + fallback
        env["CODEFLOW_DESKTOP"] = "1"
        process.environment = env
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = pipe
        process.standardError = pipe
        output = ""
        recent = ""
        ownerURL = nil
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(decoding: data, as: UTF8.self)
            onMain { self?.consume(text) }
        }
        process.terminationHandler = { [weak self] process in
            pipe.fileHandleForReading.readabilityHandler = nil
            onMain {
                guard let self = self else { return }
                self.child = nil
                self.ownerURL = nil
                if self.quitting { NSApp.reply(toApplicationShouldTerminate: true) }
                else {
                    self.item.button?.title = "Code Flow · stopped"
                    let alert = NSAlert()
                    alert.messageText = "Code Flow stopped"
                    alert.informativeText = self.recent.isEmpty ? "Open Code Flow from the menu bar to try again. Git 2.38+ and a signed-in agent CLI are required." : self.recent
                    alert.runModal()
                }
            }
        }
        do {
            try process.run()
            child = process
            item.button?.title = "Code Flow · starting"
        } catch {
            let alert = NSAlert()
            alert.messageText = "Could not start Code Flow"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    private func consume(_ text: String) {
        output += text
        while let newline = output.firstIndex(of: "\n") {
            let line = String(output[..<newline])
            output.removeSubrange(...newline)
            if line.hasPrefix("CODEFLOW_READY "),
               let data = String(line.dropFirst(15)).data(using: .utf8),
               let value = try? JSONSerialization.jsonObject(with: data) as? [String: String],
               let raw = value["url"], let url = URL(string: raw),
               url.scheme == "http", url.host == "localhost" {
                ownerURL = url
                item.button?.title = "Code Flow"
            } else if !line.contains("?token=") {
                recent = String((recent + line + "\n").suffix(3000))
            }
        }
        output = String(output.suffix(16384))
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let process = child, process.isRunning else { return .terminateNow }
        quitting = true
        item.button?.title = "Code Flow · stopping"
        process.terminate() // The npm supervisor forwards TERM to the server for graceful shutdown.
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = CodeFlowApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
// Finder's Quit command and ordinary process signals both stop the backend cleanly.
let signalSources: [DispatchSourceSignal] = [SIGTERM, SIGINT, SIGHUP].map { number in
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { onMain { app.terminate(nil) } }
    source.resume()
    return source
}
app.run()
