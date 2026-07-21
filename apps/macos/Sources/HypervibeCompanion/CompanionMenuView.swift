import AppKit
import HypervibeCompanionCore
import SwiftUI

struct CompanionMenuView: View {
    @ObservedObject var model: CompanionAppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            Group {
                if let loadError = model.loadError {
                    ContentUnavailableView(
                        "Companion data unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text(loadError)
                    )
                } else if model.projects.isEmpty {
                    emptyState
                } else if let project = model.selectedProject {
                    ProjectDashboardView(
                        project: project,
                        snapshot: model.selectedSnapshot,
                        connections: model.selectedConnections,
                        refreshError: model.refreshErrors[project.id],
                        isRefreshing: model.refreshingProjectIDs.contains(project.id)
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()
            footer
        }
        .frame(width: 460, height: 590)
        .task {
            await model.loadIfNeeded()
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            RocketIcon()
                .frame(width: 20, height: 20)
                .foregroundStyle(.secondary)

            if model.projects.isEmpty {
                Text("Hypervibe")
                    .font(.headline)
            } else {
                Picker("Project", selection: $model.selectedProjectID) {
                    ForEach(model.projects) { project in
                        Text(project.displayName)
                            .tag(Optional(project.id))
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 250)
                .clickTargetCursor()
            }

            Spacer()

            if let snapshot = model.selectedSnapshot {
                Text(snapshot.generatedAt, style: .relative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help("Last successful companion snapshot")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No projects yet", systemImage: "shippingbox")
        } description: {
            Text("Add a repository and the local Hypervibe command that should observe it.")
        } actions: {
            Button("Add Project…") {
                showProjectSetup()
            }
            .buttonStyle(.borderedProminent)
            .clickTargetCursor()
        }
    }

    private var footer: some View {
        HStack {
            Button {
                Task {
                    await model.refreshSelectedProject()
                }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .clickTargetCursor()
            .disabled(
                model.selectedProject == nil
                    || model.selectedProject.map {
                        model.refreshingProjectIDs.contains($0.id)
                    } == true
            )

            Button {
                showProjectSetup()
            } label: {
                Label("Add", systemImage: "plus")
            }
            .clickTargetCursor()

            Spacer()

            SettingsLink {
                Image(systemName: "gearshape")
            }
            .help("Settings")
            .clickTargetCursor()

            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .help("Quit Hypervibe")
            .clickTargetCursor()
        }
        .labelStyle(.titleAndIcon)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private func showProjectSetup() {
        let menuPanel = NSApplication.shared.keyWindow
        openWindow(id: "project-setup", value: "add-project")
        menuPanel?.orderOut(nil)
    }
}
