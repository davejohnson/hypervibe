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

func rgb(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
}

// Same rocket geometry as RocketIcon.swift, split into separate paths: fins
// and body must not share one even-odd path or their overlaps punch holes at
// large sizes. The oval window is an even-odd hole revealing the background.
func rocketPaths(in bounds: NSRect) -> (body: NSBezierPath, fins: NSBezierPath, flame: NSBezierPath) {
    let scaleX = bounds.width / 18
    let scaleY = bounds.height / 18
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(
            x: bounds.minX + x * scaleX,
            y: bounds.maxY - y * scaleY
        )
    }

    let body = NSBezierPath()
    body.windingRule = .evenOdd
    body.move(to: point(3.5, 11.7))
    body.curve(
        to: point(15.6, 1.4),
        controlPoint1: point(5.2, 7.0),
        controlPoint2: point(10.1, 2.5)
    )
    body.curve(
        to: point(16.6, 2.4),
        controlPoint1: point(16.3, 1.2),
        controlPoint2: point(16.8, 1.7)
    )
    body.curve(
        to: point(6.3, 14.5),
        controlPoint1: point(15.5, 7.9),
        controlPoint2: point(11.0, 12.8)
    )
    body.close()
    body.appendOval(
        in: NSRect(
            x: bounds.minX + 10.2 * scaleX,
            y: bounds.maxY - 8.0 * scaleY,
            width: 3.2 * scaleX,
            height: 3.2 * scaleY
        )
    )

    let fins = NSBezierPath()
    fins.move(to: point(5.4, 8.8))
    fins.curve(
        to: point(1.0, 13.0),
        controlPoint1: point(3.1, 8.7),
        controlPoint2: point(1.6, 10.2)
    )
    fins.line(to: point(4.5, 13.6))
    fins.close()
    fins.move(to: point(9.2, 12.6))
    fins.curve(
        to: point(5.0, 17.0),
        controlPoint1: point(9.3, 14.9),
        controlPoint2: point(7.8, 16.4)
    )
    fins.line(to: point(4.4, 13.5))
    fins.close()

    // Larger than the toolbar icon's exhaust puff so the flame reads at
    // Finder sizes.
    let flame = NSBezierPath()
    flame.move(to: point(4.0, 13.5))
    flame.curve(
        to: point(0.0, 18.0),
        controlPoint1: point(2.0, 14.3),
        controlPoint2: point(0.9, 15.7)
    )
    flame.curve(
        to: point(4.5, 14.3),
        controlPoint1: point(2.4, 17.3),
        controlPoint2: point(3.8, 16.1)
    )
    flame.close()

    return (body, fins, flame)
}

func sparkle(centerX: CGFloat, centerY: CGFloat, radius: CGFloat) -> NSBezierPath {
    let center = NSPoint(x: centerX, y: centerY)
    let path = NSBezierPath()
    path.move(to: NSPoint(x: centerX, y: centerY + radius))
    path.curve(to: NSPoint(x: centerX + radius, y: centerY), controlPoint1: center, controlPoint2: center)
    path.curve(to: NSPoint(x: centerX, y: centerY - radius), controlPoint1: center, controlPoint2: center)
    path.curve(to: NSPoint(x: centerX - radius, y: centerY), controlPoint1: center, controlPoint2: center)
    path.curve(to: NSPoint(x: centerX, y: centerY + radius), controlPoint1: center, controlPoint2: center)
    path.close()
    return path
}

// x/y are fractions of the canvas, y measured from the top.
let stars: [(x: CGFloat, y: CGFloat, radius: CGFloat, alpha: CGFloat)] = [
    (0.24, 0.20, 0.011, 0.90),
    (0.33, 0.31, 0.007, 0.65),
    (0.17, 0.43, 0.009, 0.80),
    (0.57, 0.15, 0.007, 0.60),
    (0.84, 0.51, 0.008, 0.70),
    (0.79, 0.71, 0.011, 0.90),
    (0.68, 0.83, 0.007, 0.65),
]

for variant in variants {
    let size = CGFloat(variant.pixels)
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high

    // Standard macOS app-icon metrics: the tile fills ~824/1024 of the canvas.
    let canvas = NSRect(x: 0, y: 0, width: size, height: size)
    let tile = canvas.insetBy(dx: size * 0.098, dy: size * 0.098)
    let tilePath = NSBezierPath(
        roundedRect: tile,
        xRadius: tile.width * 0.225,
        yRadius: tile.width * 0.225
    )

    NSGraphicsContext.current?.saveGraphicsState()
    tilePath.addClip()

    NSGradient(
        colorsAndLocations:
            (rgb(30, 27, 75), 0.0),
            (rgb(124, 58, 237), 0.42),
            (rgb(217, 70, 239), 0.72),
            (rgb(251, 146, 60), 1.0)
    )?.draw(in: tile, angle: 55)

    NSGradient(
        colorsAndLocations:
            (NSColor(calibratedWhite: 1, alpha: 0.28), 0.0),
            (NSColor(calibratedWhite: 1, alpha: 0), 1.0)
    )?.draw(
        fromCenter: NSPoint(x: size * 0.52, y: size * 0.52),
        radius: 0,
        toCenter: NSPoint(x: size * 0.52, y: size * 0.52),
        radius: size * 0.46,
        options: []
    )

    for star in stars {
        NSColor(calibratedWhite: 1, alpha: star.alpha).setFill()
        let radius = max(size * star.radius, 0.5)
        NSBezierPath(
            ovalIn: NSRect(
                x: size * star.x - radius,
                y: size * (1 - star.y) - radius,
                width: radius * 2,
                height: radius * 2
            )
        ).fill()
    }
    NSColor(calibratedWhite: 1, alpha: 0.9).setFill()
    sparkle(centerX: size * 0.27, centerY: size * (1 - 0.62), radius: size * 0.035).fill()
    sparkle(centerX: size * 0.74, centerY: size * (1 - 0.40), radius: size * 0.028).fill()

    let (body, fins, flame) = rocketPaths(
        in: NSRect(
            x: size * 0.21,
            y: size * 0.21,
            width: size * 0.58,
            height: size * 0.58
        )
    )

    NSGradient(
        colorsAndLocations:
            (rgb(253, 224, 71), 0.0),
            (rgb(249, 115, 22), 1.0)
    )?.draw(in: flame, angle: 235)

    NSGraphicsContext.current?.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(calibratedWhite: 0, alpha: 0.35)
    shadow.shadowOffset = NSSize(width: 0, height: -size * 0.02)
    shadow.shadowBlurRadius = size * 0.04
    shadow.set()
    NSColor.white.setFill()
    fins.fill()
    body.fill()
    NSGraphicsContext.current?.restoreGraphicsState()

    NSGradient(
        colorsAndLocations:
            (rgb(165, 180, 252), 0.0),
            (rgb(199, 210, 254), 1.0)
    )?.draw(in: fins, angle: 90)

    NSGradient(
        colorsAndLocations:
            (rgb(199, 210, 254), 0.0),
            (NSColor.white, 0.65)
    )?.draw(in: body, angle: 90)

    NSGradient(
        colorsAndLocations:
            (NSColor(calibratedWhite: 1, alpha: 0.22), 0.0),
            (NSColor(calibratedWhite: 1, alpha: 0), 1.0)
    )?.draw(
        in: NSRect(
            x: tile.minX,
            y: tile.midY,
            width: tile.width,
            height: tile.height / 2
        ),
        angle: -90
    )

    NSGraphicsContext.current?.restoreGraphicsState()

    image.unlockFocus()

    guard let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "HypervibeIcon", code: 1)
    }
    try png.write(to: outputDirectory.appendingPathComponent(variant.name))
}
