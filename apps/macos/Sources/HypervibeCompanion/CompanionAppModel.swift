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

    private let registry = ProjectRegistryStore(
        fileURL: ProjectRegistryStore.defaultFileURL()
    )
    private let cache = SnapshotCache(
        fileURL: SnapshotCache.defaultFileURL()
    )
    private let mcpClient = HypervibeMCPClient()
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
    }

    func removeProject(id: UUID) async {
        do {
            projects = try await registry.remove(id: id)
            try await cache.remove(projectID: id)
            snapshots.removeValue(forKey: id)
            connections.removeValue(forKey: id)
            refreshErrors.removeValue(forKey: id)
            if selectedProjectID == id {
                selectedProjectID = projects.first?.id
            }
        } catch {
            loadError = "Could not remove the project from the companion."
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
