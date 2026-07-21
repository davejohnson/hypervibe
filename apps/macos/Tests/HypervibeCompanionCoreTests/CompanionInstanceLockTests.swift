import Darwin
import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite
struct CompanionInstanceLockTests {
    @Test
    func secondInstanceIsRejectedUntilTheOwnerReleasesTheLock() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("hypervibe-instance-lock-tests-\(UUID())")
        let fileURL = root.appendingPathComponent("instance.lock")
        defer { try? FileManager.default.removeItem(at: root) }

        let first = CompanionInstanceLock(fileURL: fileURL)
        let second = CompanionInstanceLock(fileURL: fileURL)

        #expect(try first.acquire() == .acquired)
        #expect(
            try second.acquire()
                == .alreadyRunning(processIdentifier: getpid())
        )

        first.release()
        #expect(try second.acquire() == .acquired)
    }
}
