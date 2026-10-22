import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import Carbon

// One JSON request on stdin, one JSON response on stdout. No prompts or shell interpretation.
func fail(_ message: String) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["error": message])
    FileHandle.standardOutput.write(data); exit(1)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any], let action = request["action"] as? String else { fail("Invalid computer request") }
let bounds = CGDisplayBounds(CGMainDisplayID())
func reply(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value); FileHandle.standardOutput.write(data)
}
if action == "status" {
    reply(["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "secureInput": IsSecureEventInputEnabled(), "width": bounds.width, "height": bounds.height]); exit(0)
}
if let expected = request["expectedApp"] as? String, NSWorkspace.shared.frontmostApplication?.localizedName != expected { fail("The foreground app changed (expected \(expected), found \(NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown")). Take a new screenshot of the intended app before acting.") }
if action == "screenshot" {
    guard CGPreflightScreenCaptureAccess() else { fail("Enable Screen Recording for Codeflow in macOS System Settings → Privacy & Security, then restart Codeflow.") }
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("codeflow-screen-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: path) }
    let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture"); capture.arguments = ["-x", "-D", "1", "-t", "png", path.path]
    capture.standardError = FileHandle.nullDevice
    do { try capture.run(); capture.waitUntilExit() } catch { fail("Screen capture failed") }
    guard capture.terminationStatus == 0, let data = try? Data(contentsOf: path), let image = NSBitmapImageRep(data: data) else { fail("Screen capture failed") }
    if let expected = request["expectedApp"] as? String, NSWorkspace.shared.frontmostApplication?.localizedName != expected { fail("The foreground app changed during capture. Take a new screenshot of the intended app before acting.") }
    reply(["data": data.base64EncodedString(), "width": image.pixelsWide, "height": image.pixelsHigh, "pointWidth": bounds.width, "pointHeight": bounds.height, "app": NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"]); exit(0)
}
guard AXIsProcessTrusted() else { fail("Enable Accessibility for Codeflow in macOS System Settings → Privacy & Security, then restart Codeflow.") }
if (action == "type" || action == "key") && IsSecureEventInputEnabled() { fail("macOS Secure Keyboard Entry is active. Close the secure input field before typing with computer tools.") }
let source = CGEventSource(stateID: .privateState)
source?.localEventsSuppressionInterval = 0
if action == "click" {
    guard let x = request["x"] as? Double, let y = request["y"] as? Double, x >= 0, y >= 0, x < bounds.width, y < bounds.height else { fail("Coordinates are outside the display") }
    let point = CGPoint(x: bounds.minX + x, y: bounds.minY + y)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
} else if action == "type" {
    guard let text = request["text"] as? String, text.count <= 10000 else { fail("Keep computer text within 10000 characters") }
    let chars = Array(text.utf16)
    for start in stride(from: 0, to: chars.count, by: 20) {
        let chunk = Array(chars[start..<min(start + 20, chars.count)])
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            event?.flags = []
            event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            event?.post(tap: .cghidEventTap)
        }
    }
} else if action == "key" {
    let keys: [String: CGKeyCode] = ["Enter": 36, "Tab": 48, "Escape": 53, "Backspace": 51, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Space": 49]
    guard let key = request["key"] as? String, let code = keys[key] else { fail("Unsupported computer key") }
    CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
} else if action == "scroll" {
    let amount = max(-1000, min(1000, request["pixels"] as? Int ?? 500))
    CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(-amount), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
} else { fail("Unknown computer action") }
Thread.sleep(forTimeInterval: 0.1)
reply(["ok": true, "app": NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"])
