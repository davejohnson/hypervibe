import HypervibeCompanionCore
import SwiftUI

struct ProjectDashboardView: View {
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

                    if !connections.isEmpty {
                        connectionGrid
                    }
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
                        ConnectionCard(connections: group)
                    }
                }
                .padding(.top, 9)
            } label: {
                HStack {
                    Text("Connections")
                        .font(.headline)
                    Spacer()
                    Text("\(connections.filter { $0.status == .verified }.count) verified")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
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
                            Label(
                                "\(observation.driftCount) drift",
                                systemImage: "arrow.triangle.2.circlepath"
                            )
                            Label(
                                "\(observation.unmanagedCount) unmanaged",
                                systemImage: "questionmark.diamond"
                            )
                            Spacer()
                            Text("spec \(environment.specRevision)")
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
                        resourceRow(resource)
                    }
                }
                .padding(.top, 8)
            } label: {
                environmentHeader(environment)
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
    }

    private func environmentExpansion(_ environment: String) -> Binding<Bool> {
        let key = "\(project.id.uuidString):\(environment)"
        return Binding(
            get: { expandedEnvironments[key] ?? true },
            set: { expandedEnvironments[key] = $0 }
        )
    }

    private func resourceRow(_ resource: ResourceSummary) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: resource.kind.systemImage)
                .frame(width: 18)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(resource.name)
                    .lineLimit(1)
                if !resource.relationships.isEmpty {
                    Text(resource.relationships.map(\.displayText).joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
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
                HStack {
                    Text("Recent runs")
                        .font(.headline)
                    Spacer()
                    Text("\(runs.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
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
