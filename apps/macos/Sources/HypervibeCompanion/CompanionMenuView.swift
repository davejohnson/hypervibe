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
                        status: model.status(for: project),
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
            await model.checkForCompanionUpdate()
        }
        .onAppear {
            Task { await model.refreshSelectedProjectIfStale() }
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
                        Label(
                            project.displayName,
                            systemImage: model.status(for: project).level.systemImage
                        )
                        .tag(Optional(project.id))
                    }
                }
                .labelsHidden()
                .labelStyle(.titleAndIcon)
                .frame(maxWidth: 250)
                .clickTargetCursor()
            }

            Spacer()

            if model.projects.count > 1 {
                let troubled = model.projects.filter {
                    model.status(for: $0).level >= .attention
                }.count
                Text(troubled == 0
                    ? "All \(model.projects.count) projects OK"
                    : "\(troubled) of \(model.projects.count) need attention")
                    .font(.caption)
                    .foregroundStyle(troubled == 0 ? Color.secondary : CompanionColor.warning)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No projects yet", systemImage: "shippingbox")
        } description: {
            Text("Add your project folder and Hypervibe will keep an eye on it from here.")
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

            if case .available(let release) = model.companionUpdateState {
                SettingsLink {
                    Label("Update \(release.version)", systemImage: "arrow.down.circle.fill")
                }
                .help("Restart and update Hypervibe")
                .clickTargetCursor()
            } else {
                SettingsLink {
                    Image(systemName: "gearshape")
                }
                .help("Settings")
                .clickTargetCursor()
            }

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
