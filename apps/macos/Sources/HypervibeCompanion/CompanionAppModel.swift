import AppKit
import Foundation
import HypervibeCompanionCore

enum CompanionUpdateState: Equatable {
    case idle
    case checking
    case upToDate(version: String)
    case available(CompanionRelease)
    case installing(version: String)
    case failed(String)

    var isBusy: Bool {
        switch self {
        case .checking, .installing:
            true
        default:
            false
        }
    }
}

@MainActor
final class CompanionAppModel: ObservableObject {
    @Published private(set) var projects: [CompanionProject] = []
    @Published private(set) var snapshots: [UUID: ProjectSnapshot] = [:]
    @Published private(set) var connections: [UUID: [ConnectionSummary]] = [:]
    @Published private(set) var connectionCatalogs: [UUID: ConnectionCatalog] = [:]
    @Published private(set) var loadingConnectionCatalogIDs: Set<UUID> = []
    @Published private(set) var connectionCatalogErrors: [UUID: String] = [:]
    @Published var selectedProjectID: UUID?
    @Published private(set) var refreshingProjectIDs: Set<UUID> = []
    @Published private(set) var refreshErrors: [UUID: String] = [:]
    @Published private(set) var loadError: String?
    @Published private(set) var mcpHostStatuses: [MCPHost: MCPHostConnectionStatus] = [:]
    @Published private(set) var mcpHostErrors: [MCPHost: String] = [:]
    @Published private(set) var updatingMCPHosts: Set<MCPHost> = []
    @Published private(set) var companionUpdateState: CompanionUpdateState = .idle

    private let registry = ProjectRegistryStore(
        fileURL: ProjectRegistryStore.defaultFileURL()
    )
    private let cache = SnapshotCache(
        fileURL: SnapshotCache.defaultFileURL()
    )
    private let mcpClient = HypervibeMCPClient(
        clientVersion: CompanionDistribution.currentVersion ?? "development"
    )
    private let mcpHostConfigurator = MCPHostConfigurator()
    private let releaseClient = GitHubReleaseClient()
    private let updateInstaller = CompanionUpdateInstaller()
    private var didLoad = false

    var selectedProject: CompanionProject? {
        guard let selectedProjectID else { return projects.first }
        return projects.first { $0.id == selectedProjectID }
    }

    var selectedSnapshot: ProjectSnapshot? {
        selectedProject.flatMap { snapshots[$0.id] }
    }

    var selectedConnections: [ConnectionSummary] {
        guard let projectID = selectedProject?.id else { return [] }
        return connections[projectID] ?? []
    }

    /// Any environment in any project is drifted, blocked, or failed to refresh.
    var needsAttention: Bool {
        AggregateHealth.needsAttention(
            snapshots: Array(snapshots.values),
            hasRefreshFailure: loadError != nil || !refreshErrors.isEmpty
        )
    }

    func loadIfNeeded() async {
        guard !didLoad else { return }
        didLoad = true

        do {
            projects = try await registry.load()
            if CompanionDistribution.isReadyForOnboarding {
                var updatedProjects = projects
                var didUpdateProjects = false
                for index in updatedProjects.indices {
                    if updatedProjects[index].hypervibeExecutablePath
                        != CompanionDistribution.launcherURL.path
                        || updatedProjects[index].hypervibeArguments != nil {
                        updatedProjects[index].hypervibeExecutablePath =
                            CompanionDistribution.launcherURL.path
                        updatedProjects[index].hypervibeArguments = nil
                        updatedProjects[index].updatedAt = Date()
                        didUpdateProjects = true
                    }
                }
                if didUpdateProjects {
                    try await registry.save(updatedProjects)
                    projects = updatedProjects
                }
            }
            let cachedSnapshots = try await cache.load()
            snapshots = Dictionary(
                uniqueKeysWithValues: cachedSnapshots.map {
                    ($0.projectID, $0.markingObservationsStale())
                }
            )
            if selectedProjectID == nil {
                selectedProjectID = projects.first?.id
            }
            loadError = nil
        } catch {
            projects = []
            snapshots = [:]
            loadError = "Could not load companion data."
            return
        }

        for project in projects {
            await refresh(projectID: project.id)
        }
        await refreshMCPHostStatuses()
    }

    func refreshSelectedProject() async {
        guard let projectID = selectedProject?.id else { return }
        await refresh(projectID: projectID)
    }

    func refresh(projectID: UUID) async {
        guard let project = projects.first(where: { $0.id == projectID }),
            !refreshingProjectIDs.contains(projectID) else {
            return
        }

        refreshingProjectIDs.insert(projectID)
        defer { refreshingProjectIDs.remove(projectID) }

        do {
            let refresh = try await mcpClient.refresh(
                project: project,
                previous: snapshots[projectID]
            )
            snapshots[projectID] = refresh.snapshot
            connections[projectID] = refresh.connections
            try await cache.replace(refresh.snapshot)
            refreshErrors.removeValue(forKey: projectID)
        } catch {
            refreshErrors[projectID] = userFacingMessage(for: error)
        }
    }

    func loadConnectionCatalog(projectID: UUID) async {
        guard let project = projects.first(where: { $0.id == projectID }),
            !loadingConnectionCatalogIDs.contains(projectID) else {
            return
        }
        loadingConnectionCatalogIDs.insert(projectID)
        defer { loadingConnectionCatalogIDs.remove(projectID) }

        do {
            try await reloadConnectionCatalog(project: project)
            connectionCatalogErrors.removeValue(forKey: projectID)
        } catch {
            connectionCatalogErrors[projectID] = userFacingMessage(for: error)
        }
    }

    func addConnection(
        projectID: UUID,
        request: ConnectionRequest
    ) async throws -> ConnectionMutationResult {
        let project = try connectionProject(id: projectID)
        do {
            let result = try await mcpClient.addConnection(project: project, request: request)
            await refreshCatalogAfterSuccessfulMutation(result, project: project)
            return result
        } catch let mutationError {
            // hv_connect deliberately keeps a saved connection when verification
            // fails. Re-read the catalog so the failed row is immediately visible.
            do {
                try await reloadConnectionCatalog(project: project)
                connectionCatalogErrors.removeValue(forKey: projectID)
            } catch {
                if let clientError = mutationError as? HypervibeClientError,
                    case .tool(let code, _, let hint) = clientError,
                    code == "PROVIDER_ERROR",
                    hint?.localizedCaseInsensitiveContains("connection was saved") == true {
                    replaceLocalConnection(
                        projectID: projectID,
                        provider: request.provider,
                        scope: request.scope,
                        status: .failed,
                        lastVerifiedAt: nil
                    )
                }
            }
            throw mutationError
        }
    }

    func verifyConnection(
        projectID: UUID,
        provider: String,
        scope: String
    ) async throws -> ConnectionMutationResult {
        let project = try connectionProject(id: projectID)
        do {
            let result = try await mcpClient.verifyConnection(
                project: project,
                provider: provider,
                scope: scope
            )
            await refreshCatalogAfterSuccessfulMutation(result, project: project)
            return result
        } catch let mutationError {
            do {
                try await reloadConnectionCatalog(project: project)
                connectionCatalogErrors.removeValue(forKey: projectID)
            } catch {
                replaceLocalConnection(
                    projectID: projectID,
                    provider: provider,
                    scope: scope,
                    status: .failed,
                    lastVerifiedAt: nil
                )
            }
            throw mutationError
        }
    }

    func removeConnection(
        projectID: UUID,
        provider: String,
        scope: String
    ) async throws -> ConnectionMutationResult {
        let project = try connectionProject(id: projectID)
        let result = try await mcpClient.removeConnection(
            project: project,
            provider: provider,
            scope: scope
        )
        await refreshCatalogAfterSuccessfulMutation(result, project: project)
        return result
    }

    func hostingVariables(
        projectID: UUID,
        targets: [HostingVariableTarget]
    ) async throws -> HostingVariableInventory {
        let project = try connectionProject(id: projectID)
        return try await mcpClient.hostingVariables(
            project: project,
            targets: targets
        )
    }

    func setHostingVariable(
        projectID: UUID,
        request: HostingVariableRequest
    ) async throws -> HostingVariableMutationResult {
        let project = try connectionProject(id: projectID)
        return try await mcpClient.setHostingVariable(
            project: project,
            request: request
        )
    }

    func addProject(_ draft: ProjectDraft) async throws {
        var project = CompanionProject(
            displayName: draft.displayName.trimmingCharacters(
                in: .whitespacesAndNewlines
            ),
            repositoryPath: draft.repositoryPath.trimmingCharacters(
                in: .whitespacesAndNewlines
            ),
            hypervibeExecutablePath: draft.executablePath.trimmingCharacters(
                in: .whitespacesAndNewlines
            ),
            hypervibeArguments: draft.arguments,
            hypervibeDataDirectory: draft.dataDirectory.nilIfBlank
        )

        let refresh: CompanionRefresh
        do {
            refresh = try await mcpClient.refresh(project: project)
        } catch {
            throw ProjectSetupError.validation(userFacingMessage(for: error))
        }

        project.displayName = refresh.snapshot.projectName
        project.updatedAt = Date()
        projects = try await registry.upsert(project)
        try await cache.replace(refresh.snapshot)
        snapshots[project.id] = refresh.snapshot
        connections[project.id] = refresh.connections
        selectedProjectID = project.id
        refreshErrors.removeValue(forKey: project.id)
        await refreshMCPHostStatuses()
    }

    func removeProject(id: UUID) async {
        do {
            if let project = projects.first(where: { $0.id == id }) {
                for host in MCPHost.allCases {
                    try? await mcpHostConfigurator.disconnect(
                        host,
                        projects: [project]
                    )
                }
            }
            projects = try await registry.remove(id: id)
            try await cache.remove(projectID: id)
            snapshots.removeValue(forKey: id)
            connections.removeValue(forKey: id)
            connectionCatalogs.removeValue(forKey: id)
            connectionCatalogErrors.removeValue(forKey: id)
            refreshErrors.removeValue(forKey: id)
            if selectedProjectID == id {
                selectedProjectID = projects.first?.id
            }
            await refreshMCPHostStatuses()
        } catch {
            loadError = "Could not remove the project from the companion."
        }
    }

    func refreshMCPHostStatuses(clearErrors: Bool = false) async {
        for host in MCPHost.allCases {
            do {
                mcpHostStatuses[host] = try await mcpHostConfigurator.status(
                    for: host,
                    projects: projects,
                    launcherURL: CompanionDistribution.launcherURL
                )
                if clearErrors {
                    mcpHostErrors.removeValue(forKey: host)
                }
            } catch {
                mcpHostErrors[host] = userFacingMessage(for: error)
            }
        }
    }

    func toggleMCPHost(_ host: MCPHost) async {
        guard !updatingMCPHosts.contains(host) else { return }
        guard CompanionDistribution.isReadyForOnboarding else {
            mcpHostErrors[host] = CompanionDistribution.onboardingGuidance
            return
        }
        updatingMCPHosts.insert(host)
        defer { updatingMCPHosts.remove(host) }

        do {
            if mcpHostStatuses[host]?.isFullyConnected == true {
                try await mcpHostConfigurator.disconnect(
                    host,
                    projects: projects
                )
            } else {
                try await mcpHostConfigurator.connect(
                    host,
                    projects: projects,
                    launcherURL: CompanionDistribution.launcherURL
                )
            }
            mcpHostErrors.removeValue(forKey: host)
            await refreshMCPHostStatuses(clearErrors: true)
        } catch {
            mcpHostErrors[host] = userFacingMessage(for: error)
            await refreshMCPHostStatuses()
        }
    }

    func checkForCompanionUpdate(force: Bool = false) async {
        guard !companionUpdateState.isBusy else { return }
        if !force, companionUpdateState != .idle {
            return
        }
        guard let currentVersion = CompanionDistribution.currentVersion else {
            companionUpdateState = .failed(
                "Version checks are available in the packaged Hypervibe app."
            )
            return
        }

        companionUpdateState = .checking
        do {
            if let release = try await releaseClient.latestUpdate(
                currentVersion: currentVersion
            ) {
                companionUpdateState = .available(release)
            } else {
                companionUpdateState = .upToDate(version: currentVersion)
            }
        } catch {
            companionUpdateState = .failed(userFacingMessage(for: error))
        }
    }

    func restartAndUpdateCompanion() async {
        guard case .available(let release) = companionUpdateState else { return }
        companionUpdateState = .installing(version: release.version)

        do {
            let prepared = try await updateInstaller.prepare(
                release: release,
                currentBundleURL: Bundle.main.bundleURL
            )
            try await updateInstaller.launchRestartHelper(
                prepared,
                processIdentifier: ProcessInfo.processInfo.processIdentifier
            )
            NSApplication.shared.terminate(nil)
        } catch {
            companionUpdateState = .failed(userFacingMessage(for: error))
        }
    }

    private func userFacingMessage(for error: Error) -> String {
        if let localized = error as? LocalizedError,
            let description = localized.errorDescription {
            return description
        }
        return "Hypervibe refresh failed."
    }

    func connectionMessage(for error: Error) -> String {
        userFacingMessage(for: error)
    }

    private func reloadConnectionCatalog(project: CompanionProject) async throws {
        let catalog = try await mcpClient.connectionCatalog(project: project)
        connectionCatalogs[project.id] = catalog
        connections[project.id] = catalog.connections
    }

    private func refreshCatalogAfterSuccessfulMutation(
        _ result: ConnectionMutationResult,
        project: CompanionProject
    ) async {
        do {
            try await reloadConnectionCatalog(project: project)
            connectionCatalogErrors.removeValue(forKey: project.id)
        } catch {
            if result.removed {
                removeLocalConnection(
                    projectID: project.id,
                    provider: result.provider,
                    scope: result.scope
                )
            } else {
                replaceLocalConnection(
                    projectID: project.id,
                    provider: result.provider,
                    scope: result.scope,
                    status: result.status,
                    lastVerifiedAt: result.status == .verified ? Date() : nil
                )
            }
            connectionCatalogErrors[project.id] =
                "The connection changed successfully, but Hypervibe could not refresh the list."
        }
    }

    private func replaceLocalConnection(
        projectID: UUID,
        provider: String,
        scope: String?,
        status: ConnectionStatus,
        lastVerifiedAt: Date?
    ) {
        let normalizedScope = normalizedConnectionScope(scope)
        var updated = connections[projectID] ?? []
        updated.removeAll {
            $0.provider == provider
                && $0.scope.caseInsensitiveCompare(normalizedScope) == .orderedSame
        }
        updated.append(
            ConnectionSummary(
                provider: provider,
                scope: normalizedScope,
                status: status,
                lastVerifiedAt: lastVerifiedAt
            )
        )
        updateLocalConnections(updated, projectID: projectID)
    }

    private func removeLocalConnection(
        projectID: UUID,
        provider: String,
        scope: String?
    ) {
        let normalizedScope = normalizedConnectionScope(scope)
        let updated = (connections[projectID] ?? []).filter {
            $0.provider != provider
                || $0.scope.caseInsensitiveCompare(normalizedScope) != .orderedSame
        }
        updateLocalConnections(updated, projectID: projectID)
    }

    private func updateLocalConnections(
        _ values: [ConnectionSummary],
        projectID: UUID
    ) {
        let updated = values.sorted {
            if $0.provider == $1.provider {
                return $0.scope.localizedCaseInsensitiveCompare($1.scope) == .orderedAscending
            }
            return $0.provider.localizedCaseInsensitiveCompare($1.provider) == .orderedAscending
        }
        connections[projectID] = updated
        if let catalog = connectionCatalogs[projectID] {
            connectionCatalogs[projectID] = ConnectionCatalog(
                connections: updated,
                providers: catalog.providers
            )
        }
    }

    private func normalizedConnectionScope(_ scope: String?) -> String {
        let value = scope?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? "global" : value
    }

    private func connectionProject(id: UUID) throws -> CompanionProject {
        guard let project = projects.first(where: { $0.id == id }) else {
            throw ConnectionManagementError.projectUnavailable
        }
        return project
    }
}

private enum ConnectionManagementError: LocalizedError {
    case projectUnavailable

    var errorDescription: String? {
        "This project is no longer available in Hypervibe Companion."
    }
}

enum ProjectSetupError: LocalizedError {
    case validation(String)

    var errorDescription: String? {
        switch self {
        case .validation(let message):
            return message
        }
    }
}

private extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
