import HypervibeCompanionCore
import SwiftUI

struct CompanionSettingsView: View {
    @ObservedObject var model: CompanionAppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Projects")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button {
                    openWindow(id: "project-setup", value: "add-project")
                } label: {
                    Label("Add Project", systemImage: "plus")
                }
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
        .frame(width: 560, height: 380)
        .task {
            await model.loadIfNeeded()
        }
    }
}
