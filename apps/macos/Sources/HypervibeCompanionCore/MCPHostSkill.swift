import Foundation
import Darwin

public enum MCPHostSkillState: String, Codable, Sendable {
    case current, missing, updateAvailable, modified, unavailable, notSupported
}

public struct MCPHostSkillStatus: Equatable, Sendable {
    public let state: MCPHostSkillState
    public let packageVersion: String?
    public let installedVersion: String?

    public var needsUpdate: Bool { state == .missing || state == .updateAvailable }

    public init(state: MCPHostSkillState, packageVersion: String? = nil, installedVersion: String? = nil) {
        self.state = state
        self.packageVersion = packageVersion
        self.installedVersion = installedVersion
    }
}

public enum MCPHostSkillError: LocalizedError {
    case unavailable, modified, installationFailed

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            "Hypervibe could not check the bundled guidance. Install the current packaged app in Applications and try again."
        case .modified:
            "Your existing Hypervibe guidance has local changes or is managed elsewhere. It was preserved."
        case .installationFailed:
            "MCP is configured, but Hypervibe could not finish installing its guidance. Your existing guidance was preserved where possible; check Settings and try again."
        }
    }
}

// Executes only the existing bundled CLI bootstrap, never an MCP session or a
// provider command. The shared installer owns file/receipt/upgrade semantics.
struct MCPHostSkillManager: Sendable {
    var timeoutSeconds: TimeInterval = 10

    func status(launcherURL: URL) async -> MCPHostSkillStatus {
        do {
            let data = try await run(launcherURL, arguments: ["install", "codex", "--skill-only", "--check"])
            let receipt = try JSONDecoder().decode(Receipt.self, from: data)
            guard receipt.schema == 1, receipt.client == "codex",
                receipt.state != .notSupported,
                Self.validVersion(receipt.packageVersion),
                receipt.installedVersion.map(Self.validVersion) ?? true else {
                return .init(state: .unavailable)
            }
            return .init(state: receipt.state, packageVersion: receipt.packageVersion, installedVersion: receipt.installedVersion)
        } catch {
            return .init(state: .unavailable)
        }
    }

    func install(launcherURL: URL) async throws {
        let before = await status(launcherURL: launcherURL)
        if before.state == .current { return }
        if before.state == .modified { throw MCPHostSkillError.modified }
        guard before.needsUpdate else { throw MCPHostSkillError.unavailable }
        do {
            _ = try await run(launcherURL, arguments: ["install", "codex", "--skill-only"])
        } catch {
            throw MCPHostSkillError.installationFailed
        }
        guard await status(launcherURL: launcherURL).state == .current else {
            throw MCPHostSkillError.installationFailed
        }
    }

    private struct Receipt: Decodable {
        let schema: Int
        let client: String
        let state: MCPHostSkillState
        let packageVersion: String
        let installedVersion: String?
    }

    private static func validVersion(_ value: String) -> Bool {
        value.count <= 80 && value.range(of: #"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$"#, options: .regularExpression) != nil
    }

    private func run(_ executable: URL, arguments: [String]) async throws -> Data {
        let limit = timeoutSeconds
        let operation = Task.detached(priority: .utility) {
            try Self.runProcess(executable, arguments: arguments, timeout: limit)
        }
        return try await withTaskCancellationHandler {
            try await operation.value
        } onCancel: {
            operation.cancel()
        }
    }

    private static func runProcess(_ executable: URL, arguments: [String], timeout: TimeInterval) throws -> Data {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let descriptor = output.fileHandleForReading.fileDescriptor
        guard fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK) != -1 else {
            throw MCPHostSkillError.unavailable
        }
        defer {
            try? output.fileHandleForReading.close()
            try? output.fileHandleForWriting.close()
            if process.isRunning {
                process.terminate()
                Thread.sleep(forTimeInterval: 0.05)
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
        try process.run()
        try output.fileHandleForWriting.close()
        let deadline = Date().addingTimeInterval(timeout)
        var result = Data()
        var bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            try Task.checkCancellation()
            let count = Darwin.read(descriptor, &bytes, bytes.count)
            if count > 0 {
                guard result.count + count <= 8192 else { throw MCPHostSkillError.unavailable }
                result.append(contentsOf: bytes.prefix(count))
            } else if count < 0 && errno != EAGAIN && errno != EINTR {
                throw MCPHostSkillError.unavailable
            } else if !process.isRunning {
                guard process.terminationStatus == 0 else { throw MCPHostSkillError.unavailable }
                return result
            }
            guard Date() < deadline else { throw MCPHostSkillError.unavailable }
            if count <= 0 { Thread.sleep(forTimeInterval: 0.01) }
        }
    }
}
