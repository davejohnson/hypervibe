import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite
struct CompanionReleaseTests {
    @Test
    func versionsCompareNumericallyAndIgnoreTrailingZeroes() throws {
        #expect(CompanionVersion("0.1.10")! > CompanionVersion("0.1.2")!)
        #expect(CompanionVersion("v1.2")! == CompanionVersion("1.2.0")!)
        #expect(CompanionVersion("1.2-beta") == nil)
        #expect(CompanionVersion("") == nil)
    }

    @Test
    func selectsNewerReleaseAssetForCurrentArchitecture() throws {
        let release = try GitHubReleaseClient.parseLatestRelease(
            releaseJSON(version: "0.2.0"),
            currentVersion: "0.1.2",
            architecture: .arm64
        )

        #expect(release?.version == "0.2.0")
        #expect(release?.assetName == "Hypervibe-0.2.0-arm64.dmg")
        #expect(release?.sha256 == String(repeating: "a", count: 64))
    }

    @Test
    func currentOrOlderReleaseDoesNotOfferAnUpdate() throws {
        #expect(try GitHubReleaseClient.parseLatestRelease(
            releaseJSON(version: "0.1.2"),
            currentVersion: "0.1.2",
            architecture: .arm64
        ) == nil)
        #expect(try GitHubReleaseClient.parseLatestRelease(
            releaseJSON(version: "0.1.1"),
            currentVersion: "0.1.2",
            architecture: .arm64
        ) == nil)
    }

    @Test
    func rejectsNewerReleaseWithoutVerifiableMatchingAsset() throws {
        #expect(throws: GitHubReleaseError.compatibleAssetMissing(
            "Hypervibe-0.2.0-x86_64.dmg"
        )) {
            try GitHubReleaseClient.parseLatestRelease(
                releaseJSON(version: "0.2.0"),
                currentVersion: "0.1.2",
                architecture: .intel
            )
        }

        #expect(throws: GitHubReleaseError.assetDigestMissing(
            "Hypervibe-0.2.0-arm64.dmg"
        )) {
            try GitHubReleaseClient.parseLatestRelease(
                releaseJSON(version: "0.2.0", includeDigest: false),
                currentVersion: "0.1.2",
                architecture: .arm64
            )
        }
    }

    private func releaseJSON(version: String, includeDigest: Bool = true) -> Data {
        let encodedDigest = includeDigest
            ? "\"sha256:\(String(repeating: "a", count: 64))\""
            : "null"
        return Data("""
        {
          "tag_name": "v\(version)",
          "html_url": "https://github.com/davejohnson/hypervibe/releases/tag/v\(version)",
          "assets": [
            {
              "name": "Hypervibe-\(version)-arm64.dmg",
              "browser_download_url": "https://github.com/davejohnson/hypervibe/releases/download/v\(version)/Hypervibe-\(version)-arm64.dmg",
              "digest": \(encodedDigest)
            }
          ]
        }
        """.utf8)
    }
}
