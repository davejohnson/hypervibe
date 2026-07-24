import AppKit
import HypervibeCompanionCore
import SwiftUI

struct VariablesView: View {
    @ObservedObject var model: CompanionAppModel
    let project: CompanionProject
    let snapshot: ProjectSnapshot

    @State private var selectedEnvironment: String
    @State private var selectedService: String
    @State private var inventory = HostingVariableInventory()
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

    private var targets: [HostingVariableTarget] {
        environments.flatMap { environment in
            environment.resources
                .filter { $0.kind == .service }
                .map {
                    HostingVariableTarget(environment: environment.name, service: $0.name)
                }
        }
    }

    private var currentTarget: HostingVariableTarget? {
        guard !selectedEnvironment.isEmpty, !selectedService.isEmpty else { return nil }
        return HostingVariableTarget(
            environment: selectedEnvironment,
            service: selectedService
        )
    }

    private var inventoryKey: String {
        targets.map(\.id).joined(separator: "|")
    }

    private var providersByTarget: [HostingVariableTarget: String] {
        Dictionary(uniqueKeysWithValues: environments.flatMap { environment in
            environment.resources.compactMap { resource in
                guard resource.kind == .service else { return nil }
                return (
                    HostingVariableTarget(
                        environment: environment.name,
                        service: resource.name
                    ),
                    resource.desiredProvider
                )
            }
        })
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
        .task(id: inventoryKey) {
            await loadVariables()
        }
        .onChange(of: selectedEnvironment) { _, _ in
            selectedService = services.first?.name ?? ""
        }
        .onChange(of: selectedService) { _, _ in
            notice = nil
        }
        .sheet(isPresented: $showingAdd) {
            if let currentTarget {
                AddHostingVariableView(
                    initialTarget: currentTarget,
                    targets: targets,
                    providersByTarget: providersByTarget,
                    inventory: inventory
                ) { request in
                    let result = try await model.setHostingVariable(
                        projectID: project.id,
                        request: request
                    )
                    let destinationCount = result.destinations.count
                    notice = "\(result.variables.joined(separator: ", ")) updated on \(destinationCount) \(destinationCount == 1 ? "target" : "targets")."
                    Task { await loadVariables() }
                }
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
            .clickTargetCursor()
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
            .clickTargetCursor()

            Picker("Service", selection: $selectedService) {
                ForEach(services) { service in
                    Text(service.name).tag(service.name)
                }
            }
            .frame(maxWidth: .infinity)
            .clickTargetCursor()

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
        } else if let loadError, inventory.keys.isEmpty {
            ContentUnavailableView {
                Label("Variables unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(loadError)
            } actions: {
                Button("Retry") {
                    Task { await loadVariables() }
                }
                .clickTargetCursor()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                if !inventory.failures.isEmpty {
                    Label(
                        "Couldn’t read \(inventory.failures.count) \(inventory.failures.count == 1 ? "target" : "targets")",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .help(failureSummary)
                }
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

                if inventory.keys.isEmpty, !loading {
                    ContentUnavailableView {
                        Label("No runtime variable keys", systemImage: "key.horizontal")
                    } description: {
                        Text("Add a key once; it will appear in every environment while values stay scoped to their selected targets.")
                    } actions: {
                        Button("Add Variable…") { showingAdd = true }
                            .buttonStyle(.borderedProminent)
                            .clickTargetCursor()
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(inventory.keys, id: \.self) { key in
                        variableRow(key)
                    }
                    .listStyle(.inset)
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text("Keys appear across every environment. Values stay scoped unless explicitly shared. If this Mac lacks provider access, ask your connected coding agent to prepare the next step or an owner handoff.")
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
            .clickTargetCursor()
            .disabled(selectedService.isEmpty || loading)
        }
        .padding(14)
    }

    private func loadVariables() async {
        let requestedTargets = targets
        guard !requestedTargets.isEmpty else {
            inventory = HostingVariableInventory()
            loading = false
            loadError = nil
            return
        }
        let requestedInventoryKey = requestedTargets.map(\.id).joined(separator: "|")
        loading = true
        loadError = nil
        defer {
            if inventoryKey == requestedInventoryKey {
                loading = false
            }
        }
        do {
            let loaded = try await model.hostingVariables(
                projectID: project.id,
                targets: requestedTargets
            )
            guard inventoryKey == requestedInventoryKey else { return }
            inventory = loaded
        } catch {
            guard inventoryKey == requestedInventoryKey else { return }
            loadError = userFacingMessage(for: error)
        }
    }

    private var failureSummary: String {
        inventory.failures
            .sorted { $0.key.id < $1.key.id }
            .map { "\($0.key.environment)/\($0.key.service): \($0.value)" }
            .joined(separator: "\n")
    }

    @ViewBuilder
    private func variableRow(_ key: String) -> some View {
        let target = currentTarget
        let variable = target.flatMap { inventory.variable(named: key, at: $0) }
        let targetUnavailable = target.flatMap { inventory.failures[$0] } != nil
        let coverage = targets.filter { inventory.variable(named: key, at: $0) != nil }.count
        HStack(spacing: 12) {
            Image(systemName: variable == nil ? "key.horizontal" : "key.fill")
                .foregroundStyle(variable == nil ? .secondary : .primary)
                .frame(width: 18)
            Text(key)
                .font(.body.monospaced())
                .textSelection(.enabled)
            Text("\(coverage)/\(targets.count)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.quaternary, in: Capsule())
                .help(coverageSummary(for: key))
            Spacer()
            if let variable {
                Text(variable.maskedValue)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .textSelection(.enabled)
            } else {
                Text(targetUnavailable ? "Unavailable" : "Missing")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(targetUnavailable ? .orange : .secondary)
            }
        }
        .padding(.vertical, 5)
    }

    private func coverageSummary(for key: String) -> String {
        let configured = targets.filter { inventory.variable(named: key, at: $0) != nil }
        let missing = targets.filter { inventory.variable(named: key, at: $0) == nil }
        var lines = configured.map { "Set: \($0.environment)/\($0.service)" }
        lines.append(contentsOf: missing.map { "Missing: \($0.environment)/\($0.service)" })
        return lines.joined(separator: "\n")
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

    let initialTarget: HostingVariableTarget
    let targets: [HostingVariableTarget]
    let providersByTarget: [HostingVariableTarget: String]
    let inventory: HostingVariableInventory
    let onSubmit: (HostingVariableRequest) async throws -> Void

    @State private var key = ""
    @State private var mode: SourceMode = .direct
    @State private var directValue = ""
    @State private var reference = ""
    @State private var generatedLength = 48
    @State private var sharingValue = false
    @State private var selectedTargets: Set<HostingVariableTarget>
    @State private var submitting = false
    @State private var errorMessage: String?

    init(
        initialTarget: HostingVariableTarget,
        targets: [HostingVariableTarget],
        providersByTarget: [HostingVariableTarget: String],
        inventory: HostingVariableInventory,
        onSubmit: @escaping (HostingVariableRequest) async throws -> Void
    ) {
        self.initialTarget = initialTarget
        self.targets = targets
        self.providersByTarget = providersByTarget
        self.inventory = inventory
        self.onSubmit = onSubmit
        _selectedTargets = State(initialValue: [initialTarget])
    }

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
        guard validKey, !selectedTargets.isEmpty else { return false }
        switch mode {
        case .direct:
            return !directValue.isEmpty
        case .reference:
            return !reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .generated:
            return true
        }
    }

    private var orderedSelectedTargets: [HostingVariableTarget] {
        targets.filter(selectedTargets.contains)
    }

    private var replacingCount: Int {
        selectedTargets.filter {
            inventory.variable(named: normalizedKey, at: $0) != nil
        }.count
    }

    private var knownKey: Bool {
        inventory.keys.contains(normalizedKey)
    }

    private var additionalTargetGroups: [(environment: String, targets: [HostingVariableTarget])] {
        let additional = targets.filter { $0 != initialTarget }
        let grouped = Dictionary(grouping: additional, by: \.environment)
        return grouped.keys.sorted().map { environment in
            (environment, grouped[environment, default: []].sorted { $0.service < $1.service })
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Add Runtime Variable")
                            .font(.title3.weight(.semibold))
                        Text("\(initialTarget.environment) · \(initialTarget.service)")
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
                        } else if replacingCount > 0 {
                            Text("This replaces \(replacingCount) existing target \(replacingCount == 1 ? "value" : "values").")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        } else if knownKey {
                            Text("This key already exists elsewhere; the selected missing targets will be filled.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Picker("Value source", selection: $mode) {
                        ForEach(SourceMode.allCases) { source in
                            Text(source.rawValue).tag(source)
                        }
                    }
                    .pickerStyle(.segmented)
                    .clickTargetCursor()

                    sourceFields
                    destinationFields

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
            }

            Divider()
            HStack {
                Button("Cancel") {
                    clearSecretState()
                    dismiss()
                }
                .clickTargetCursor()
                Spacer()
                if submitting {
                    ProgressView()
                        .controlSize(.small)
                }
                Button("Apply to \(selectedTargets.count) \(selectedTargets.count == 1 ? "Target" : "Targets")") {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .clickTargetCursor()
                .disabled(!canSubmit || submitting)
            }
            .padding(14)
        }
        .frame(width: 560, height: 580)
        .onChange(of: sharingValue) { _, isSharing in
            if !isSharing {
                selectedTargets = [initialTarget]
            }
        }
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
                    .clickTargetCursor()
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
                .clickTargetCursor()
                Text("Hypervibe creates one value and applies that same value to every selected target without returning it to the app.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var destinationFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "scope")
                    .foregroundStyle(.secondary)
                Text("\(initialTarget.environment) / \(initialTarget.service)")
                    .font(.callout.weight(.medium))
                Spacer()
                Text("Default")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(10)
            .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))

            if !additionalTargetGroups.isEmpty {
                Toggle("Share this exact value with more environments or services", isOn: $sharingValue)
                    .toggleStyle(.switch)
                    .font(.callout)
                    .clickTargetCursor()
            }

            if sharingValue {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Additional targets")
                        .font(.caption.weight(.medium))
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(additionalTargetGroups, id: \.environment) { group in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(group.environment)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    ForEach(group.targets) { target in
                                        Toggle(isOn: targetSelection(target)) {
                                            HStack(spacing: 8) {
                                                if let provider = providersByTarget[target] {
                                                    ProviderLogo(provider: provider, size: 18)
                                                }
                                                Text(target.service)
                                                Spacer()
                                                if inventory.variable(named: normalizedKey, at: target) != nil {
                                                    Text("will replace")
                                                        .font(.caption2)
                                                        .foregroundStyle(.orange)
                                                }
                                            }
                                        }
                                        .toggleStyle(.checkbox)
                                        .clickTargetCursor()
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxHeight: 150)
                }
                .padding(10)
                .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
            } else {
                Text("The value stays only on the current environment and service unless you explicitly select more targets.")
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
                    destinations: orderedSelectedTargets,
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

    private func targetSelection(_ target: HostingVariableTarget) -> Binding<Bool> {
        Binding(
            get: { selectedTargets.contains(target) },
            set: { selected in
                if selected {
                    selectedTargets.insert(target)
                } else {
                    selectedTargets.remove(target)
                }
            }
        )
    }

    private func clearSecretState() {
        directValue = ""
        reference = ""
    }
}
