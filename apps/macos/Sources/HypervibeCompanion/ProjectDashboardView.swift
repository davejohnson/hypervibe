import AppKit
import HypervibeCompanionCore
import SwiftUI

struct ProjectDashboardView: View {
    @Environment(\.openWindow) private var openWindow
    @State private var expandedEnvironments: [String: Bool] = [:]
    @State private var recentRunsExpanded = false
    @State private var connectionsExpanded = false

    let project: CompanionProject
    let snapshot: ProjectSnapshot?
    let connections: [ConnectionSummary]
    let refreshError: String?
    let isRefreshing: Bool

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isRefreshing {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Observing \(project.displayName)…")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 14)
                }

                if let refreshError {
                    Label(refreshError, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))
                        .padding(.horizontal, 12)
                }

                if let snapshot {
                    ForEach(snapshot.environments) { environment in
                        environmentCard(environment)
                    }

                    if !snapshot.recentRuns.isEmpty {
                        recentRuns(snapshot.recentRuns)
                    }

                    connectionGrid
                } else if !isRefreshing {
                    ContentUnavailableView(
                        "No snapshot yet",
                        systemImage: "arrow.clockwise.circle",
                        description: Text("Refresh to read this project through Hypervibe.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                }
            }
            .padding(.vertical, 12)
        }
    }

    private var connectionGrid: some View {
        let groups = Dictionary(grouping: connections, by: \.provider)
            .values
            .sorted {
                ($0.first?.provider ?? "")
                    .localizedCaseInsensitiveCompare($1.first?.provider ?? "")
                    == .orderedAscending
            }

        return VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(isExpanded: $connectionsExpanded) {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: 8),
                        GridItem(.flexible(), spacing: 8),
                    ],
                    spacing: 8
                ) {
                    ForEach(groups, id: \.first?.provider) { group in
                        Button {
                            showConnections(provider: group.first?.provider)
                        } label: {
                            ConnectionCard(connections: group)
                        }
                        .buttonStyle(.plain)
                        .clickTargetCursor()
                    }
                }
                .padding(.top, 9)
                if connections.isEmpty {
                    HStack {
                        Text("No provider connections yet.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Add Connection…") {
                            showConnections()
                        }
                        .clickTargetCursor()
                    }
                    .padding(.top, 8)
                }
            } label: {
                HStack {
                    Text("Connections")
                        .font(.headline)
                    Spacer()
                    if !connections.isEmpty {
                        Text("\(connections.filter { $0.status == .verified }.count) verified")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Button {
                        showConnections()
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.borderless)
                    .help("Add provider connection")
                }
                .clickTargetCursor()
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
    }

    private func showConnections(provider: String? = nil) {
        let menuPanel = NSApplication.shared.keyWindow
        openWindow(
            id: "connections",
            value: ConnectionWindowRoute(projectID: project.id, provider: provider)
        )
        menuPanel?.orderOut(nil)
    }

    private func environmentCard(
        _ environment: EnvironmentSnapshot
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            DisclosureGroup(
                isExpanded: environmentExpansion(environment.name)
            ) {
                VStack(alignment: .leading, spacing: 9) {
                    if let observation = environment.observation {
                        HStack(spacing: 12) {
                            if let checkedAt = observation.latestSuccessfulAt {
                                Label(
                                    "checked \(checkedAt.formatted(.relative(presentation: .named)))",
                                    systemImage: "clock"
                                )
                                .help("Last successful observation of this environment")
                            }
                            if observation.driftCount > 0 {
                                Label(
                                    "\(observation.driftCount) drifted",
                                    systemImage: "arrow.triangle.2.circlepath"
                                )
                                .foregroundStyle(.orange)
                                .help(driftSummary(observation))
                            }
                            if observation.unmanagedCount > 0 {
                                Label(
                                    "\(observation.unmanagedCount) unmanaged",
                                    systemImage: "questionmark.diamond"
                                )
                            }
                            Spacer()
                            if environment.resources.contains(where: { $0.kind == .service }) {
                                Button {
                                    showVariables(environment: environment.name)
                                } label: {
                                    Label("Variables", systemImage: "key")
                                }
                                .buttonStyle(.borderless)
                                .help("Manage runtime variables and secrets")
                                .clickTargetCursor()
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)

                        if !observation.blockedProviders.isEmpty {
                            Text("Blocked: \(observation.blockedProviders.joined(separator: ", "))")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    }

                    Divider()

                    ForEach(environment.resources) { resource in
                        resourceRow(resource, observation: environment.observation)
                    }
                }
                .padding(.top, 8)
            } label: {
                environmentHeader(environment)
                    .clickTargetCursor()
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
    }

    private func environmentHeader(
        _ environment: EnvironmentSnapshot
    ) -> some View {
        HStack {
            if let observation = environment.observation {
                Image(systemName: observation.health.systemImage)
                    .foregroundStyle(observation.health.color)
                Text(environment.name)
                    .font(.headline)
                Spacer()
                Text(observation.health.title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(observation.health.color)
            } else {
                Image(systemName: "questionmark.circle")
                    .foregroundStyle(.secondary)
                Text(environment.name)
                    .font(.headline)
                Spacer()
                Text("Unknown")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .help("Spec revision \(environment.specRevision)")
    }

    private func driftSummary(_ observation: ObservationSummary) -> String {
        let drifted = observation.driftedResources ?? []
        guard !drifted.isEmpty else {
            return "Run hv_plan for details."
        }
        return drifted
            .map { "\($0.name): \($0.actionType) pending on \($0.provider)" }
            .joined(separator: "\n")
    }

    private func showVariables(environment: String, service: String? = nil) {
        let menuPanel = NSApplication.shared.keyWindow
        openWindow(
            id: "variables",
            value: VariableWindowRoute(
                projectID: project.id,
                environment: environment,
                service: service
            )
        )
        menuPanel?.orderOut(nil)
    }

    private func environmentExpansion(_ environment: String) -> Binding<Bool> {
        let key = "\(project.id.uuidString):\(environment)"
        return Binding(
            get: { expandedEnvironments[key] ?? true },
            set: { expandedEnvironments[key] = $0 }
        )
    }

    private func resourceRow(
        _ resource: ResourceSummary,
        observation: ObservationSummary?
    ) -> some View {
        let service = resource.kind == .service
            ? observation?.service(named: resource.name)
            : nil
        let drift = observation?.driftedResource(matching: resource)
        return HStack(alignment: .top, spacing: 9) {
            Image(systemName: resource.kind.systemImage)
                .frame(width: 18)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(resource.name)
                        .lineLimit(1)
                    if let drift {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .help("\(drift.actionType) pending on \(drift.provider)")
                    }
                    if service?.status == .failed {
                        Text("failed")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.red)
                    } else if service?.status == .empty {
                        Text("not deployed")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                if !resource.relationships.isEmpty {
                    Text(resource.relationships.map(\.displayText).joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                if let url = service?.preferredURL, let host = url.host() {
                    Link(destination: url) {
                        Text(host)
                            .font(.caption2)
                            .lineLimit(1)
                    }
                    .help("Open \(url.absoluteString)")
                    .clickTargetCursor()
                }
            }
            Spacer()
            ProviderLogo(provider: resource.desiredProvider)
        }
        .font(.callout)
    }

    private func recentRuns(
        _ runs: [RecentRunSummary]
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(isExpanded: $recentRunsExpanded) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(runs.prefix(5))) { run in
                        HStack(spacing: 8) {
                            Image(systemName: run.status.systemImage)
                                .foregroundStyle(run.status.color)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(run.type)
                                    .lineLimit(1)
                                if let environment = run.environment {
                                    Text(environment)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                Text(run.status.title)
                                if let startedAt = run.startedAt {
                                    Text(startedAt, style: .relative)
                                        .font(.caption2)
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.top, 8)
            } label: {
                recentRunsLabel(runs)
                    .clickTargetCursor()
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
    }

    private func recentRunsLabel(_ runs: [RecentRunSummary]) -> some View {
        HStack(spacing: 6) {
            Text("Recent runs")
                .font(.headline)
            Spacer()
            if !recentRunsExpanded, let latest = runs.first {
                Image(systemName: latest.status.systemImage)
                    .font(.caption)
                    .foregroundStyle(latest.status.color)
                Text(latestRunSummary(latest))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Text("\(runs.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func latestRunSummary(_ run: RecentRunSummary) -> String {
        var parts = ["\(run.type) \(run.status.title.lowercased())"]
        if let startedAt = run.startedAt {
            parts.append(startedAt.formatted(.relative(presentation: .named)))
        }
        return parts.joined(separator: " · ")
    }
}

private extension EnvironmentHealth {
    var title: String {
        switch self {
        case .inSync: "In sync"
        case .drifted: "Drifted"
        case .blocked: "Blocked"
        case .unverified: "Unverified"
        case .failed: "Refresh failed"
        case .stale: "Stale"
        case .unknown: "Unknown"
        }
    }

    var systemImage: String {
        switch self {
        case .inSync: "checkmark.circle.fill"
        case .drifted: "arrow.triangle.2.circlepath.circle.fill"
        case .blocked: "exclamationmark.octagon.fill"
        case .unverified: "questionmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .stale: "clock.badge.exclamationmark"
        case .unknown: "circle.dashed"
        }
    }

    var color: Color {
        switch self {
        case .inSync: .green
        case .drifted: .orange
        case .blocked, .failed: .red
        case .unverified, .stale, .unknown: .secondary
        }
    }
}

private extension ResourceKind {
    var systemImage: String {
        switch self {
        case .service: "shippingbox"
        case .database: "cylinder"
        case .storage: "externaldrive"
        case .domain: "globe"
        case .queue: "tray.2"
        case .ci: "arrow.triangle.branch"
        case .ios: "apps.iphone"
        }
    }
}

private extension ResourceRelationship {
    var displayText: String {
        let target = targetResourceID
            .split(separator: ":", maxSplits: 1)
            .last
            .map(String.init) ?? targetResourceID
        return switch kind {
        case .uses: "uses \(target)"
        case .injectsInto: "injects into \(target)"
        case .dependsOn: "depends on \(target)"
        }
    }
}

private extension RecentRunStatus {
    var title: String {
        rawValue.capitalized
    }

    var systemImage: String {
        switch self {
        case .succeeded: "checkmark.circle.fill"
        case .running: "play.circle.fill"
        case .pending: "clock.fill"
        case .failed: "xmark.circle.fill"
        case .blocked: "exclamationmark.octagon.fill"
        case .cancelled: "minus.circle.fill"
        case .unknown: "questionmark.circle"
        }
    }

    var color: Color {
        switch self {
        case .succeeded: .green
        case .running: .blue
        case .pending: .orange
        case .failed, .blocked: .red
        case .cancelled, .unknown: .secondary
        }
    }
}
