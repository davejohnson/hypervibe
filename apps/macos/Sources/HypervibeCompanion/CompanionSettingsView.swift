import HypervibeCompanionCore
import ServiceManagement
import SwiftUI

struct CompanionSettingsView: View {
    @ObservedObject var model: CompanionAppModel
    @ObservedObject var loginItemController: CompanionLoginItemController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            companionUpdates

            Divider()

            launchAtLogin

            Divider()

            mcpClients

            Divider()

            HStack {
                Text("Projects")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button {
                    openWindow(id: "project-setup", value: "add-project")
                } label: {
                    Label("Add Project", systemImage: "plus")
                }
                .clickTargetCursor()
            }

            if model.projects.isEmpty {
                ContentUnavailableView(
                    "No projects configured",
                    systemImage: "shippingbox"
                )
            } else {
                List {
                    ForEach(model.projects) { project in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(project.displayName)
                                    .font(.headline)
                                Spacer()
                                Button(role: .destructive) {
                                    Task {
                                        await model.removeProject(id: project.id)
                                    }
                                } label: {
                                    Image(systemName: "trash")
                                }
                                .buttonStyle(.borderless)
                                .clickTargetCursor()
                            }
                            Text(project.repositoryPath)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Text(project.hypervibeExecutablePath)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                        .padding(.vertical, 5)
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 620, height: 750)
        .background(WindowFocusBridge())
        .task {
            await model.loadIfNeeded()
            await model.refreshMCPHostStatuses()
            await model.checkForCompanionUpdate()
            loginItemController.refresh()
        }
    }

    private var launchAtLogin: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.crop.circle.badge.clock")
                .frame(width: 24)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 3) {
                Text("Launch at login")
                    .font(.headline)
                Text(loginItemStatusText)
                    .font(.caption)
                    .foregroundStyle(
                        loginItemController.errorMessage == nil
                            ? AnyShapeStyle(.secondary)
                            : AnyShapeStyle(.red)
                    )
                    .lineLimit(2)

                if loginItemController.status == .requiresApproval {
                    Button("Open Login Items") {
                        SMAppService.openSystemSettingsLoginItems()
                    }
                    .buttonStyle(.link)
                    .clickTargetCursor()
                }
            }

            Spacer()

            Toggle("", isOn: Binding(
                get: { loginItemController.isEnabled },
                set: { loginItemController.setEnabled($0) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .disabled(loginItemController.status == .unavailable)
        }
    }

    private var loginItemStatusText: String {
        if let errorMessage = loginItemController.errorMessage {
            return errorMessage
        }

        switch loginItemController.status {
        case .enabled:
            return "Hypervibe opens automatically after you sign in to this Mac."
        case .disabled:
            return "Hypervibe opens only when you launch it."
        case .requiresApproval:
            return "Allow Hypervibe in System Settings → General → Login Items."
        case .unavailable:
            return "Move Hypervibe to Applications and reopen it to enable this setting."
        }
    }

    private var companionUpdates: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Hypervibe Companion")
                        .font(.title2.weight(.semibold))
                    Text(updateStatusText)
                        .font(.caption)
                        .foregroundStyle(updateStatusIsError ? .red : .secondary)
                        .lineLimit(2)
                }

                Spacer()

                if model.companionUpdateState.isBusy {
                    ProgressView()
                        .controlSize(.small)
                }

                if updateActionIsPrimary {
                    updateActionButton
                        .buttonStyle(.borderedProminent)
                } else {
                    updateActionButton
                        .buttonStyle(.bordered)
                }
            }

            if case .available(let release) = model.companionUpdateState {
                Link("View Hypervibe \(release.version) on GitHub", destination: release.releasePageURL)
                    .font(.caption)
            }
        }
    }

    private var updateStatusText: String {
        let installed = CompanionDistribution.currentVersion ?? "development"
        switch model.companionUpdateState {
        case .idle:
            return "Version \(installed). Checking GitHub for updates…"
        case .checking:
            return "Version \(installed). Checking the latest GitHub release…"
        case .upToDate(let version):
            return "Version \(version) is up to date."
        case .available(let release):
            return "Version \(release.version) is available on GitHub; version \(installed) is installed."
        case .installing(let version):
            return "Downloading and verifying version \(version)… Hypervibe will restart when it is ready."
        case .failed(let message):
            return message
        }
    }

    private var updateStatusIsError: Bool {
        if case .failed = model.companionUpdateState {
            return true
        }
        return false
    }

    private var updateActionTitle: String {
        switch model.companionUpdateState {
        case .available:
            "Restart and Update"
        case .checking:
            "Checking…"
        case .installing:
            "Updating…"
        case .failed:
            "Try Again"
        case .idle:
            "Check for Updates"
        case .upToDate:
            "Check Again"
        }
    }

    private var updateActionIsPrimary: Bool {
        if case .available = model.companionUpdateState {
            return true
        }
        return false
    }

    private var updateActionButton: some View {
        Button(updateActionTitle) {
            Task {
                if case .available = model.companionUpdateState {
                    await model.restartAndUpdateCompanion()
                } else {
                    await model.checkForCompanionUpdate(force: true)
                }
            }
        }
        .clickTargetCursor()
        .disabled(model.companionUpdateState.isBusy)
    }

    private var mcpClients: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Coding agents")
                    .font(.title2.weight(.semibold))
                Text("Connect every project below to a desktop MCP client using Hypervibe’s bundled runtime.")
                    .foregroundStyle(.secondary)
            }

            ForEach(MCPHost.allCases, id: \.self) { host in
                HStack(spacing: 12) {
                    Image(systemName: host == .claudeDesktop
                        ? "bubble.left.and.text.bubble.right"
                        : "terminal")
                        .frame(width: 24)
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(host.displayName)
                            .font(.headline)
                        Text(hostStatusText(host))
                            .font(.caption)
                            .foregroundStyle(
                                model.mcpHostErrors[host] == nil
                                    ? AnyShapeStyle(.secondary)
                                    : AnyShapeStyle(.red)
                            )
                            .lineLimit(2)
                    }

                    Spacer()

                    if model.updatingMCPHosts.contains(host) {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Button(hostActionTitle(host)) {
                        Task {
                            await model.toggleMCPHost(host)
                        }
                    }
                    .clickTargetCursor()
                    .disabled(
                        model.projects.isEmpty
                            || !CompanionDistribution.isReadyForOnboarding
                            || model.updatingMCPHosts.contains(host)
                    )
                }
                .padding(10)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 9))
            }

            Text("After connecting, fully restart the desktop client. Hypervibe keeps a one-time backup beside each configuration file.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func hostStatusText(_ host: MCPHost) -> String {
        if !CompanionDistribution.isReadyForOnboarding {
            return CompanionDistribution.onboardingGuidance
        }
        if let error = model.mcpHostErrors[host] {
            return error
        }
        guard let status = model.mcpHostStatuses[host] else {
            return "Checking configuration…"
        }
        if status.projectCount == 0 {
            return "Add a project to enable setup."
        }
        if status.isFullyConnected {
            return "Connected to \(status.connectedProjectCount) project\(status.connectedProjectCount == 1 ? "" : "s"). Restart required after changes."
        }
        if status.connectedProjectCount > 0 {
            return "\(status.connectedProjectCount) of \(status.projectCount) projects connected."
        }
        return "Not connected."
    }

    private func hostActionTitle(_ host: MCPHost) -> String {
        guard let status = model.mcpHostStatuses[host] else {
            return "Connect"
        }
        if status.isFullyConnected {
            return "Disconnect"
        }
        if status.connectedProjectCount > 0 {
            return "Update"
        }
        return "Connect"
    }
}
