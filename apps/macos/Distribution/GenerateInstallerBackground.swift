import AppKit
import Foundation

// Draws the installer window background: a title, an arrow from the app to
// the Applications shortcut, and an outlined drop target. The outline matters
// because Finder on macOS 26 can show the Applications shortcut with no icon.
//
// Geometry is shared with the Finder layout in build-macos-installer.sh: a
// 540 x 380 point window
// with 112 point icons centred at (150, 200) and (390, 200) from the top left.

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(
        Data("usage: GenerateInstallerBackground.swift <output-directory>\n".utf8)
    )
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(
    at: outputDirectory,
    withIntermediateDirectories: true
)

let size = NSSize(width: 540, height: 380)
let iconCentreY = size.height - 200
let appCentreX: CGFloat = 150
let targetCentreX: CGFloat = 390

func draw() {
    // A mid-tone keeps Finder's own icon labels readable whether it draws
    // them black (light mode) or white (dark mode).
    NSGradient(
        starting: NSColor(srgbRed: 0.47, green: 0.53, blue: 0.62, alpha: 1),
        ending: NSColor(srgbRed: 0.39, green: 0.45, blue: 0.54, alpha: 1)
    )?.draw(in: NSRect(origin: .zero, size: size), angle: -90)

    let title = NSAttributedString(
        string: "Drag Hypervibe into Applications",
        attributes: [
            .font: NSFont.systemFont(ofSize: 19, weight: .semibold),
            .foregroundColor: NSColor.white,
        ]
    )
    let titleSize = title.size()
    title.draw(at: NSPoint(x: (size.width - titleSize.width) / 2, y: size.height - 72))

    let target = NSBezierPath(
        roundedRect: NSRect(
            x: targetCentreX - 66,
            y: iconCentreY - 66,
            width: 132,
            height: 132
        ),
        xRadius: 26,
        yRadius: 26
    )
    NSColor.white.withAlphaComponent(0.14).setFill()
    target.fill()
    NSColor.white.withAlphaComponent(0.85).setStroke()
    target.lineWidth = 2.5
    target.setLineDash([9, 7], count: 2, phase: 0)
    target.stroke()

    let arrow = NSBezierPath()
    arrow.lineWidth = 6
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 224, y: iconCentreY))
    arrow.line(to: NSPoint(x: 292, y: iconCentreY))
    arrow.move(to: NSPoint(x: 274, y: iconCentreY + 18))
    arrow.line(to: NSPoint(x: 292, y: iconCentreY))
    arrow.line(to: NSPoint(x: 274, y: iconCentreY - 18))
    NSColor.white.setStroke()
    arrow.stroke()
}

for (name, scale) in [("background.png", 1), ("background@2x.png", 2)] {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(size.width) * scale,
        pixelsHigh: Int(size.height) * scale,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        exit(1)
    }
    // Point size stays 540 x 380 so the drawing code is scale-independent and
    // tiffutil can pair the two files as one HiDPI image.
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        exit(1)
    }
    try data.write(to: outputDirectory.appendingPathComponent(name))
}
