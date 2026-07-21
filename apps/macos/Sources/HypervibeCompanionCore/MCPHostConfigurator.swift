import Foundation

public enum MCPHost: String, CaseIterable, Hashable, Identifiable, Sendable {
    case claudeDesktop
    case codex

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .claudeDesktop: "Claude Desktop"
        case .codex: "Codex / ChatGPT"
        }
    }
}

public struct MCPHostConnectionStatus: Equatable, Sendable {
    public let host: MCPHost
    public let connectedProjectCount: Int
    public let projectCount: Int
    public let configPath: String

    public var isFullyConnected: Bool {
        projectCount > 0 && connectedProjectCount == projectCount
    }

    public init(
        host: MCPHost,
        connectedProjectCount: Int,
        projectCount: Int,
        configPath: String
    ) {
        self.host = host
        self.connectedProjectCount = connectedProjectCount
        self.projectCount = projectCount
        self.configPath = configPath
    }
}

public enum MCPHostConfigurationError: LocalizedError, Equatable {
    case noProjects
    case launcherUnavailable(String)
    case invalidProjectRoot(String)
    case invalidClaudeConfiguration(String)
    case invalidCodexConfiguration(String)

    public var errorDescription: String? {
        switch self {
        case .noProjects:
            "Add at least one Hypervibe project before connecting an MCP client."
        case .launcherUnavailable(let path):
            "The bundled Hypervibe MCP launcher is unavailable at \(path). Install Hypervibe in Applications and try again."
        case .invalidProjectRoot(let path):
            "The project directory is unavailable: \(path)"
        case .invalidClaudeConfiguration(let path):
            "Claude Desktop’s MCP configuration is not valid JSON: \(path)"
        case .invalidCodexConfiguration(let path):
            "Codex’s MCP configuration contains an incomplete Hypervibe-managed block: \(path)"
        }
    }
}

public actor MCPHostConfigurator {
    public let claudeConfigURL: URL
    public let codexConfigURL: URL

    private let fileManager: FileManager

    public init(
        claudeConfigURL: URL = MCPHostConfigurator.defaultClaudeConfigURL(),
        codexConfigURL: URL = MCPHostConfigurator.defaultCodexConfigURL(),
        fileManager: FileManager = .default
    ) {
        self.claudeConfigURL = claudeConfigURL
        self.codexConfigURL = codexConfigURL
        self.fileManager = fileManager
    }

    public static func defaultClaudeConfigURL(
        fileManager: FileManager = .default
    ) -> URL {
        fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Claude", isDirectory: true)
            .appendingPathComponent("claude_desktop_config.json")
    }

    public static func defaultCodexConfigURL(
        fileManager: FileManager = .default
    ) -> URL {
        fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex", isDirectory: true)
            .appendingPathComponent("config.toml")
    }

    public func status(
        for host: MCPHost,
        projects: [CompanionProject],
        launcherURL: URL
    ) throws -> MCPHostConnectionStatus {
        let connectedCount: Int
        switch host {
        case .claudeDesktop:
            let servers = try claudeServers()
            connectedCount = projects.filter { project in
                guard let server = servers[Self.serverName(for: project)] as? [String: Any],
                    let command = server["command"] as? String,
                    let args = server["args"] as? [String] else {
                    return false
                }
                return command == launcherURL.path
                    && args == Self.launcherArguments(for: project)
            }.count
        case .codex:
            let content = try codexContent()
            connectedCount = projects.filter { project in
                content.contains(Self.codexBlock(
                    for: project,
                    launcherURL: launcherURL
                ))
            }.count
        }

        return MCPHostConnectionStatus(
            host: host,
            connectedProjectCount: connectedCount,
            projectCount: projects.count,
            configPath: configURL(for: host).path
        )
    }

    public func connect(
        _ host: MCPHost,
        projects: [CompanionProject],
        launcherURL: URL
    ) throws {
        try validate(projects: projects, launcherURL: launcherURL)
        switch host {
        case .claudeDesktop:
            try connectClaude(projects: projects, launcherURL: launcherURL)
        case .codex:
            try connectCodex(projects: projects, launcherURL: launcherURL)
        }
    }

    public func disconnect(
        _ host: MCPHost,
        projects: [CompanionProject]
    ) throws {
        switch host {
        case .claudeDesktop:
            try disconnectClaude(projects: projects)
        case .codex:
            try disconnectCodex(projects: projects)
        }
    }

    public static func serverName(for project: CompanionProject) -> String {
        let slug = project.displayName
            .lowercased()
            .unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? Character(String($0)) : "_" }
            .reduce(into: "") { result, character in
                if character != "_" || result.last != "_" {
                    result.append(character)
                }
            }
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        let suffix = project.id.uuidString
            .replacingOccurrences(of: "-", with: "")
            .prefix(8)
            .lowercased()
        return "hypervibe_\(slug.isEmpty ? "project" : slug)_\(suffix)"
    }

    private func configURL(for host: MCPHost) -> URL {
        switch host {
        case .claudeDesktop: claudeConfigURL
        case .codex: codexConfigURL
        }
    }

    private func validate(
        projects: [CompanionProject],
        launcherURL: URL
    ) throws {
        guard !projects.isEmpty else {
            throw MCPHostConfigurationError.noProjects
        }
        guard launcherURL.path.hasPrefix("/"),
            fileManager.isExecutableFile(atPath: launcherURL.path) else {
            throw MCPHostConfigurationError.launcherUnavailable(launcherURL.path)
        }
        for project in projects {
            var isDirectory: ObjCBool = false
            guard project.repositoryPath.hasPrefix("/"),
                fileManager.fileExists(
                    atPath: project.repositoryPath,
                    isDirectory: &isDirectory
                ),
                isDirectory.boolValue else {
                throw MCPHostConfigurationError.invalidProjectRoot(
                    project.repositoryPath
                )
            }
        }
    }

    private func claudeRoot() throws -> [String: Any] {
        guard fileManager.fileExists(atPath: claudeConfigURL.path) else {
            return [:]
        }
        let data = try Data(contentsOf: claudeConfigURL)
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MCPHostConfigurationError.invalidClaudeConfiguration(
                claudeConfigURL.path
            )
        }
        if let servers = root["mcpServers"], !(servers is [String: Any]) {
            throw MCPHostConfigurationError.invalidClaudeConfiguration(
                claudeConfigURL.path
            )
        }
        return root
    }

    private func claudeServers() throws -> [String: Any] {
        try claudeRoot()["mcpServers"] as? [String: Any] ?? [:]
    }

    private func connectClaude(
        projects: [CompanionProject],
        launcherURL: URL
    ) throws {
        var root = try claudeRoot()
        var servers = root["mcpServers"] as? [String: Any] ?? [:]
        for project in projects {
            servers[Self.serverName(for: project)] = [
                "command": launcherURL.path,
                "args": Self.launcherArguments(for: project),
            ]
        }
        root["mcpServers"] = servers
        let data = try JSONSerialization.data(
            withJSONObject: root,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        try write(data: data + Data("\n".utf8), to: claudeConfigURL)
    }

    private func disconnectClaude(projects: [CompanionProject]) throws {
        guard fileManager.fileExists(atPath: claudeConfigURL.path) else { return }
        var root = try claudeRoot()
        var servers = root["mcpServers"] as? [String: Any] ?? [:]
        for project in projects {
            servers.removeValue(forKey: Self.serverName(for: project))
        }
        root["mcpServers"] = servers
        let data = try JSONSerialization.data(
            withJSONObject: root,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        try write(data: data + Data("\n".utf8), to: claudeConfigURL)
    }

    private func codexContent() throws -> String {
        guard fileManager.fileExists(atPath: codexConfigURL.path) else {
            return ""
        }
        let content = try String(contentsOf: codexConfigURL, encoding: .utf8)
        let beginPrefix = "# BEGIN HYPERVIBE COMPANION "
        let endPrefix = "# END HYPERVIBE COMPANION "
        var openIdentifier: String?
        for line in content.split(separator: "\n", omittingEmptySubsequences: false) {
            let value = String(line)
            if value.hasPrefix(beginPrefix) {
                guard openIdentifier == nil else {
                    throw MCPHostConfigurationError.invalidCodexConfiguration(
                        codexConfigURL.path
                    )
                }
                openIdentifier = String(value.dropFirst(beginPrefix.count))
            } else if value.hasPrefix(endPrefix) {
                let identifier = String(value.dropFirst(endPrefix.count))
                guard openIdentifier == identifier else {
                    throw MCPHostConfigurationError.invalidCodexConfiguration(
                        codexConfigURL.path
                    )
                }
                openIdentifier = nil
            }
        }
        guard openIdentifier == nil else {
            throw MCPHostConfigurationError.invalidCodexConfiguration(
                codexConfigURL.path
            )
        }
        return content
    }

    private func connectCodex(
        projects: [CompanionProject],
        launcherURL: URL
    ) throws {
        var content = try codexContent()
        for project in projects {
            content = Self.removingCodexBlock(for: project, from: content)
            if !content.isEmpty && !content.hasSuffix("\n") {
                content.append("\n")
            }
            if !content.isEmpty && !content.hasSuffix("\n\n") {
                content.append("\n")
            }
            content.append(Self.codexBlock(
                for: project,
                launcherURL: launcherURL
            ))
        }
        try write(data: Data(content.utf8), to: codexConfigURL)
    }

    private func disconnectCodex(projects: [CompanionProject]) throws {
        guard fileManager.fileExists(atPath: codexConfigURL.path) else { return }
        var content = try codexContent()
        for project in projects {
            content = Self.removingCodexBlock(for: project, from: content)
        }
        try write(data: Data(content.utf8), to: codexConfigURL)
    }

    private func write(data: Data, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )

        let existed = fileManager.fileExists(atPath: url.path)
        let permissions = existed
            ? try fileManager.attributesOfItem(atPath: url.path)[.posixPermissions]
            : nil
        if existed {
            let backupURL = url.appendingPathExtension("hypervibe-backup")
            if !fileManager.fileExists(atPath: backupURL.path) {
                try fileManager.copyItem(at: url, to: backupURL)
            }
        }

        try data.write(to: url, options: .atomic)
        try fileManager.setAttributes(
            [.posixPermissions: permissions ?? 0o600],
            ofItemAtPath: url.path
        )
    }

    private static func launcherArguments(
        for project: CompanionProject
    ) -> [String] {
        var arguments = ["--project-root", project.repositoryPath]
        if let dataDirectory = project.hypervibeDataDirectory,
            !dataDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            arguments.append(contentsOf: ["--data-dir", dataDirectory])
        }
        return arguments
    }

    private static func codexBlock(
        for project: CompanionProject,
        launcherURL: URL
    ) -> String {
        let identifier = project.id.uuidString.lowercased()
        let arguments = launcherArguments(for: project)
            .map(tomlString)
            .joined(separator: ", ")
        return """
        # BEGIN HYPERVIBE COMPANION \(identifier)
        [mcp_servers.\(tomlString(serverName(for: project)))]
        command = \(tomlString(launcherURL.path))
        args = [\(arguments)]
        enabled = true
        # END HYPERVIBE COMPANION \(identifier)
        """ + "\n"
    }

    private static func removingCodexBlock(
        for project: CompanionProject,
        from content: String
    ) -> String {
        let identifier = project.id.uuidString.lowercased()
        let begin = "# BEGIN HYPERVIBE COMPANION \(identifier)"
        let end = "# END HYPERVIBE COMPANION \(identifier)"
        guard let beginRange = content.range(of: begin),
            let endRange = content.range(
                of: end,
                range: beginRange.upperBound..<content.endIndex
            ) else {
            return content
        }

        var removalEnd = endRange.upperBound
        while removalEnd < content.endIndex,
            content[removalEnd] == "\n" {
            removalEnd = content.index(after: removalEnd)
        }
        var result = content
        result.removeSubrange(beginRange.lowerBound..<removalEnd)
        return result.trimmingCharacters(in: .newlines) + (result.isEmpty ? "" : "\n")
    }

    private static func tomlString(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x08: result.append("\\b")
            case 0x09: result.append("\\t")
            case 0x0A: result.append("\\n")
            case 0x0C: result.append("\\f")
            case 0x0D: result.append("\\r")
            case 0x22: result.append("\\\"")
            case 0x5C: result.append("\\\\")
            case 0x00...0x1F, 0x7F:
                result.append(String(format: "\\u%04X", scalar.value))
            default:
                result.unicodeScalars.append(scalar)
            }
        }
        result.append("\"")
        return result
    }
}
