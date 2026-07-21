import AppKit
import SwiftUI

private struct ClickTargetCursorModifier: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovering = false
    @State private var cursorIsPushed = false

    func body(content: Content) -> some View {
        content
            .onHover { hovering in
                isHovering = hovering
                updateCursor(hovering: hovering, enabled: isEnabled)
            }
            .onChange(of: isEnabled) { _, enabled in
                updateCursor(hovering: isHovering, enabled: enabled)
            }
            .onDisappear {
                restoreCursorIfNeeded()
            }
    }

    private func updateCursor(hovering: Bool, enabled: Bool) {
        if hovering, enabled {
            guard !cursorIsPushed else { return }
            NSCursor.pointingHand.push()
            cursorIsPushed = true
        } else {
            restoreCursorIfNeeded()
        }
    }

    private func restoreCursorIfNeeded() {
        guard cursorIsPushed else { return }
        NSCursor.pop()
        cursorIsPushed = false
    }
}

extension View {
    /// Gives custom SwiftUI click targets the familiar pointing-hand cursor.
    func clickTargetCursor() -> some View {
        modifier(ClickTargetCursorModifier())
    }
}
