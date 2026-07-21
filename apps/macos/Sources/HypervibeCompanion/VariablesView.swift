import AppKit
import HypervibeCompanionCore
import SwiftUI

struct VariablesView: View {
    @ObservedObject var model: CompanionAppModel
    let project: CompanionProject
    let snapshot: ProjectSnapshot

    @State private var selectedEnvironment: String
    @State private var selectedService: String
    @State private var variables: [HostingVariableSummary] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var notice: String?
    @State private var showingAdd = false

    init(
        model: CompanionAppModel,
        project: CompanionProject,
        snapshot: ProjectSnapshot,
        initialEnvironment: String,
        initialService: String?
    ) {
        self.model = model
        self.project = project
        self.snapshot = snapshot
        let environment = snapshot.environments.first {
            $0.name == initialEnvironment
        } ?? snapshot.environments.first
        let services = environment?.resources.filter { $0.kind == .service } ?? []
        let service = initialService.flatMap { requested in
            services.first { $0.name == requested }?.name
        } ?? services.first?.name ?? ""
        _selectedEnvironment = State(initialValue: environment?.name ?? "")
        _selectedService = State(initialValue: service)
    }

    private var environments: [EnvironmentSnapshot] {
        snapshot.environments.filter { environment in
            environment.resources.contains { $0.kind == .service }
        }
    }

    private var selectedEnvironmentSnapshot: EnvironmentSnapshot? {
        environments.first { $0.name == selectedEnvironment }
    }

    private var services: [ResourceSummary] {
        selectedEnvironmentSnapshot?.resources.filter { $0.kind == .service } ?? []
    }

    private var selectedProvider: String? {
        services.first { $0.name == selectedService }?.desiredProvider
    }

    private var selectionKey: String {
        "\(selectedEnvironment)|\(selectedService)"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            selectors
            Divider()
            content
            Divider()
            footer
        }
        .frame(minWidth: 620, idealWidth: 680, minHeight: 440, idealHeight: 520)
        .background(WindowFocusBridge())
        .task(id: selectionKey) {
            await loadVariables()
        }
        .onChange(of: selectedEnvironment) { _, _ in
            selectedService = services.first?.name ?? ""
        }
        .onChange(of: selectedService) { _, _ in
            variables = []
            loadError = nil
            notice = nil
        }
        .sheet(isPresented: $showingAdd) {
            AddHostingVariableView(
                environment: selectedEnvironment,
                service: selectedService,
                existingNames: Set(variables.map(\.name))
            ) { request in
                let result = try await model.setHostingVariable(
                    projectID: project.id,
                    request: request
                )
                notice = "\(result.variables.joined(separator: ", ")) updated on \(result.service)."
                await loadVariables()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "key.horizontal.fill")
                .font(.title2)
                .foregroundStyle(.secondary)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text("Variables & Secrets")
                    .font(.title3.weight(.semibold))
                Text(project.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if loading {
                ProgressView()
                    .controlSize(.small)
            }
            Button {
                Task { await loadVariables() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh variables")
            .disabled(loading || selectedService.isEmpty)
        }
        .padding(16)
    }

    private var selectors: some View {
        HStack(spacing: 14) {
            Picker("Environment", selection: $selectedEnvironment) {
                ForEach(environments) { environment in
                    Text(environment.name).tag(environment.name)
                }
            }
            .frame(maxWidth: .infinity)

            Picker("Service", selection: $selectedService) {
                ForEach(services) { service in
                    Text(service.name).tag(service.name)
                }
            }
            .frame(maxWidth: .infinity)

            if let selectedProvider {
                ProviderLogo(provider: selectedProvider, size: 26)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var content: some View {
        if environments.isEmpty {
            ContentUnavailableView(
                "No deployable services",
                systemImage: "shippingbox",
                description: Text("Add a service to this project's Hypervibe spec first.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError, variables.isEmpty {
            ContentUnavailableView {
                Label("Variables unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(loadError)
            } actions: {
                Button("Retry") {
                    Task { await loadVariables() }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                if let loadError {
                    Label(loadError, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                }
                if let notice {
                    Label(notice, systemImage: "checkmark.circle.fill")
                        .font(.callout)
                        .foregroundStyle(.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                }

                if variables.isEmpty, !loading {
                    ContentUnavailableView {
                        Label("No runtime variables", systemImage: "key.horizontal")
                    } description: {
                        Text("Add a value directly, use a local reference, or generate a secret.")
                    } actions: {
                        Button("Add Variable…") { showingAdd = true }
                            .buttonStyle(.borderedProminent)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(variables) { variable in
                        HStack(spacing: 12) {
                            Image(systemName: "key")
                                .foregroundStyle(.secondary)
                                .frame(width: 18)
                            Text(variable.name)
                                .font(.body.monospaced())
                                .textSelection(.enabled)
                            Spacer()
                            Text(variable.maskedValue)
                                .font(.callout.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, 5)
                    }
                    .listStyle(.inset)
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text("Values are masked and kept out of the companion cache. Database, queue, and storage wiring is managed automatically by Hypervibe.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button {
                showingAdd = true
            } label: {
                Label("Add Variable", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .disabled(selectedService.isEmpty || loading)
        }
        .padding(14)
    }

    private func loadVariables() async {
        guard !selectedEnvironment.isEmpty, !selectedService.isEmpty else {
            variables = []
            loading = false
            loadError = nil
            return
        }
        let requestedEnvironment = selectedEnvironment
        let requestedService = selectedService
        let requestedSelection = selectionKey
        loading = true
        loadError = nil
        defer {
            if selectionKey == requestedSelection {
                loading = false
            }
        }
        do {
            let catalog = try await model.hostingVariables(
                projectID: project.id,
                environment: requestedEnvironment,
                service: requestedService
            )
            guard selectionKey == requestedSelection else { return }
            variables = catalog.variables
        } catch {
            guard selectionKey == requestedSelection else { return }
            loadError = userFacingMessage(for: error)
        }
    }

    private func userFacingMessage(for error: Error) -> String {
        if let localized = error as? LocalizedError,
            let description = localized.errorDescription {
            return description
        }
        return "Hypervibe could not read these variables."
    }
}

private struct AddHostingVariableView: View {
    enum SourceMode: String, CaseIterable, Identifiable {
        case direct = "Enter value"
        case reference = "Use reference"
        case generated = "Generate"

        var id: String { rawValue }
    }

    @Environment(\.dismiss) private var dismiss

    let environment: String
    let service: String
    let existingNames: Set<String>
    let onSubmit: (HostingVariableRequest) async throws -> Void

    @State private var key = ""
    @State private var mode: SourceMode = .direct
    @State private var directValue = ""
    @State private var reference = ""
    @State private var generatedLength = 48
    @State private var submitting = false
    @State private var errorMessage: String?

    private var normalizedKey: String {
        key.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var validKey: Bool {
        normalizedKey.range(
            of: #"^[A-Za-z_][A-Za-z0-9_]*$"#,
            options: .regularExpression
        ) != nil
    }

    private var canSubmit: Bool {
        guard validKey else { return false }
        switch mode {
        case .direct:
            return !directValue.isEmpty
        case .reference:
            return !reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .generated:
            return true
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Add Runtime Variable")
                        .font(.title3.weight(.semibold))
                    Text("\(environment) · \(service)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text("Variable name")
                        .font(.caption.weight(.medium))
                    TextField("SENDGRID_API_KEY", text: $key)
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospaced())
                    if !normalizedKey.isEmpty, !validKey {
                        Text("Use letters, numbers, and underscores; the first character cannot be a number.")
                            .font(.caption2)
                            .foregroundStyle(.red)
                    } else if existingNames.contains(normalizedKey) {
                        Text("This replaces the existing value for \(normalizedKey).")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }

                Picker("Value source", selection: $mode) {
                    ForEach(SourceMode.allCases) { source in
                        Text(source.rawValue).tag(source)
                    }
                }
                .pickerStyle(.segmented)

                sourceFields

                Label(
                    "The value is sent once through the local MCP session. It is never logged, displayed, or stored by the companion.",
                    systemImage: "lock.shield"
                )
                .font(.caption)
                .foregroundStyle(.secondary)

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

            Spacer(minLength: 0)
            Divider()
            HStack {
                Button("Cancel") {
                    clearSecretState()
                    dismiss()
                }
                Spacer()
                if submitting {
                    ProgressView()
                        .controlSize(.small)
                }
                Button(existingNames.contains(normalizedKey) ? "Replace Variable" : "Add Variable") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit || submitting)
            }
            .padding(14)
        }
        .frame(width: 540, height: 430)
        .onDisappear(perform: clearSecretState)
    }

    @ViewBuilder
    private var sourceFields: some View {
        switch mode {
        case .direct:
            VStack(alignment: .leading, spacing: 5) {
                Text("Value")
                    .font(.caption.weight(.medium))
                SecureField("Paste the value", text: $directValue)
                    .textFieldStyle(.roundedBorder)
                Text("Best for a value you already have on this Mac.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        case .reference:
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Local or secret-manager reference")
                        .font(.caption.weight(.medium))
                    Spacer()
                    Button("Choose File…") { chooseReferenceFile() }
                }
                TextField(
                    "env:NAME, dotenv:/path/.env#KEY, file:/path, or 1password://…",
                    text: $reference
                )
                .textFieldStyle(.roundedBorder)
                Text("Hypervibe resolves the reference locally; the value never enters this form.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        case .generated:
            VStack(alignment: .leading, spacing: 8) {
                Stepper(
                    "Generate a \(generatedLength)-character secret",
                    value: $generatedLength,
                    in: 16...128,
                    step: 8
                )
                Text("Hypervibe creates the value server-side and never returns it to the app.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func submit() async {
        guard !submitting, canSubmit else { return }
        submitting = true
        errorMessage = nil
        defer { submitting = false }

        let source: HostingVariableSource
        switch mode {
        case .direct:
            source = .direct(directValue)
        case .reference:
            source = .reference(reference)
        case .generated:
            source = .generated(length: generatedLength)
        }

        do {
            try await onSubmit(
                HostingVariableRequest(
                    environment: environment,
                    service: service,
                    key: normalizedKey,
                    source: source
                )
            )
            clearSecretState()
            dismiss()
        } catch {
            if let localized = error as? LocalizedError,
                let description = localized.errorDescription {
                errorMessage = description
            } else {
                errorMessage = "Hypervibe could not set this variable."
            }
        }
    }

    private func chooseReferenceFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        reference = "file:\(url.path)"
    }

    private func clearSecretState() {
        directValue = ""
        reference = ""
    }
}
