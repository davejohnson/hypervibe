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
                if inventory.keys.isEmpty, !loading {
                    ContentUnavailableView {
                        Label("No runtime variable keys", systemImage: "key.horizontal")
                    } description: {
                        Text("Declare keys in the Hypervibe spec and provide values through secretRefs when planning.")
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
        Text("Runtime values are read-only here. Declare ownership with hv_spec, then provide .env or secret-manager references to hv_plan.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
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
