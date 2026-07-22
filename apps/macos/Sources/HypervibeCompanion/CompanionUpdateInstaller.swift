import CryptoKit
import Foundation
import HypervibeCompanionCore

enum CompanionUpdateInstallError: LocalizedError {
    case requiresApplicationsFolder
    case downloadFailed
    case checksumMismatch
    case diskImageFailed
    case updateBundleMissing
    case updateBundleInvalid
    case versionMismatch(expected: String, actual: String)
    case signatureInvalid
    case stagingFailed
    case updaterMissing
    case updaterLaunchFailed

    var errorDescription: String? {
        switch self {
        case .requiresApplicationsFolder:
            "Move Hypervibe to Applications and reopen it before updating."
        case .downloadFailed:
            "The GitHub update could not be downloaded. Try again later."
        case .checksumMismatch:
            "The downloaded update did not match GitHub’s SHA-256 digest and was discarded."
        case .diskImageFailed:
            "The downloaded Hypervibe disk image could not be opened."
        case .updateBundleMissing:
            "The GitHub disk image does not contain Hypervibe.app."
        case .updateBundleInvalid:
            "The downloaded app is not a valid Hypervibe Companion build."
        case .versionMismatch(let expected, let actual):
            "The downloaded app is version \(actual), but GitHub advertised \(expected)."
        case .signatureInvalid:
            "The downloaded Hypervibe app failed code-signature verification and was discarded."
        case .stagingFailed:
            "Hypervibe could not stage the update beside the installed app. Check the Applications folder permissions."
        case .updaterMissing:
            "This Hypervibe build does not include its restart helper."
        case .updaterLaunchFailed:
            "Hypervibe staged the update but could not start the restart helper."
        }
    }
}

struct PreparedCompanionUpdate: Sendable {
    let currentBundleURL: URL
    let stagedBundleURL: URL
    let updaterExecutableURL: URL
    let expectedVersion: String
}

actor CompanionUpdateInstaller {
    private let fileManager: FileManager
    private let session: URLSession

    init(
        fileManager: FileManager = .default,
        session: URLSession = .shared
    ) {
        self.fileManager = fileManager
        self.session = session
    }

    func prepare(
        release: CompanionRelease,
        currentBundleURL: URL
    ) async throws -> PreparedCompanionUpdate {
        guard isInstalledInApplications(currentBundleURL) else {
            throw CompanionUpdateInstallError.requiresApplicationsFolder
        }

        let updaterExecutableURL = currentBundleURL
            .appendingPathComponent("Contents/MacOS/hypervibe-updater")
        guard fileManager.isExecutableFile(atPath: updaterExecutableURL.path) else {
            throw CompanionUpdateInstallError.updaterMissing
        }

        let (downloadURL, response): (URL, URLResponse)
        do {
            (downloadURL, response) = try await session.download(from: release.downloadURL)
        } catch {
            throw CompanionUpdateInstallError.downloadFailed
        }
        defer { try? fileManager.removeItem(at: downloadURL) }

        guard let httpResponse = response as? HTTPURLResponse,
            httpResponse.statusCode == 200 else {
            throw CompanionUpdateInstallError.downloadFailed
        }
        let downloadedDigest: String
        do {
            downloadedDigest = try sha256(of: downloadURL)
        } catch {
            throw CompanionUpdateInstallError.downloadFailed
        }
        guard downloadedDigest == release.sha256.lowercased() else {
            throw CompanionUpdateInstallError.checksumMismatch
        }

        let mountURL = try mountDiskImage(downloadURL)
        do {
            let stagedURL = try stageUpdate(
                from: mountURL,
                currentBundleURL: currentBundleURL,
                release: release
            )
            try? detachDiskImage(mountURL)
            return PreparedCompanionUpdate(
                currentBundleURL: currentBundleURL,
                stagedBundleURL: stagedURL,
                updaterExecutableURL: updaterExecutableURL,
                expectedVersion: release.version
            )
        } catch {
            try? detachDiskImage(mountURL)
            throw error
        }
    }

    func launchRestartHelper(
        _ prepared: PreparedCompanionUpdate,
        processIdentifier: Int32
    ) throws {
        let process = Process()
        process.executableURL = prepared.updaterExecutableURL
        process.arguments = [
            String(processIdentifier),
            prepared.currentBundleURL.path,
            prepared.stagedBundleURL.path,
            prepared.expectedVersion,
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            try? fileManager.removeItem(at: prepared.stagedBundleURL)
            throw CompanionUpdateInstallError.updaterLaunchFailed
        }
    }

    private func isInstalledInApplications(_ bundleURL: URL) -> Bool {
        let path = bundleURL.standardizedFileURL.path
        let userApplications = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications", isDirectory: true)
            .standardizedFileURL.path + "/"
        return path.hasPrefix("/Applications/") || path.hasPrefix(userApplications)
    }

    private func stageUpdate(
        from mountURL: URL,
        currentBundleURL: URL,
        release: CompanionRelease
    ) throws -> URL {
        let sourceURL = mountURL.appendingPathComponent("Hypervibe.app", isDirectory: true)
        guard fileManager.fileExists(atPath: sourceURL.path) else {
            throw CompanionUpdateInstallError.updateBundleMissing
        }
        try validateUpdateBundle(sourceURL, release: release)

        let stagedURL = currentBundleURL.deletingLastPathComponent()
            .appendingPathComponent(
                ".Hypervibe-update-\(UUID().uuidString).app",
                isDirectory: true
            )
        do {
            try fileManager.copyItem(at: sourceURL, to: stagedURL)
            try validateUpdateBundle(stagedURL, release: release)
            return stagedURL
        } catch let error as CompanionUpdateInstallError {
            try? fileManager.removeItem(at: stagedURL)
            throw error
        } catch {
            try? fileManager.removeItem(at: stagedURL)
            throw CompanionUpdateInstallError.stagingFailed
        }
    }

    private func validateUpdateBundle(
        _ bundleURL: URL,
        release: CompanionRelease
    ) throws {
        guard let bundle = Bundle(url: bundleURL),
            bundle.bundleIdentifier == "com.hypervibe.companion",
            let version = bundle.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String,
            fileManager.isExecutableFile(
                atPath: bundleURL.appendingPathComponent(
                    "Contents/MacOS/hypervibe-updater"
                ).path
            ) else {
            throw CompanionUpdateInstallError.updateBundleInvalid
        }
        guard version == release.version else {
            throw CompanionUpdateInstallError.versionMismatch(
                expected: release.version,
                actual: version
            )
        }

        do {
            _ = try run(
                executableURL: URL(fileURLWithPath: "/usr/bin/codesign"),
                arguments: ["--verify", "--deep", "--strict", bundleURL.path]
            )
        } catch {
            throw CompanionUpdateInstallError.signatureInvalid
        }
    }

    private func mountDiskImage(_ diskImageURL: URL) throws -> URL {
        let output: Data
        do {
            output = try run(
                executableURL: URL(fileURLWithPath: "/usr/bin/hdiutil"),
                arguments: [
                    "attach", "-nobrowse", "-readonly", "-plist",
                    diskImageURL.path,
                ]
            )
        } catch {
            throw CompanionUpdateInstallError.diskImageFailed
        }

        guard let propertyList = try? PropertyListSerialization.propertyList(
            from: output,
            format: nil
        ) as? [String: Any],
            let entities = propertyList["system-entities"] as? [[String: Any]],
            let mountPoint = entities.compactMap({ $0["mount-point"] as? String }).first else {
            throw CompanionUpdateInstallError.diskImageFailed
        }
        return URL(fileURLWithPath: mountPoint, isDirectory: true)
    }

    private func detachDiskImage(_ mountURL: URL) throws {
        _ = try run(
            executableURL: URL(fileURLWithPath: "/usr/bin/hdiutil"),
            arguments: ["detach", mountURL.path]
        )
    }

    private func run(executableURL: URL, arguments: [String]) throws -> Data {
        let process = Process()
        let outputPipe = Pipe()
        process.executableURL = executableURL
        process.arguments = arguments
        process.standardOutput = outputPipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw CompanionUpdateInstallError.diskImageFailed
        }
        return outputPipe.fileHandleForReading.readDataToEndOfFile()
    }

    private func sha256(of fileURL: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
