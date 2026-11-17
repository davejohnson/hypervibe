import Foundation
import HypervibeCompanionCore
import UserNotifications

/// Owner preferences stored in the app's own defaults.
enum CompanionPreferences {
    static let automaticChecksKey = "automaticChecksEnabled"
    static let notificationsKey = "statusNotificationsEnabled"
    static let checkIntervalMinutes = 15

    static var automaticChecksEnabled: Bool {
        UserDefaults.standard.object(forKey: automaticChecksKey) as? Bool ?? true
    }

    static var notificationsEnabled: Bool {
        UserDefaults.standard.object(forKey: notificationsKey) as? Bool ?? true
    }
}

enum CompanionNotifier {
    /// Posts down and back-up notices. macOS asks for permission the first
    /// time there is something to say, not at launch.
    static func post(_ notices: [StatusNotice]) async {
        // Notification Center needs an app bundle; `swift run` has none.
        guard !notices.isEmpty, Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else {
            return
        }
        for notice in notices {
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.body
            content.sound = .default
            // Reusing the identifier replaces an older notice for the same service.
            try? await center.add(
                UNNotificationRequest(identifier: notice.id, content: content, trigger: nil)
            )
        }
    }
}
