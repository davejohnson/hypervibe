import Foundation

enum CompanionDistribution {
    private static var launcherOverride: String? {
        guard let value = ProcessInfo.processInfo.environment[
            "HYPERVIBE_COMPANION_LAUNCHER"
        ]?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty else {
            return nil
        }
        return value
    }

    static var launcherURL: URL {
        if let override = launcherOverride {
            return URL(fileURLWithPath: override).standardizedFileURL
        }
        return Bundle.main.bundleURL
            .appendingPathComponent("Contents/MacOS/hypervibe-mcp")
            .standardizedFileURL
    }

    static var includesBundledServer: Bool {
        FileManager.default.isExecutableFile(atPath: launcherURL.path)
    }

    static var hasStableInstallationPath: Bool {
        if launcherOverride != nil {
            return true
        }
        let bundlePath = Bundle.main.bundleURL.standardizedFileURL.path
        let systemApplications = "/Applications/"
        let userApplications = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications", isDirectory: true)
            .standardizedFileURL.path + "/"
        return bundlePath.hasPrefix(systemApplications)
            || bundlePath.hasPrefix(userApplications)
    }

    static var isReadyForOnboarding: Bool {
        includesBundledServer && hasStableInstallationPath
    }

    static let installationGuidance =
        "Move Hypervibe to Applications, reopen it there, then connect your coding agent."
}
