import Foundation
import HypervibeCompanionCore

@MainActor
final class CompanionAppModel: ObservableObject {
    @Published private(set) var projects: [CompanionProject] = []
    @Published private(set) var snapshots: [UUID: ProjectSnapshot] = [:]
    @Published private(set) var connections: [UUID: [ConnectionSummary]] = [:]
    @Published var selectedProjectID: UUID?
    @Published private(set) var refreshingProjectIDs: Set<UUID> = []
    @Published private(set) var refreshErrors: [UUID: String] = [:]
    @Published private(set) var loadError: String?
    @Published private(set) var mcpHostStatuses: [MCPHost: MCPHostConnectionStatus] = [:]
    @Published private(set) var mcpHostErrors: [MCPHost: String] = [:]
    @Published private(set) var updatingMCPHosts: Set<MCPHost> = []

    private let registry = ProjectRegistryStore(
        fileURL: ProjectRegistryStore.defaultFileURL()
    )
    private let cache = SnapshotCache(
        fileURL: SnapshotCache.defaultFileURL()
    )
    private let mcpClient = HypervibeMCPClient()
    private let mcpHostConfigurator = MCPHostConfigurator()
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
            mcpHostErrors[host] = CompanionDistribution.installationGuidance
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

    private func userFacingMessage(for error: Error) -> String {
        if let localized = error as? LocalizedError,
            let description = localized.errorDescription {
            return description
        }
        return "Hypervibe refresh failed."
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
