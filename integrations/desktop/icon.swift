import AppKit

// The same stacked-layers mark used by Code Flow's sidebar, rendered at each Dock size.
let destination = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)
for (size, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let pixels = size * scale
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = AffineTransform(scale: CGFloat(pixels) / 1024)
    (transform as NSAffineTransform).concat()
    NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.10, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944), xRadius: 210, yRadius: 210).fill()
    NSColor(calibratedRed: 0.36, green: 0.83, blue: 0.68, alpha: 1).setStroke()
    let mark = NSBezierPath(); mark.lineWidth = 40; mark.lineJoinStyle = .round; mark.lineCapStyle = .round
    mark.move(to: NSPoint(x: 512, y: 772)); mark.line(to: NSPoint(x: 780, y: 620)); mark.line(to: NSPoint(x: 512, y: 468)); mark.line(to: NSPoint(x: 244, y: 620)); mark.close()
    for y in [500, 380] { mark.move(to: NSPoint(x: 244, y: y)); mark.line(to: NSPoint(x: 512, y: y - 152)); mark.line(to: NSPoint(x: 780, y: y)) }
    mark.stroke()
    NSGraphicsContext.restoreGraphicsState()
    let suffix = scale == 2 ? "@2x" : ""
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(destination)/icon_\(size)x\(size)\(suffix).png"))
}
