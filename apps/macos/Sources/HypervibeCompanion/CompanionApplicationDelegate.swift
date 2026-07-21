import AppKit
import HypervibeCompanionCore

@MainActor
final class CompanionApplicationDelegate: NSObject, NSApplicationDelegate {
    private let instanceLock = CompanionInstanceLock()

    func applicationWillFinishLaunching(_ notification: Notification) {
        do {
            switch try instanceLock.acquire() {
            case .acquired:
                return
            case .alreadyRunning(let processIdentifier):
                activateExistingInstance(processIdentifier: processIdentifier)
                NSApplication.shared.terminate(nil)
            }
        } catch {
            // A lock failure should not make the companion unusable. macOS
            // Launch Services still prevents most same-bundle duplicates.
        }
    }

    private func activateExistingInstance(processIdentifier: Int32?) {
        let existing = processIdentifier.flatMap {
            NSRunningApplication(processIdentifier: $0)
        } ?? NSRunningApplication.runningApplications(
            withBundleIdentifier: "com.hypervibe.companion"
        ).first {
            $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
        }
        existing?.activate()
    }
}
