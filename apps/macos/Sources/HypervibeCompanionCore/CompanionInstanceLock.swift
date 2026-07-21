import Darwin
import Foundation

public enum CompanionInstanceAcquisition: Equatable, Sendable {
    case acquired
    case alreadyRunning(processIdentifier: Int32?)
}

/// A user-scoped advisory lock that prevents packaged and development builds
/// of the companion from running at the same time.
public final class CompanionInstanceLock {
    public let fileURL: URL

    private var descriptor: Int32 = -1

    public init(
        fileURL: URL = CompanionInstanceLock.defaultFileURL()
    ) {
        self.fileURL = fileURL
    }

    deinit {
        release()
    }

    public static func defaultFileURL(
        fileManager: FileManager = .default
    ) -> URL {
        let root = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? fileManager.homeDirectoryForCurrentUser
        return root
            .appendingPathComponent("HypervibeCompanion", isDirectory: true)
            .appendingPathComponent("instance.lock", isDirectory: false)
    }

    public func acquire() throws -> CompanionInstanceAcquisition {
        if descriptor >= 0 {
            return .acquired
        }

        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let opened = Darwin.open(
            fileURL.path,
            O_CREAT | O_RDWR | O_EXLOCK | O_NONBLOCK,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard opened >= 0 else {
            let lockError = errno
            if lockError == EWOULDBLOCK || lockError == EAGAIN {
                let reader = Darwin.open(fileURL.path, O_RDONLY)
                let owner = reader >= 0 ? Self.readOwner(from: reader) : nil
                if reader >= 0 {
                    Darwin.close(reader)
                }
                return .alreadyRunning(processIdentifier: owner)
            }
            throw posixError(code: lockError)
        }
        _ = Darwin.fchmod(opened, mode_t(S_IRUSR | S_IWUSR))

        descriptor = opened
        Self.writeOwner(getpid(), to: opened)
        return .acquired
    }

    public func release() {
        guard descriptor >= 0 else { return }
        Darwin.close(descriptor)
        descriptor = -1
    }

    private static func writeOwner(_ processIdentifier: Int32, to descriptor: Int32) {
        let value = Data("\(processIdentifier)\n".utf8)
        _ = Darwin.ftruncate(descriptor, 0)
        _ = Darwin.lseek(descriptor, 0, SEEK_SET)
        value.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            _ = Darwin.write(descriptor, baseAddress, bytes.count)
        }
        _ = Darwin.fsync(descriptor)
    }

    private static func readOwner(from descriptor: Int32) -> Int32? {
        _ = Darwin.lseek(descriptor, 0, SEEK_SET)
        var buffer = [UInt8](repeating: 0, count: 32)
        let count = buffer.withUnsafeMutableBytes { bytes in
            Darwin.read(descriptor, bytes.baseAddress, bytes.count)
        }
        guard count > 0 else { return nil }
        let value = String(decoding: buffer.prefix(Int(count)), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Int32(value)
    }

    private func posixError(code: Int32 = errno) -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
}
