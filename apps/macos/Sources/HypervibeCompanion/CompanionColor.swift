import AppKit
import SwiftUI

enum CompanionColor {
    /// Semantic foreground colors chosen to remain legible on the companion's
    /// surfaces while retaining clear light/dark mode meaning.
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

private struct CompanionCardSurface: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            // Cards deliberately use a fixed white background. Give all
            // inherited semantic labels and controls the matching appearance
            // so system dark mode cannot produce white-on-white content.
            .environment(\.colorScheme, .light)
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.white)
                    .overlay {
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .stroke(Color.black.opacity(0.1), lineWidth: 1)
                    }
            }
    }
}

extension View {
    func companionCardSurface(cornerRadius: CGFloat) -> some View {
        modifier(CompanionCardSurface(cornerRadius: cornerRadius))
    }
}
