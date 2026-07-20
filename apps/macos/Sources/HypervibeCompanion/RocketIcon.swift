import AppKit
import SwiftUI

struct RocketIcon: View {
    var body: some View {
        Image(nsImage: RocketTemplateImage.make())
            .resizable()
            .scaledToFit()
            .accessibilityLabel("Hypervibe")
    }
}

@MainActor
enum RocketTemplateImage {
    static func make() -> NSImage {
        let image = NSImage(
            size: NSSize(width: 18, height: 18),
            flipped: false
        ) { bounds in
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

            NSColor.black.setFill()
            path.fill()
            return true
        }
        image.isTemplate = true
        return image
    }

}
