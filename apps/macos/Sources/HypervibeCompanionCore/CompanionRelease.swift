import Foundation

public enum CompanionArchitecture: String, Sendable {
    case arm64
    case intel = "x86_64"

    public static var current: CompanionArchitecture {
        #if arch(arm64)
        .arm64
        #elseif arch(x86_64)
        .intel
        #else
        #error("Hypervibe Companion supports only arm64 and x86_64 macOS builds")
        #endif
    }
}

public struct CompanionVersion: Comparable, CustomStringConvertible, Sendable {
    public let description: String
    private let components: [Int]

    public init?(_ value: String) {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .drop(while: { $0 == "v" || $0 == "V" })
        let parts = normalized.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty,
            parts.count <= 4,
            parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }),
            parts.compactMap({ Int($0) }).count == parts.count else {
            return nil
        }
        components = parts.compactMap { Int($0) }
        description = components.map(String.init).joined(separator: ".")
    }

    public static func < (lhs: CompanionVersion, rhs: CompanionVersion) -> Bool {
        let count = max(lhs.components.count, rhs.components.count)
        for index in 0..<count {
            let left = index < lhs.components.count ? lhs.components[index] : 0
            let right = index < rhs.components.count ? rhs.components[index] : 0
            if left != right {
                return left < right
            }
        }
        return false
    }

    public static func == (lhs: CompanionVersion, rhs: CompanionVersion) -> Bool {
        !(lhs < rhs) && !(rhs < lhs)
    }
}

public struct CompanionRelease: Equatable, Sendable {
    public let version: String
    public let releasePageURL: URL
    public let downloadURL: URL
    public let assetName: String
    public let sha256: String

    public init(
        version: String,
        releasePageURL: URL,
        downloadURL: URL,
        assetName: String,
        sha256: String
    ) {
        self.version = version
        self.releasePageURL = releasePageURL
        self.downloadURL = downloadURL
        self.assetName = assetName
        self.sha256 = sha256
    }
}

public enum GitHubReleaseError: LocalizedError, Equatable {
    case invalidCurrentVersion(String)
    case invalidResponse
    case networkUnavailable
    case requestFailed(Int)
    case invalidReleaseVersion(String)
    case compatibleAssetMissing(String)
    case assetDigestMissing(String)
    case invalidAssetURL

    public var errorDescription: String? {
        switch self {
        case .invalidCurrentVersion(let version):
            "The installed Companion version is invalid: \(version)."
        case .invalidResponse:
            "GitHub returned an invalid release response."
        case .networkUnavailable:
            "Hypervibe could not reach GitHub to check for updates."
        case .requestFailed(let statusCode):
            "GitHub’s release check failed (HTTP \(statusCode)). Try again later."
        case .invalidReleaseVersion(let tag):
            "GitHub’s latest release has an invalid version tag: \(tag)."
        case .compatibleAssetMissing(let assetName):
            "GitHub release is missing the compatible update: \(assetName)."
        case .assetDigestMissing(let assetName):
            "GitHub release \(assetName) has no SHA-256 digest, so Hypervibe will not install it."
        case .invalidAssetURL:
            "GitHub returned an invalid update download URL."
        }
    }
}

public struct GitHubReleaseClient: Sendable {
    public static let defaultEndpoint = URL(
        string: "https://api.github.com/repos/davejohnson/hypervibe/releases/latest"
    )!

    private let endpoint: URL
    private let session: URLSession

    public init(
        endpoint: URL = GitHubReleaseClient.defaultEndpoint,
        session: URLSession = .shared
    ) {
        self.endpoint = endpoint
        self.session = session
    }

    public func latestUpdate(
        currentVersion: String,
        architecture: CompanionArchitecture = .current
    ) async throws -> CompanionRelease? {
        var request = URLRequest(url: endpoint)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2026-03-10", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue(
            "HypervibeCompanion/\(currentVersion)",
            forHTTPHeaderField: "User-Agent"
        )

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw GitHubReleaseError.networkUnavailable
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw GitHubReleaseError.invalidResponse
        }
        guard httpResponse.statusCode == 200 else {
            throw GitHubReleaseError.requestFailed(httpResponse.statusCode)
        }
        return try Self.parseLatestRelease(
            data,
            currentVersion: currentVersion,
            architecture: architecture
        )
    }

    static func parseLatestRelease(
        _ data: Data,
        currentVersion: String,
        architecture: CompanionArchitecture
    ) throws -> CompanionRelease? {
        guard let current = CompanionVersion(currentVersion) else {
            throw GitHubReleaseError.invalidCurrentVersion(currentVersion)
        }

        let payload: GitHubReleasePayload
        do {
            payload = try JSONDecoder().decode(GitHubReleasePayload.self, from: data)
        } catch {
            throw GitHubReleaseError.invalidResponse
        }

        guard let latest = CompanionVersion(payload.tagName) else {
            throw GitHubReleaseError.invalidReleaseVersion(payload.tagName)
        }
        guard current < latest else {
            return nil
        }

        let expectedAssetName =
            "Hypervibe-\(latest.description)-\(architecture.rawValue).dmg"
        guard let asset = payload.assets.first(where: { $0.name == expectedAssetName }) else {
            throw GitHubReleaseError.compatibleAssetMissing(expectedAssetName)
        }
        guard let digest = asset.digest?.lowercased(),
            digest.hasPrefix("sha256:"),
            digest.dropFirst("sha256:".count).count == 64,
            digest.dropFirst("sha256:".count).allSatisfy(\.isHexDigit) else {
            throw GitHubReleaseError.assetDigestMissing(expectedAssetName)
        }
        guard asset.browserDownloadURL.scheme == "https",
            asset.browserDownloadURL.host == "github.com" else {
            throw GitHubReleaseError.invalidAssetURL
        }

        return CompanionRelease(
            version: latest.description,
            releasePageURL: payload.htmlURL,
            downloadURL: asset.browserDownloadURL,
            assetName: asset.name,
            sha256: String(digest.dropFirst("sha256:".count))
        )
    }
}

private struct GitHubReleasePayload: Decodable {
    let tagName: String
    let htmlURL: URL
    let assets: [GitHubReleaseAsset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case htmlURL = "html_url"
        case assets
    }
}

private struct GitHubReleaseAsset: Decodable {
    let name: String
    let browserDownloadURL: URL
    let digest: String?

    enum CodingKeys: String, CodingKey {
        case name
        case browserDownloadURL = "browser_download_url"
        case digest
    }
}
