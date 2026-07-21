import Foundation
import MCP
#if canImport(System)
import System
#else
import SystemPackage
#endif

public enum HypervibeClientError: LocalizedError, Equatable, Sendable {
    case invalidRepository
    case invalidExecutable
    case launchFailed
    case processExited(Int32)
    case incompatibleTools([String])
    case schemaMigrationRequired
    case missingStructuredContent(String)
    case malformedResponse(String)
    case tool(code: String, message: String, hint: String?)

    public var errorDescription: String? {
        switch self {
        case .invalidRepository:
            return "The configured repository directory does not exist."
        case .invalidExecutable:
            return "The configured Hypervibe executable is missing or not executable."
        case .launchFailed:
            return "Hypervibe could not be launched."
        case .processExited(let status):
            return "Hypervibe exited before the refresh completed (status \(status))."
        case .incompatibleTools(let missing):
            return "This Hypervibe executable is missing: \(missing.joined(separator: ", "))."
        case .schemaMigrationRequired:
            return "Hypervibe's local schema needs migration before the companion can refresh."
        case .missingStructuredContent(let tool):
            return "\(tool) returned no structured response."
        case .malformedResponse(let message):
            return message
        case .tool(_, let message, let hint):
            if let hint, !hint.isEmpty {
                return "\(message)\n\n\(hint)"
            }
            return message
        }
    }
}

public actor HypervibeMCPClient {
    private let encoder = JSONEncoder()

    public init() {}

    public func refresh(
        project: CompanionProject,
        previous: ProjectSnapshot? = nil
    ) async throws -> CompanionRefresh {
        try await withSession(
            project: project,
            requiredTools: ["hv_spec_get", "hv_status", "hv_runs", "hv_connections_list"]
        ) { client in
            let specData = try await self.call(
                client: client,
                tool: "hv_spec_get",
                arguments: [:]
            )
            let topology = try HypervibeResponseMapper.decodeTopology(specData)
            let enabled = project.enabledEnvironments.map(Set.init)
            let selectedEnvironments = topology.environments.filter {
                enabled?.contains($0.name) ?? true
            }
            let attemptedAt = Date()
            var environments: [EnvironmentSnapshot] = []

            for environment in selectedEnvironments {
                let previousObservation = previous?.environments
                    .first(where: { $0.name == environment.name })?
                    .observation
                let observation: ObservationSummary
                do {
                    let statusData = try await self.call(
                        client: client,
                        tool: "hv_status",
                        arguments: [
                            "project": .string(topology.projectName),
                            "env": .string(environment.name),
                        ]
                    )
                    observation = try HypervibeResponseMapper.decodeObservation(
                        statusData,
                        attemptedAt: attemptedAt,
                        previous: previousObservation
                    )
                } catch {
                    observation = HypervibeResponseMapper.failedObservation(
                        attemptedAt: attemptedAt,
                        previous: previousObservation
                    )
                }

                environments.append(
                    EnvironmentSnapshot(
                        name: environment.name,
                        specRevision: topology.specRevision,
                        resources: environment.resources,
                        observation: observation
                    )
                )
            }

            let runsData = try await self.call(
                client: client,
                tool: "hv_runs",
                arguments: [
                    "action": "list",
                    "project": .string(topology.projectName),
                    "limit": 10,
                ]
            )
            let runs = try HypervibeResponseMapper.decodeRuns(runsData)
            let connectionsData = try await self.call(
                client: client,
                tool: "hv_connections_list",
                arguments: [:]
            )
            let connections = try HypervibeResponseMapper.decodeConnections(connectionsData)
            return CompanionRefresh(
                snapshot: ProjectSnapshot(
                    projectID: project.id,
                    projectName: topology.projectName,
                    generatedAt: attemptedAt,
                    environments: environments,
                    recentRuns: runs
                ),
                connections: connections
            )
        }
    }

    public func connectionCatalog(project: CompanionProject) async throws -> ConnectionCatalog {
        try await withSession(project: project, requiredTools: ["hv_connections_list"]) { client in
            let data = try await self.call(
                client: client,
                tool: "hv_connections_list",
                arguments: [:]
            )
            return try HypervibeResponseMapper.decodeConnectionCatalog(data)
        }
    }

    public func addConnection(
        project: CompanionProject,
        request: ConnectionRequest
    ) async throws -> ConnectionMutationResult {
        try await connectionMutation(
            project: project,
            arguments: request.toolArguments()
        )
    }

    public func verifyConnection(
        project: CompanionProject,
        provider: String,
        scope: String? = nil
    ) async throws -> ConnectionMutationResult {
        try await connectionMutation(
            project: project,
            arguments: mutationArguments(action: "verify", provider: provider, scope: scope)
        )
    }

    public func removeConnection(
        project: CompanionProject,
        provider: String,
        scope: String? = nil
    ) async throws -> ConnectionMutationResult {
        try await connectionMutation(
            project: project,
            arguments: mutationArguments(action: "remove", provider: provider, scope: scope)
        )
    }

    public func hostingVariables(
        project: CompanionProject,
        targets: [HostingVariableTarget]
    ) async throws -> HostingVariableInventory {
        try await withSession(project: project, requiredTools: ["hv_secrets_get"]) { client in
            var catalogs: [HostingVariableTarget: HostingVariableCatalog] = [:]
            var failures: [HostingVariableTarget: String] = [:]
            for target in targets {
                do {
                    let data = try await self.call(
                        client: client,
                        tool: "hv_secrets_get",
                        arguments: [
                            "project": .string(project.displayName),
                            "env": .string(target.environment),
                            "service": .string(target.service),
                        ]
                    )
                    catalogs[target] = try HypervibeResponseMapper.decodeHostingVariables(data)
                } catch {
                    failures[target] = Self.variableFailureMessage(error)
                }
            }
            return HostingVariableInventory(catalogs: catalogs, failures: failures)
        }
    }

    public func setHostingVariable(
        project: CompanionProject,
        request: HostingVariableRequest
    ) async throws -> HostingVariableMutationResult {
        try await withSession(project: project, requiredTools: ["hv_secrets_set"]) { client in
            let data = try await self.call(
                client: client,
                tool: "hv_secrets_set",
                arguments: request.toolArguments(projectName: project.displayName)
            )
            return try HypervibeResponseMapper.decodeHostingVariableMutation(data)
        }
    }

    private func connectionMutation(
        project: CompanionProject,
        arguments: [String: Value]
    ) async throws -> ConnectionMutationResult {
        try await withSession(project: project, requiredTools: ["hv_connect"]) { client in
            let data = try await self.call(
                client: client,
                tool: "hv_connect",
                arguments: arguments
            )
            return try HypervibeResponseMapper.decodeConnectionMutation(data)
        }
    }

    private func mutationArguments(
        action: String,
        provider: String,
        scope: String?
    ) -> [String: Value] {
        var arguments: [String: Value] = [
            "action": .string(action),
            "provider": .string(provider),
        ]
        if let scope = scope?.trimmingCharacters(in: .whitespacesAndNewlines),
            !scope.isEmpty,
            scope.caseInsensitiveCompare("global") != .orderedSame {
            arguments["scope"] = .string(scope)
        }
        return arguments
    }

    private static func variableFailureMessage(_ error: Error) -> String {
        if let localized = error as? LocalizedError,
            let description = localized.errorDescription,
            !description.isEmpty {
            return description
        }
        return "Hypervibe could not read this target."
    }

    private func withSession<Result: Sendable>(
        project: CompanionProject,
        requiredTools: [String],
        operation: (Client) async throws -> Result
    ) async throws -> Result {
        let repositoryURL = URL(fileURLWithPath: project.repositoryPath)
            .standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: repositoryURL.path,
            isDirectory: &isDirectory
        ), isDirectory.boolValue else {
            throw HypervibeClientError.invalidRepository
        }

        let executableURL = URL(fileURLWithPath: project.hypervibeExecutablePath)
            .standardizedFileURL
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw HypervibeClientError.invalidExecutable
        }

        let process = Process()
        process.executableURL = executableURL
        process.arguments = project.hypervibeArguments ?? []
        process.currentDirectoryURL = repositoryURL
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "HYPERVIBE_DATA_DIR")
        if let dataDirectory = project.hypervibeDataDirectory?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !dataDirectory.isEmpty {
            environment["HYPERVIBE_DATA_DIR"] = dataDirectory
        }
        process.environment = environment

        let serverInput = Pipe()
        let serverOutput = Pipe()
        process.standardInput = serverInput
        process.standardOutput = serverOutput
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            throw HypervibeClientError.launchFailed
        }

        let transport = StdioTransport(
            input: FileDescriptor(
                rawValue: serverOutput.fileHandleForReading.fileDescriptor
            ),
            output: FileDescriptor(
                rawValue: serverInput.fileHandleForWriting.fileDescriptor
            )
        )
        let client = Client(
            name: "hypervibe-companion",
            version: "0.1.0",
            title: "Hypervibe Companion",
            configuration: .strict
        )

        do {
            _ = try await client.connect(transport: transport)
            let (tools, _) = try await client.listTools()
            let names = Set(tools.map(\.name))
            let missing = (["hv_upgrade"] + requiredTools).filter { !names.contains($0) }
            if !missing.isEmpty {
                throw HypervibeClientError.incompatibleTools(missing)
            }

            let upgradeData = try await call(
                client: client,
                tool: "hv_upgrade",
                arguments: ["action": "status"]
            )
            try HypervibeResponseMapper.decodeUpgradeStatus(upgradeData)
            let result = try await operation(client)
            await stop(client: client, process: process, input: serverInput, output: serverOutput)
            return result
        } catch {
            await stop(client: client, process: process, input: serverInput, output: serverOutput)
            if !process.isRunning, process.terminationStatus != 0,
                !(error is HypervibeClientError) {
                throw HypervibeClientError.processExited(process.terminationStatus)
            }
            throw error
        }
    }

    private func call(
        client: Client,
        tool: String,
        arguments: [String: Value]?
    ) async throws -> Data {
        let request = CallTool.request(
            .init(name: tool, arguments: arguments)
        )
        let context = try await client.send(request)
        let result = try await context.value
        guard let structuredContent = result.structuredContent
            ?? result._meta?["hypervibeEnvelope"] else {
            throw HypervibeClientError.missingStructuredContent(tool)
        }
        return try encoder.encode(structuredContent)
    }

    private func stop(
        client: Client,
        process: Process,
        input: Pipe,
        output: Pipe
    ) async {
        await client.disconnect()
        try? input.fileHandleForWriting.close()
        try? output.fileHandleForReading.close()
        if process.isRunning {
            process.terminate()
        }
        process.waitUntilExit()
    }
}
