import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(
        Data("usage: GenerateAppIcon.swift <iconset-directory>\n".utf8)
    )
    exit(2)
}

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(
    at: outputDirectory,
    withIntermediateDirectories: true
)

let variants: [(name: String, pixels: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

func drawRocket(in bounds: NSRect) {
    let scaleX = bounds.width / 18
    let scaleY = bounds.height / 18
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(
            x: bounds.minX + x * scaleX,
            y: bounds.maxY - y * scaleY
        )
    }

    let path = NSBezierPath()
    path.windingRule = .evenOdd
    path.move(to: point(3.5, 11.7))
    path.curve(
        to: point(15.6, 1.4),
        controlPoint1: point(5.2, 7.0),
        controlPoint2: point(10.1, 2.5)
    )
    path.curve(
        to: point(16.6, 2.4),
        controlPoint1: point(16.3, 1.2),
        controlPoint2: point(16.8, 1.7)
    )
    path.curve(
        to: point(6.3, 14.5),
        controlPoint1: point(15.5, 7.9),
        controlPoint2: point(11.0, 12.8)
    )
    path.close()
    path.move(to: point(5.4, 8.8))
    path.curve(
        to: point(1.0, 13.0),
        controlPoint1: point(3.1, 8.7),
        controlPoint2: point(1.6, 10.2)
    )
    path.line(to: point(4.5, 13.6))
    path.close()
    path.move(to: point(9.2, 12.6))
    path.curve(
        to: point(5.0, 17.0),
        controlPoint1: point(9.3, 14.9),
        controlPoint2: point(7.8, 16.4)
    )
    path.line(to: point(4.4, 13.5))
    path.close()
    path.move(to: point(3.8, 13.7))
    path.curve(
        to: point(0.7, 17.2),
        controlPoint1: point(2.3, 14.2),
        controlPoint2: point(1.3, 15.3)
    )
    path.curve(
        to: point(4.3, 14.2),
        controlPoint1: point(2.6, 16.6),
        controlPoint2: point(3.7, 15.7)
    )
    path.close()
    path.appendOval(
        in: NSRect(
            x: bounds.minX + 10.2 * scaleX,
            y: bounds.maxY - 8.0 * scaleY,
            width: 3.2 * scaleX,
            height: 3.2 * scaleY
        )
    )
    NSColor(calibratedWhite: 0.18, alpha: 1).setFill()
    path.fill()
}

for variant in variants {
    let size = CGFloat(variant.pixels)
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high

    let canvas = NSRect(x: 0, y: 0, width: size, height: size)
    let tile = canvas.insetBy(dx: size * 0.055, dy: size * 0.055)
    let background = NSBezierPath(
        roundedRect: tile,
        xRadius: size * 0.21,
        yRadius: size * 0.21
    )
    NSColor(calibratedWhite: 0.94, alpha: 1).setFill()
    background.fill()
    NSColor(calibratedWhite: 0.78, alpha: 1).setStroke()
    background.lineWidth = max(1, size * 0.012)
    background.stroke()

    drawRocket(
        in: NSRect(
            x: size * 0.20,
            y: size * 0.18,
            width: size * 0.60,
            height: size * 0.60
        )
    )
    image.unlockFocus()

    guard let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "HypervibeIcon", code: 1)
    }
    try png.write(to: outputDirectory.appendingPathComponent(variant.name))
}
