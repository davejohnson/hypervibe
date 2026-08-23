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
    case missingStructuredContent(String)
    case malformedResponse(String)
    case invalidDeployment(String)
    case timedOut(String)
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
        case .missingStructuredContent(let tool):
            return "\(tool) returned no structured response."
        case .malformedResponse(let message):
            return message
        case .invalidDeployment(let message):
            return message
        case .timedOut(let operation):
            return "Hypervibe timed out while \(operation). Check the configured runtime and try Refresh again."
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
    private let handshakeTimeout: Duration
    private let toolTimeout: Duration
    public nonisolated let clientVersion: String

    public init(
        clientVersion: String,
        handshakeTimeout: Duration = .seconds(15),
        toolTimeout: Duration = .seconds(90)
    ) {
        let normalized = clientVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        self.clientVersion = normalized.isEmpty ? "development" : normalized
        self.handshakeTimeout = handshakeTimeout
        self.toolTimeout = toolTimeout
    }

    public func probe(project: CompanionProject) async throws -> CompanionProjectReadiness {
        let specURL = URL(fileURLWithPath: project.repositoryPath)
            .standardizedFileURL
            .appendingPathComponent(".hypervibe/spec.json", isDirectory: false)
        return try await withSession(
            project: project,
            requiredTools: ["hv_spec"]
        ) { client -> CompanionProjectReadiness in
            // A legacy single-project local cache must not make an unrelated
            // repository look initialized. The repo-backed spec is the shared
            // project identity; chat can create it with hv_spec.
            guard FileManager.default.fileExists(atPath: specURL.path) else {
                return CompanionProjectReadiness.uninitialized
            }
            do {
                _ = try await self.call(
                    client: client,
                    tool: "hv_spec",
                    arguments: [:]
                )
                return CompanionProjectReadiness.initialized
            } catch HypervibeClientError.tool(let code, _, _) where code == "NOT_FOUND" {
                return CompanionProjectReadiness.uninitialized
            }
        }
    }

    public func refresh(
        project: CompanionProject,
        previous: ProjectSnapshot? = nil
    ) async throws -> CompanionRefresh {
        try await withSession(
            project: project,
            requiredTools: [
                "hv_spec",
                "hv_status",
                "hv_health",
                "hv_runs",
                "hv_connections",
            ]
        ) { client in
            let specData = try await self.call(
                client: client,
                tool: "hv_spec",
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
                var endpointHealth: [PublicEndpointHealth] = []
                for resource in environment.resources where
                    resource.kind == .service
                    && resource.isPublic == true {
                    guard observation.services?
                        .first(where: { $0.name == resource.name })?
                        .preferredURL != nil else {
                        continue
                    }
                    do {
                        let healthData = try await self.call(
                            client: client,
                            tool: "hv_health",
                            arguments: [
                                "project": .string(topology.projectName),
                                "env": .string(environment.name),
                                "service": .string(resource.name),
                            ]
                        )
                        endpointHealth.append(
                            try HypervibeResponseMapper.decodePublicEndpointHealth(
                                healthData,
                                fallbackService: resource.name,
                                checkedAt: attemptedAt
                            )
                        )
                    } catch {
                        // A missing/private endpoint is not provider drift. The
                        // live observation remains independently unverified.
                    }
                }

                environments.append(
                    EnvironmentSnapshot(
                        name: environment.name,
                        specRevision: topology.specRevision,
                        resources: environment.resources,
                        observation: observation,
                        publicEndpointHealth: endpointHealth
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
                tool: "hv_connections",
                arguments: [:]
            )
            let connections = try HypervibeResponseMapper.decodeConnections(connectionsData)
            return CompanionRefresh(
                snapshot: ProjectSnapshot(
                    projectID: project.id,
                    projectName: topology.projectName,
                    generatedAt: attemptedAt,
                    environments: environments,
                    recentRuns: runs,
                    github: topology.github
                ),
                connections: connections
            )
        }
    }

    public func connectionCatalog(project: CompanionProject) async throws -> ConnectionCatalog {
        try await withSession(project: project, requiredTools: ["hv_connections"]) { client in
            let data = try await self.call(
                client: client,
                tool: "hv_connections",
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
        try await withSession(project: project, requiredTools: ["hv_secrets"]) { client in
            var catalogs: [HostingVariableTarget: HostingVariableCatalog] = [:]
            var failures: [HostingVariableTarget: String] = [:]
            for target in targets {
                do {
                    let data = try await self.call(
                        client: client,
                        tool: "hv_secrets",
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

    public func prepareProductionDeployment(
        project: CompanionProject,
        environment: EnvironmentSnapshot
    ) async throws -> ProductionDeploymentPreparation {
        guard environment.isProductionTarget else {
            throw HypervibeClientError.invalidDeployment(
                "\(environment.name) is not declared as a production promotion target."
            )
        }
        let branch = environment.deployment?.branch ?? "main"
        guard environment.deployment?.usesManagedCI == true else {
            return ProductionDeploymentPreparation(
                mechanism: .direct,
                environment: environment.name,
                specRevision: environment.specRevision,
                branch: branch
            )
        }

        return try await withSession(
            project: project,
            requiredTools: ["hv_ci_status"]
        ) { client in
            let data = try await self.call(
                client: client,
                tool: "hv_ci_status",
                arguments: [
                    "project": .string(project.displayName),
                    "include": .array([.string("definitions")]),
                ]
            )
            let catalog = try HypervibeResponseMapper.decodeCIDefinitionCatalog(data)
            return ProductionDeploymentPreparation(
                mechanism: .managedCI,
                environment: environment.name,
                specRevision: environment.specRevision,
                branch: branch,
                definitions: catalog.definitions,
                requiresExactRefSHA: catalog.usesCanonicalBindings
            )
        }
    }

    public func deployProduction(
        project: CompanionProject,
        environment: EnvironmentSnapshot,
        preparation: ProductionDeploymentPreparation,
        definitionID: String? = nil,
        commitSHA: String? = nil
    ) async throws -> ProductionDeploymentResult {
        guard environment.isProductionTarget,
            preparation.environment == environment.name,
            preparation.specRevision == environment.specRevision else {
            throw HypervibeClientError.invalidDeployment(
                "Production deployment details are stale. Close this window and try again."
            )
        }

        switch preparation.mechanism {
        case .direct:
            return try await withSession(project: project, requiredTools: ["hv_deploy"]) {
                client in
                let data = try await self.call(
                    client: client,
                    tool: "hv_deploy",
                    arguments: Self.directDeploymentArguments(
                        projectName: project.displayName,
                        environment: environment.name
                    )
                )
                return try HypervibeResponseMapper.decodeDirectDeployment(data)
            }

        case .managedCI:
            guard let definitionID,
                let definition = preparation.eligibleDefinitions.first(where: {
                    $0.id == definitionID
                }) else {
                throw HypervibeClientError.invalidDeployment(
                    "Choose the reviewed production CI definition before deploying."
                )
            }
            let sha = commitSHA?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard sha.range(
                of: "^[0-9a-fA-F]{40}$",
                options: .regularExpression
            ) != nil else {
                throw HypervibeClientError.invalidDeployment(
                    "Enter the full 40-character commit SHA that was verified in staging."
                )
            }

            return try await withSession(
                project: project,
                requiredTools: ["hv_ci_trigger"]
            ) { client in
                let data = try await self.call(
                    client: client,
                    tool: "hv_ci_trigger",
                    arguments: Self.ciDeploymentArguments(
                        projectName: project.displayName,
                        environment: environment.name,
                        preparation: preparation,
                        definition: definition,
                        commitSHA: sha
                    )
                )
                return try HypervibeResponseMapper.decodeCIDeployment(data)
            }
        }
    }

    static func directDeploymentArguments(
        projectName: String,
        environment: String
    ) -> [String: Value] {
        [
            "project": .string(projectName),
            "env": .string(environment),
            "confirm": .bool(true),
        ]
    }

    static func ciDeploymentArguments(
        projectName: String,
        environment: String,
        preparation: ProductionDeploymentPreparation,
        definition: CIDefinitionSummary,
        commitSHA: String
    ) -> [String: Value] {
        var inputs: [String: Value] = [
            "commit_sha": .string(commitSHA),
        ]
        if !definition.isExplicitlyScoped(to: environment) {
            inputs["environment"] = .string(environment)
        }
        var arguments: [String: Value] = [
            "project": .string(projectName),
            "definition": .string(definition.id),
            "ref": .string(preparation.branch),
            "inputs": .object(inputs),
        ]
        if preparation.requiresExactRefSHA {
            arguments["sha"] = .string(commitSHA)
        }
        return arguments
    }

    private func connectionMutation(
        project: CompanionProject,
        arguments: [String: Value]
    ) async throws -> ConnectionMutationResult {
        try await withSession(project: project, requiredTools: ["hv_connections"]) { client in
            let data = try await self.call(
                client: client,
                tool: "hv_connections",
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
            version: clientVersion,
            title: "Hypervibe Companion",
            configuration: .strict
        )

        do {
            _ = try await withTimeout(
                after: handshakeTimeout,
                operationDescription: "starting the project MCP runtime"
            ) {
                try await client.connect(transport: transport)
            }
            let (tools, _) = try await withTimeout(
                after: handshakeTimeout,
                operationDescription: "loading the project MCP tools"
            ) {
                try await client.listTools()
            }
            let names = Set(tools.map(\.name))
            let missing = requiredTools.filter { !names.contains($0) }
            if !missing.isEmpty {
                throw HypervibeClientError.incompatibleTools(missing)
            }

            let result = try await operation(client)
            await stop(client: client, process: process, input: serverInput, output: serverOutput)
            return result
        } catch {
            let earlyExitStatus = process.isRunning
                ? nil
                : process.terminationStatus
            await stop(client: client, process: process, input: serverInput, output: serverOutput)
            if let earlyExitStatus, earlyExitStatus != 0,
                (!(error is HypervibeClientError) || error.isHypervibeTimeout) {
                throw HypervibeClientError.processExited(earlyExitStatus)
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
        let result = try await withTimeout(
            after: toolTimeout,
            operationDescription: "waiting for \(tool)"
        ) {
            let context = try await client.send(request)
            return try await context.value
        }
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
        try? input.fileHandleForWriting.close()
        if process.isRunning {
            process.terminate()
        }
        try? output.fileHandleForReading.close()
        await client.disconnect()
        process.waitUntilExit()
    }

    private func withTimeout<Value: Sendable>(
        after timeout: Duration,
        operationDescription: String,
        operation: @escaping @Sendable () async throws -> Value
    ) async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            let race = TimeoutRace(continuation)
            let timeoutTask = Task {
                do {
                    try await Task.sleep(for: timeout)
                } catch {
                    return
                }
                _ = race.resolve(
                    .failure(HypervibeClientError.timedOut(operationDescription))
                )
            }
            Task {
                let result: Result<Value, Error>
                do {
                    result = .success(try await operation())
                } catch {
                    result = .failure(error)
                }
                if race.resolve(result) {
                    timeoutTask.cancel()
                }
            }
        }
    }
}

private final class TimeoutRace<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?

    init(_ continuation: CheckedContinuation<Value, Error>) {
        self.continuation = continuation
    }

    @discardableResult
    func resolve(_ result: Result<Value, Error>) -> Bool {
        lock.lock()
        guard let continuation else {
            lock.unlock()
            return false
        }
        self.continuation = nil
        lock.unlock()
        continuation.resume(with: result)
        return true
    }
}

private extension Error {
    var isHypervibeTimeout: Bool {
        guard let error = self as? HypervibeClientError,
            case .timedOut = error else {
            return false
        }
        return true
    }
}
