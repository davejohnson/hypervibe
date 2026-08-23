import AppKit
import SwiftUI

enum CompanionColor {
    /// Semantic foreground colors chosen to remain legible on the companion's
    /// light gray surfaces while retaining clear light/dark mode meaning.
    static let success = adaptive(
        light: NSColor(srgbRed: 0.086, green: 0.396, blue: 0.204, alpha: 1),
        dark: NSColor(srgbRed: 0.525, green: 0.937, blue: 0.675, alpha: 1)
    )

    static let warning = adaptive(
        light: NSColor(srgbRed: 0.604, green: 0.204, blue: 0.071, alpha: 1),
        dark: NSColor(srgbRed: 0.992, green: 0.729, blue: 0.455, alpha: 1)
    )

    private static func adaptive(light: NSColor, dark: NSColor) -> Color {
        Color(
            nsColor: NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                    ? dark
                    : light
            }
        )
    }
}
