import HypervibeCompanionCore
import SwiftUI

struct CompanionSettingsView: View {
    @ObservedObject var model: CompanionAppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
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
        .frame(width: 620, height: 570)
        .background(WindowFocusBridge())
        .task {
            await model.loadIfNeeded()
            await model.refreshMCPHostStatuses()
        }
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
        if CompanionDistribution.includesBundledServer,
            !CompanionDistribution.hasStableInstallationPath {
            return CompanionDistribution.installationGuidance
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
