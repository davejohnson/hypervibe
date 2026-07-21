import AppKit
import SwiftUI

/// Activates an accessory app and raises the SwiftUI window that contains it.
struct WindowFocusBridge: NSViewRepresentable {
    final class Coordinator {
        weak var focusedWindow: NSWindow?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        focusWindow(from: view, coordinator: context.coordinator)
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        focusWindow(from: view, coordinator: context.coordinator)
    }

    private func focusWindow(from view: NSView, coordinator: Coordinator) {
        DispatchQueue.main.async {
            guard let window = view.window,
                coordinator.focusedWindow !== window else {
                return
            }
            coordinator.focusedWindow = window
            NSApplication.shared.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        }
    }
}
