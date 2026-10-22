import Foundation
import AppKit
let application = NSApplication.shared
let previousApp = NSWorkspace.shared.frontmostApplication
application.setActivationPolicy(.regular)
let screen = NSScreen.main!
class FixtureWindow: NSWindow { override var canBecomeKey: Bool { true }; override var canBecomeMain: Bool { true } }
let window = FixtureWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.title = "Codeflow Computer Fixture"
window.appearance = NSAppearance(named: .aqua)
window.backgroundColor = .white
window.level = .screenSaver
let field = NSTextField(frame: NSRect(x: 100, y: screen.frame.height - 220, width: 400, height: 40))
field.placeholderString = "Enter the test phrase"
field.font = NSFont.systemFont(ofSize: 22)
field.setAccessibilityLabel("Test phrase")
let label = NSTextField(labelWithString: "Codeflow computer-use test")
label.frame = NSRect(x: 100, y: screen.frame.height - 130, width: 800, height: 50)
label.font = NSFont.systemFont(ofSize: 32)
let description = NSTextField(labelWithString: "This temporary fixture closes after the test. Your other applications are untouched.")
description.frame = NSRect(x: 100, y: screen.frame.height - 165, width: 1000, height: 30)
class Receiver: NSObject, NSApplicationDelegate {
    @objc func finish() {
        try! field.stringValue.write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)
        NSApp.terminate(nil)
    }
    func applicationWillTerminate(_ notification: Notification) { previousApp?.activate(options: [.activateIgnoringOtherApps]) }
}
let receiver = Receiver(); application.delegate = receiver
let button = NSButton(title: "Finish test", target: receiver, action: #selector(Receiver.finish))
button.frame = NSRect(x: 520, y: screen.frame.height - 220, width: 180, height: 40)
button.bezelStyle = .rounded
window.contentView!.addSubview(label); window.contentView!.addSubview(description); window.contentView!.addSubview(field); window.contentView!.addSubview(button)
window.makeKeyAndOrderFront(nil); application.activate(ignoringOtherApps: true)
DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
    let data = try! JSONSerialization.data(withJSONObject: ["foreground": NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown", "width": screen.frame.width, "height": screen.frame.height, "app": NSRunningApplication.current.localizedName ?? "Codeflow Computer Fixture"])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8))
}
let timeout = CommandLine.arguments.count > 2 ? min(600, max(10, Double(CommandLine.arguments[2]) ?? 60)) : 60
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { NSApp.terminate(nil) }
let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { event in
    let line = "key=\(event.keyCode), chars=\(event.characters ?? ""), flags=\(event.modifierFlags.rawValue)\n"
    let path = CommandLine.arguments[1] + ".events"
    let old = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    try? (old + line).write(toFile: path, atomically: true, encoding: .utf8)
    return event
}
application.run()
