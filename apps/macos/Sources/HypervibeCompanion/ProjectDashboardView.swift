import AppKit
import HypervibeCompanionCore
import SwiftUI

struct ProjectDashboardView: View {
    @Environment(\.openWindow) private var openWindow
    @State private var expandedEnvironments: [String: Bool] = [:]
    @State private var recentRunsExpanded = false
    @State private var connectionsExpanded = false
    @State private var githubExpanded = false
    @State private var copiedPromptID: String?

    let project: CompanionProject
    let status: ProjectStatus
    let snapshot: ProjectSnapshot?
    let connections: [ConnectionSummary]
    let refreshError: String?
    let isRefreshing: Bool

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                statusCard

                if let snapshot {
                    ForEach(snapshot.environments) { environment in
                        environmentCard(
                            environment,
                            status: EnvironmentStatus.evaluate(
                                environment,
                                projectName: snapshot.projectName
                            ),
                            isOnlyEnvironment: snapshot.environments.count == 1
                        )
                    }

                    if !snapshot.recentRuns.isEmpty {
                        recentRuns(snapshot.recentRuns)
                    }

                    connectionGrid

                    githubCard(snapshot.github)
                }
            }
            .padding(.vertical, 12)
        }
    }

    /// The answer to "is my app OK?", then what to do about it if not.
    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: status.level.systemImage)
                    .font(.system(size: 26))
                    .foregroundStyle(status.level.color)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(status.headline)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = status.detail {
                        Text(detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    freshness
                }
                Spacer(minLength: 0)
                if let url = status.liveURL {
                    Link(destination: url) {
                        Label("Open app", systemImage: "arrow.up.right")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Open \(url.absoluteString)")
                    .clickTargetCursor()
                }
            }

            if status.issues.count > 1 || status.issues.first?.chatPrompt != nil {
                Divider()
                ForEach(status.issues) { issue in
                    issueRow(issue, showsTitle: status.issues.count > 1)
                }
            } else if snapshot == nil, project.readiness == .uninitialized {
                copyPromptButton(id: "starter", prompt: ChatPrompts.starter, title: "Copy starter prompt")
            }
        }
        .padding(12)
        .companionCardSurface(cornerRadius: 12)
        .padding(.horizontal, 12)
    }

    private var freshness: some View {
        HStack(spacing: 5) {
            if isRefreshing {
                ProgressView()
                    .controlSize(.mini)
                Text("Checking now…")
            } else if let snapshot {
                Text("Checked \(snapshot.generatedAt.formatted(.relative(presentation: .named)))")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private func issueRow(_ issue: StatusIssue, showsTitle: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if showsTitle {
                Image(systemName: issue.level.systemImage)
                    .font(.caption)
                    .foregroundStyle(issue.level.color)
                Text(issue.title)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Paste this into Claude or Codex to get it fixed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if let prompt = issue.chatPrompt {
                copyPromptButton(id: issue.id, prompt: prompt, title: "Copy fix prompt")
            }
        }
    }

    private func copyPromptButton(id: String, prompt: String, title: String) -> some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(prompt, forType: .string)
            copiedPromptID = id
        } label: {
            Label(
                copiedPromptID == id ? "Copied" : title,
                systemImage: copiedPromptID == id ? "checkmark" : "doc.on.doc"
            )
        }
        .controlSize(.small)
        .help("Copies a request to paste into Claude or Codex:\n\(prompt)")
        .clickTargetCursor()
    }

    private func githubCard(_ github: GitHubInfrastructureSummary?) -> some View {
        let githubConnected = connections.contains { $0.provider == "github" && $0.status == .verified }

        return VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(isExpanded: $githubExpanded) {
                VStack(alignment: .leading, spacing: 9) {
                    if let github {
                        if let repository = github.repository {
                            Label(repository, systemImage: "shippingbox")
                                .font(.callout)
                        }
                        ForEach(github.automations) { automation in
                            HStack {
                                Image(systemName: automation.enabled ? "checkmark.circle.fill" : "pause.circle")
                                    .foregroundStyle(
                                        automation.enabled
                                            ? CompanionColor.success
                                            : Color.secondary
                                    )
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(automation.id)
                                        .font(.callout.weight(.medium))
                                    Text(automation.kind)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if let cron = automation.cron {
                                    Text("\(cron) · \(automation.timezone ?? "UTC")")
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                        .help("Five-field POSIX cron and IANA timezone")
                                }
                            }
                        }
                        if !github.dependencyFeatures.isEmpty {
                            Label(github.dependencyFeatures.joined(separator: ", "), systemImage: "arrow.triangle.2.circlepath")
                                .font(.caption)
                        }
                        if !github.securityFeatures.isEmpty {
                            Label(github.securityFeatures.joined(separator: ", "), systemImage: "lock.shield")
                                .font(.caption)
                        }
                    } else {
                        Text("No GitHub infrastructure is declared. Hypervibe still works for local state and any connected infrastructure providers.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }

                    if github != nil && !githubConnected {
                        connectionPrompt(
                            "GitHub access is not connected on this Mac. Use credentials you control, or ask chat for an owner handoff.",
                            provider: "github"
                        )
                    }
                }
                .padding(.top, 9)
            } label: {
                HStack {
                    Label("GitHub", systemImage: "point.3.connected.trianglepath.dotted")
                        .font(.headline)
                    Spacer()
                    if github != nil {
                        Text("\(github?.automations.filter(\.enabled).count ?? 0) automations")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Optional")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .clickTargetCursor()
            }
        }
        .padding(12)
        .companionCardSurface(cornerRadius: 12)
        .padding(.horizontal, 12)
    }

    private func connectionPrompt(_ message: String, provider: String) -> some View {
        HStack {
            Text(message)
                .font(.caption)
                .foregroundStyle(CompanionColor.warning)
            Spacer()
            Button("Connection Options…") { showConnections(provider: provider) }
                .controlSize(.small)
                .clickTargetCursor()
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
                        Text("No provider connections on this Mac. Add credentials you control, or use chat to prepare an owner handoff.")
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
        .companionCardSurface(cornerRadius: 12)
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
        _ environment: EnvironmentSnapshot,
        status: EnvironmentStatus,
        isOnlyEnvironment: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            DisclosureGroup(
                isExpanded: environmentExpansion(
                    environment.name,
                    // Healthy extra environments start folded so the ones
                    // that matter fit without scrolling.
                    default: isOnlyEnvironment
                        || environment.isProductionTarget
                        || status.level >= .attention
                )
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
                                    "\(observation.driftCount) \(observation.driftCount == 1 ? "change" : "changes") waiting",
                                    systemImage: "arrow.triangle.2.circlepath"
                                )
                                .foregroundStyle(CompanionColor.warning)
                                .help(driftSummary(observation))
                            }
                            if observation.unmanagedCount > 0 {
                                Label(
                                    "\(observation.unmanagedCount) unmanaged",
                                    systemImage: "questionmark.diamond"
                                )
                                .help("Found in your cloud account but not set up by Hypervibe")
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
                            if environment.isProductionTarget,
                                environment.resources.contains(where: { $0.kind == .service }) {
                                Button {
                                    showProductionDeployment(environment: environment.name)
                                } label: {
                                    Label("Deploy…", systemImage: "paperplane.fill")
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .help("Review and start a production deployment")
                                .clickTargetCursor()
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)

                        if let facts = observation.partialEvidence {
                            Label("Partly checked", systemImage: "exclamationmark.magnifyingglass")
                                .font(.caption.weight(.medium))
                            ForEach(facts, id: \.self) { fact in
                                Text(fact)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }

                        if let infrastructureStatus = observation.infrastructureStatus {
                            Label("OpenTofu", systemImage: "server.rack")
                                .font(.caption.weight(.medium))
                            Text(infrastructureStatus)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                            if let workers = observation.workers {
                                if workers.isEmpty {
                                    Text("No background workers configured.")
                                        .font(.caption).foregroundStyle(.secondary)
                                } else {
                                    Text(observation.health == .stale || observation.health == .failed ? "Last saved worker status" : "Worker status")
                                        .font(.caption.weight(.medium))
                                    ForEach(workers) { worker in
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(worker.service).font(.caption.weight(.medium))
                                            Text(worker.configurationSummary)
                                                .font(.caption).foregroundStyle(.secondary)
                                            if let activity = worker.activitySummary {
                                                Text(activity).font(.caption)
                                                    .foregroundStyle(worker.needsAttention ? CompanionColor.warning : .secondary)
                                            }
                                            if let checkedAt = worker.lastWakeAt {
                                                Text("Wake-up check \(checkedAt.formatted(.relative(presentation: .named)))")
                                                    .font(.caption).foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                }
                            } else {
                                Text("Worker status not observed on this cloud.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }

                        if let checks = environment.publicEndpointHealth,
                            !checks.isEmpty {
                            let failed = checks.filter { !$0.ok }
                            Label(
                                failed.isEmpty
                                    ? (checks.count == 1 ? "App address responded" : "\(checks.count) app addresses responded")
                                    : (failed.count == 1 ? "App address is not responding" : "\(failed.count) app addresses are not responding"),
                                systemImage: failed.isEmpty
                                    ? "heart.fill"
                                    : "heart.slash.fill"
                            )
                            .font(.caption)
                            .foregroundStyle(
                                failed.isEmpty ? CompanionColor.success : Color.red
                            )
                            .help(endpointHealthSummary(checks))
                        }

                        if !observation.blockedProviders.isEmpty {
                            Text("Needs access: \(observation.blockedProviders.joined(separator: ", "))")
                                .font(.caption)
                                .foregroundStyle(CompanionColor.warning)
                        }
                    }

                    Divider()

                    ForEach(environment.resources) { resource in
                        resourceRow(resource, observation: environment.observation)
                    }
                }
                .padding(.top, 8)
            } label: {
                environmentHeader(environment, status: status)
                    .clickTargetCursor()
            }
        }
        .padding(12)
        .companionCardSurface(cornerRadius: 12)
        .padding(.horizontal, 12)
    }

    private func environmentHeader(
        _ environment: EnvironmentSnapshot,
        status: EnvironmentStatus
    ) -> some View {
        HStack {
            Image(systemName: status.level.systemImage)
                .foregroundStyle(status.level.color)
            Text(environment.name)
                .font(.headline)
            Spacer()
            Text(status.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(status.level.color)
        }
        .help("Spec revision \(environment.specRevision)")
    }

    private func driftSummary(_ observation: ObservationSummary) -> String {
        let drifted = observation.driftedResources ?? []
        guard !drifted.isEmpty else {
            return "Ask chat to review and apply these changes."
        }
        return drifted
            .map { "\($0.name): \($0.actionType) pending on \($0.provider)" }
            .joined(separator: "\n")
    }

    private func endpointHealthSummary(_ checks: [PublicEndpointHealth]) -> String {
        checks.map { check in
            let status = check.status.map(String.init) ?? (check.ok ? "healthy" : "failed")
            let checked = check.checkedAt.formatted(.relative(presentation: .named))
            return "\(check.service): \(status) · \(check.latencyMs) ms · checked \(checked) · \(check.url.host() ?? check.url.absoluteString)"
        }.joined(separator: "\n")
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

    private func showProductionDeployment(environment: String) {
        let menuPanel = NSApplication.shared.keyWindow
        openWindow(
            id: "production-deployment",
            value: ProductionDeploymentWindowRoute(
                projectID: project.id,
                environment: environment
            )
        )
        menuPanel?.orderOut(nil)
    }

    private func environmentExpansion(
        _ environment: String,
        default defaultValue: Bool
    ) -> Binding<Bool> {
        let key = "\(project.id.uuidString):\(environment)"
        return Binding(
            get: { expandedEnvironments[key] ?? defaultValue },
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
                            .foregroundStyle(CompanionColor.warning)
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
        .companionCardSurface(cornerRadius: 12)
        .padding(.horizontal, 12)
    }

    private func recentRunsLabel(_ runs: [RecentRunSummary]) -> some View {
        HStack(spacing: 6) {
            Text("Recent activity")
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

extension StatusLevel {
    /// Shape differs per level so colour is never the only signal.
    var systemImage: String {
        switch self {
        case .good: "checkmark.circle.fill"
        case .unknown: "circle.dashed"
        case .attention: "exclamationmark.triangle.fill"
        case .down: "xmark.octagon.fill"
        }
    }

    var color: Color {
        switch self {
        case .good: CompanionColor.success
        case .unknown: .secondary
        case .attention: CompanionColor.warning
        case .down: .red
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
        case .succeeded: CompanionColor.success
        case .running: .blue
        case .pending: CompanionColor.warning
        case .failed, .blocked: .red
        case .cancelled, .unknown: .secondary
        }
    }
}
