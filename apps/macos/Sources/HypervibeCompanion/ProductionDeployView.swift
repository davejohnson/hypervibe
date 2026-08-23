import HypervibeCompanionCore
import SwiftUI

struct ProductionDeployView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: CompanionAppModel

    let project: CompanionProject
    let environment: EnvironmentSnapshot

    @State private var preparation: ProductionDeploymentPreparation?
    @State private var selectedDefinitionID: String?
    @State private var commitSHA = ""
    @State private var loading = true
    @State private var deploying = false
    @State private var errorMessage: String?
    @State private var result: ProductionDeploymentResult?
    @State private var showingConfirmation = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(minWidth: 540, idealWidth: 580, minHeight: 400, idealHeight: 460)
        .background(WindowFocusBridge())
        .task { await loadPreparation() }
        .alert(
            "Deploy \(project.displayName) to \(environment.name)?",
            isPresented: $showingConfirmation
        ) {
            Button("Cancel", role: .cancel) {}
            Button("Deploy", role: .destructive) {
                Task { await deploy() }
            }
        } message: {
            Text(confirmationMessage)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "paperplane.fill")
                .font(.title2)
                .foregroundStyle(.secondary)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text("Deploy to Production")
                    .font(.title3.weight(.semibold))
                Text("\(project.displayName) · \(environment.name)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if loading || deploying {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(16)
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            VStack(spacing: 10) {
                ProgressView()
                Text("Reading the reviewed deployment contract…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let result {
            resultView(result)
        } else if preparation == nil {
            ContentUnavailableView {
                Label("Deployment unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage ?? "Hypervibe could not read the production deployment contract.")
            } actions: {
                Button("Retry") { Task { await loadPreparation() } }
                    .clickTargetCursor()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    deploymentForm
                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
                .padding(18)
            }
        }
    }

    @ViewBuilder
    private var deploymentForm: some View {
        if let preparation {
            switch preparation.mechanism {
            case .direct:
                Label(
                    "Hypervibe will create and immediately apply a plan from the repo-backed production spec.",
                    systemImage: "checklist"
                )
                .font(.callout)

                Text("The protected-environment confirmation is passed only after you approve the final dialog. Billable or destructive plan actions still retain their separate action-id confirmation boundary.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

            case .managedCI:
                VStack(alignment: .leading, spacing: 6) {
                    Text("Reviewed CI definition")
                        .font(.caption.weight(.medium))
                    Picker("Reviewed CI definition", selection: $selectedDefinitionID) {
                        Text("Choose a definition…").tag(Optional<String>.none)
                        ForEach(preparation.eligibleDefinitions) { definition in
                            Text(definition.displayName)
                                .tag(Optional(definition.id))
                        }
                    }
                    .labelsHidden()
                    .clickTargetCursor()
                    if preparation.eligibleDefinitions.isEmpty {
                        Text("No CI definitions were returned. Run hv_plan/hv_apply to converge the reviewed production workflow first.")
                            .font(.caption)
                            .foregroundStyle(CompanionColor.warning)
                    }
                }

                detailRow(label: "Source ref", value: preparation.branch)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Verified commit SHA")
                        .font(.caption.weight(.medium))
                    TextField("Full 40-character commit SHA", text: $commitSHA)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                    Text(
                        preparation.requiresExactRefSHA
                            ? "Hypervibe will verify that the reviewed ref points to this exact commit before dispatch."
                            : "Use the exact commit that already passed staging; the reviewed workflow receives it as commit_sha."
                    )
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func resultView(_ result: ProductionDeploymentResult) -> some View {
        let succeeded = ["success", "succeeded"].contains(result.status.lowercased())
        return VStack(alignment: .leading, spacing: 14) {
            Label(
                succeeded ? "Production deployment succeeded" : "Production deployment started",
                systemImage: succeeded ? "checkmark.circle.fill" : "clock.fill"
            )
            .font(.title3.weight(.semibold))
            .foregroundStyle(succeeded ? CompanionColor.success : CompanionColor.warning)

            Text(result.message)
                .fixedSize(horizontal: false, vertical: true)

            if let runID = result.runID {
                detailRow(label: "Run", value: runID)
            }
            if let planID = result.planID {
                detailRow(label: "Plan", value: planID)
            }
            if let applyRunID = result.applyRunID {
                detailRow(label: "Apply", value: applyRunID)
            }
            if let webURL = result.webURL {
                Link("Open deployment", destination: webURL)
                    .clickTargetCursor()
            }

            Text("Refresh Hypervibe to observe the final run and production health before treating the deployment as converged.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func detailRow(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(1)
        }
        .font(.callout)
    }

    private var footer: some View {
        HStack {
            Button(result == nil ? "Cancel" : "Close") { dismiss() }
                .clickTargetCursor()
            Spacer()
            if result == nil, preparation != nil {
                Button("Review Production Deploy…") {
                    errorMessage = nil
                    showingConfirmation = true
                }
                .buttonStyle(.borderedProminent)
                .clickTargetCursor()
                .disabled(!canReview || deploying)
            }
        }
        .padding(14)
    }

    private var canReview: Bool {
        guard let preparation else { return false }
        switch preparation.mechanism {
        case .direct:
            return true
        case .managedCI:
            return selectedDefinitionID != nil
                && commitSHA.range(
                    of: "^[0-9a-fA-F]{40}$",
                    options: .regularExpression
                ) != nil
        }
    }

    private var confirmationMessage: String {
        guard let preparation else {
            return "The deployment contract is unavailable."
        }
        switch preparation.mechanism {
        case .direct:
            return "This starts a plan-gated production deployment and may mutate live production resources."
        case .managedCI:
            let definition = preparation.eligibleDefinitions.first {
                $0.id == selectedDefinitionID
            }?.name ?? "the selected definition"
            return "Dispatch \(definition) from \(preparation.branch) for commit \(commitSHA)?"
        }
    }

    private func loadPreparation() async {
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            let loaded = try await model.prepareProductionDeployment(
                projectID: project.id,
                environmentName: environment.name
            )
            preparation = loaded
            selectedDefinitionID = loaded.suggestedDefinitionID()
        } catch {
            preparation = nil
            errorMessage = userFacingMessage(for: error)
        }
    }

    private func deploy() async {
        guard let preparation, !deploying else { return }
        deploying = true
        errorMessage = nil
        defer { deploying = false }
        do {
            result = try await model.deployProduction(
                projectID: project.id,
                environmentName: environment.name,
                preparation: preparation,
                definitionID: selectedDefinitionID,
                commitSHA: commitSHA
            )
        } catch {
            errorMessage = userFacingMessage(for: error)
        }
    }

    private func userFacingMessage(for error: Error) -> String {
        if let localized = error as? LocalizedError,
            let description = localized.errorDescription,
            !description.isEmpty {
            return description
        }
        return "Hypervibe could not start the production deployment."
    }
}
