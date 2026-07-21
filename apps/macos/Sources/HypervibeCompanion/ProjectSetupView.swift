import AppKit
import Foundation
import SwiftUI

struct ProjectDraft {
    var displayName: String
    var repositoryPath: String
    var executablePath: String
    var argumentsText: String
    var dataDirectory: String

    var arguments: [String]? {
        let values = argumentsText
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return values.isEmpty ? nil : values
    }

    static func suggested() -> ProjectDraft {
        let fileManager = FileManager.default
        let repository = URL(fileURLWithPath: fileManager.currentDirectoryPath)
            .standardizedFileURL
        if CompanionDistribution.includesBundledServer {
            return ProjectDraft(
                displayName: repository.lastPathComponent,
                repositoryPath: repository.path,
                executablePath: CompanionDistribution.launcherURL.path,
                argumentsText: "",
                dataDirectory: ""
            )
        }

        let localServer = repository.appendingPathComponent("dist/index.js")
        let node = executable(named: "node")
        let installedHypervibe = executable(named: "hypervibe")

        if fileManager.fileExists(atPath: localServer.path), let node {
            return ProjectDraft(
                displayName: repository.lastPathComponent,
                repositoryPath: repository.path,
                executablePath: node,
                argumentsText: localServer.path,
                dataDirectory: ""
            )
        }

        return ProjectDraft(
            displayName: repository.lastPathComponent,
            repositoryPath: repository.path,
            executablePath: installedHypervibe ?? "",
            argumentsText: "",
            dataDirectory: ""
        )
    }

    private static func executable(named name: String) -> String? {
        for directory in ProcessInfo.processInfo.environment["PATH"]?
            .split(separator: ":")
            .map(String.init) ?? [] {
            let candidate = URL(fileURLWithPath: directory)
                .appendingPathComponent(name)
                .path
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }
}

struct ProjectSetupView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ProjectDraft.suggested()
    @State private var isSaving = false
    @State private var errorMessage: String?

    let onSave: (ProjectDraft) async throws -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Add a Hypervibe project")
                        .font(.title2.weight(.semibold))
                    Text("The repository and command are stored only on this Mac.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 13) {
                GridRow(alignment: .firstTextBaseline) {
                    fieldLabel("Name")
                    TextField("Project name", text: $draft.displayName)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 450)
                }

                GridRow(alignment: .firstTextBaseline) {
                    fieldLabel("Repository")
                    pathField(text: $draft.repositoryPath) {
                        chooseDirectory { draft.repositoryPath = $0 }
                    }
                }

                if CompanionDistribution.includesBundledServer {
                    GridRow(alignment: .firstTextBaseline) {
                        fieldLabel("Runtime")
                        Label(
                            "Included with Hypervibe",
                            systemImage: "checkmark.seal.fill"
                        )
                        .foregroundStyle(.secondary)
                    }
                } else {
                    GridRow(alignment: .firstTextBaseline) {
                        fieldLabel("Executable")
                        pathField(text: $draft.executablePath) {
                            chooseFile { draft.executablePath = $0 }
                        }
                    }

                    GridRow(alignment: .top) {
                        fieldLabel("Arguments")
                            .padding(.top, 5)
                        TextEditor(text: $draft.argumentsText)
                            .font(.system(.body, design: .monospaced))
                            .scrollContentBackground(.hidden)
                            .padding(5)
                            .frame(width: 450, height: 72)
                            .background(.background, in: RoundedRectangle(cornerRadius: 6))
                            .overlay {
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(.separator)
                            }
                    }
                }

                GridRow(alignment: .firstTextBaseline) {
                    fieldLabel("Data directory")
                    pathField(text: $draft.dataDirectory) {
                        chooseDirectory { draft.dataDirectory = $0 }
                    }
                }
            }

            Text(setupHelp)
                .font(.caption)
                .foregroundStyle(
                    CompanionDistribution.includesBundledServer
                        && !CompanionDistribution.hasStableInstallationPath
                        ? AnyShapeStyle(.red)
                        : AnyShapeStyle(.secondary)
                )

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)

                Spacer()

                if isSaving {
                    ProgressView()
                        .controlSize(.small)
                }
                Button("Add and Refresh") {
                    save()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    isSaving
                        || draft.displayName.trimmingCharacters(
                            in: .whitespacesAndNewlines
                        ).isEmpty
                        || draft.repositoryPath.isEmpty
                        || draft.executablePath.isEmpty
                        || (CompanionDistribution.includesBundledServer
                            && !CompanionDistribution.hasStableInstallationPath)
                )
            }
        }
        .padding(22)
        .frame(width: 650)
        .background(WindowFocusBridge())
    }

    private var setupHelp: String {
        if CompanionDistribution.includesBundledServer {
            if !CompanionDistribution.hasStableInstallationPath {
                return CompanionDistribution.installationGuidance
            }
            return "Hypervibe includes its own runtime. Leave the data directory blank to use Hypervibe’s default local data directory."
        }
        return "Enter one process argument per line. Leave the data directory blank to use Hypervibe’s default local data directory."
    }

    private func pathField(
        text: Binding<String>,
        browse: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 6) {
            TextField("", text: text)
                .textFieldStyle(.roundedBorder)
            Button("Browse…", action: browse)
        }
        .frame(width: 450)
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title)
            .foregroundStyle(.secondary)
            .frame(width: 105, alignment: .trailing)
    }

    private func chooseDirectory(assign: (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            assign(url.path)
        }
    }

    private func chooseFile(assign: (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            assign(url.path)
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await onSave(draft)
                dismiss()
            } catch {
                errorMessage = (error as? LocalizedError)?.errorDescription
                    ?? "Could not add this project."
            }
            isSaving = false
        }
    }

}
