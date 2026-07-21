import AppKit
import HypervibeCompanionCore
import SwiftUI

struct ConnectionsView: View {
    @ObservedObject var model: CompanionAppModel
    let project: CompanionProject
    let preselectedProvider: String?

    @State private var showingAdd = false
    @State private var didResolveInitialRoute = false
    @State private var busyConnections: Set<String> = []
    @State private var pendingDelete: ConnectionSummary?
    @State private var notice: ConnectionNotice?

    private var catalog: ConnectionCatalog? {
        model.connectionCatalogs[project.id]
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(minWidth: 640, idealWidth: 680, minHeight: 460, idealHeight: 520)
        .background(WindowFocusBridge())
        .task(id: project.id) {
            await model.loadConnectionCatalog(projectID: project.id)
            guard !didResolveInitialRoute else { return }
            didResolveInitialRoute = true
            // The dashboard plus button opens without a provider; provider cards
            // open the management list focused on their existing connection.
            showingAdd = preselectedProvider == nil
        }
        .sheet(isPresented: $showingAdd) {
            AddConnectionView(
                providers: catalog?.providers ?? [],
                connections: catalog?.connections ?? [],
                initialProvider: preselectedProvider
            ) { request in
                let result = try await model.addConnection(
                    projectID: project.id,
                    request: request
                )
                notice = ConnectionNotice(
                    message: noticeMessage(for: result),
                    isError: false
                )
                return result
            }
        }
        .confirmationDialog(
            "Delete \(pendingDelete?.provider ?? "") connection?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Connection", role: .destructive) {
                guard let connection = pendingDelete else { return }
                pendingDelete = nil
                Task { await remove(connection) }
            }
            Button("Cancel", role: .cancel) {
                pendingDelete = nil
            }
        } message: {
            Text("Hypervibe will remove the encrypted \(pendingDelete?.provider ?? "provider") credentials for scope \(pendingDelete?.scope ?? "global") from this project's local connection store.")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            RocketIcon()
                .frame(width: 24, height: 24)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Provider Connections")
                    .font(.title3.weight(.semibold))
                Text(project.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.loadingConnectionCatalogIDs.contains(project.id) {
                ProgressView()
                    .controlSize(.small)
            }
            Button {
                Task { await model.loadConnectionCatalog(projectID: project.id) }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh connections")
        }
        .padding(16)
    }

    @ViewBuilder
    private var content: some View {
        if let error = model.connectionCatalogErrors[project.id], catalog == nil {
            ContentUnavailableView {
                Label("Connections unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Retry") {
                    Task { await model.loadConnectionCatalog(projectID: project.id) }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let catalog {
            VStack(spacing: 0) {
                if let refreshError = model.connectionCatalogErrors[project.id] {
                    Label(refreshError, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                }
                if let notice {
                    Label(
                        notice.message,
                        systemImage: notice.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
                    )
                    .font(.callout)
                    .foregroundStyle(notice.isError ? .red : .green)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(
                        (notice.isError ? Color.red : Color.green).opacity(0.08),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                }

                if catalog.connections.isEmpty {
                    ContentUnavailableView {
                        Label("No provider connections", systemImage: "point.3.connected.trianglepath.dotted")
                    } description: {
                        Text("Connect hosting, source control, DNS, email, and other providers for this project.")
                    } actions: {
                        Button("Add Connection…") { showingAdd = true }
                            .buttonStyle(.borderedProminent)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(catalog.connections, selection: .constant(nil as String?)) { connection in
                        connectionRow(connection, catalog: catalog)
                    }
                    .listStyle(.inset)
                }
            }
        } else {
            VStack(spacing: 10) {
                ProgressView()
                Text("Loading provider connections…")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var footer: some View {
        HStack {
            Text("Connections are stored by Hypervibe for this project. The app never stores credentials.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                showingAdd = true
            } label: {
                Label("Add Connection", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .disabled(catalog == nil)
        }
        .padding(14)
    }

    private func connectionRow(
        _ connection: ConnectionSummary,
        catalog: ConnectionCatalog
    ) -> some View {
        let provider = catalog.providers.first { $0.name == connection.provider }
        let isBusy = busyConnections.contains(connection.id)
        return HStack(spacing: 12) {
            ProviderLogo(provider: connection.provider, size: 36)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(provider?.displayName ?? connection.provider)
                        .font(.body.weight(.medium))
                    Text(connection.scope)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                HStack(spacing: 6) {
                    Circle()
                        .fill(connectionColor(connection.status))
                        .frame(width: 7, height: 7)
                    Text(connectionTitle(connection.status))
                    if let verifiedAt = connection.lastVerifiedAt {
                        Text("· verified \(verifiedAt.formatted(.relative(presentation: .named)))")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            if isBusy {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 24)
            } else {
                Button("Verify") {
                    Task { await verify(connection) }
                }
                Button(role: .destructive) {
                    pendingDelete = connection
                } label: {
                    Image(systemName: "trash")
                }
                .help("Delete \(provider?.displayName ?? connection.provider) connection")
            }
        }
        .padding(.vertical, 7)
    }

    private func verify(_ connection: ConnectionSummary) async {
        guard busyConnections.insert(connection.id).inserted else { return }
        defer { busyConnections.remove(connection.id) }
        do {
            let result = try await model.verifyConnection(
                projectID: project.id,
                provider: connection.provider,
                scope: connection.scope
            )
            notice = ConnectionNotice(
                message: noticeMessage(for: result),
                isError: false
            )
        } catch {
            notice = ConnectionNotice(message: model.connectionMessage(for: error), isError: true)
        }
    }

    private func remove(_ connection: ConnectionSummary) async {
        guard busyConnections.insert(connection.id).inserted else { return }
        defer { busyConnections.remove(connection.id) }
        do {
            let result = try await model.removeConnection(
                projectID: project.id,
                provider: connection.provider,
                scope: connection.scope
            )
            notice = ConnectionNotice(message: result.message, isError: false)
        } catch {
            notice = ConnectionNotice(message: model.connectionMessage(for: error), isError: true)
        }
    }

    private func connectionTitle(_ status: ConnectionStatus) -> String {
        switch status {
        case .verified: "Verified"
        case .pending: "Pending verification"
        case .failed: "Verification failed"
        case .unknown: "Unknown"
        }
    }

    private func connectionColor(_ status: ConnectionStatus) -> Color {
        switch status {
        case .verified: .green
        case .pending: .orange
        case .failed: .red
        case .unknown: .secondary
        }
    }

    private func noticeMessage(for result: ConnectionMutationResult) -> String {
        guard let identity = result.identity,
            !result.message.localizedCaseInsensitiveContains(identity) else {
            return result.message
        }
        return "\(result.message) · \(identity)"
    }
}

private struct ConnectionNotice: Equatable {
    let message: String
    let isError: Bool
}

private struct AddConnectionView: View {
    enum CredentialMode: String, CaseIterable, Identifiable {
        case direct = "Enter credentials"
        case reference = "Use a reference"

        var id: String { rawValue }
    }

    @Environment(\.dismiss) private var dismiss

    let providers: [ProviderCatalogEntry]
    let connections: [ConnectionSummary]
    let initialProvider: String?
    let onSubmit: (ConnectionRequest) async throws -> ConnectionMutationResult

    @State private var selectedProviderName: String?
    @State private var mode: CredentialMode = .direct
    @State private var fieldValues: [String: String] = [:]
    @State private var credentialsReference = ""
    @State private var credentialsKey = ""
    @State private var scope = ""
    @State private var showingGuidance = false
    @State private var submitting = false
    @State private var errorMessage: String?

    init(
        providers: [ProviderCatalogEntry],
        connections: [ConnectionSummary],
        initialProvider: String?,
        onSubmit: @escaping (ConnectionRequest) async throws -> ConnectionMutationResult
    ) {
        self.providers = providers
        self.connections = connections
        self.initialProvider = initialProvider
        self.onSubmit = onSubmit
        _selectedProviderName = State(initialValue: initialProvider)
    }

    private var selectedProvider: ProviderCatalogEntry? {
        guard let selectedProviderName else { return nil }
        return providers.first { $0.name == selectedProviderName }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Add Provider Connection")
                        .font(.title3.weight(.semibold))
                    Text("Credentials are sent directly to Hypervibe and are not saved by this app.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(16)
            Divider()

            if let provider = selectedProvider {
                providerForm(provider)
            } else {
                providerPicker
            }
        }
        .frame(width: 620, height: 520)
        .onDisappear(perform: clearCredentialState)
    }

    private var providerPicker: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(groupedProviders, id: \.category) { group in
                    VStack(alignment: .leading, spacing: 9) {
                        Text(group.category.replacingOccurrences(of: "-", with: " ").capitalized)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        LazyVGrid(
                            columns: [GridItem(.adaptive(minimum: 165), spacing: 10)],
                            spacing: 10
                        ) {
                            ForEach(group.providers) { provider in
                                Button {
                                    select(provider)
                                } label: {
                                    HStack(spacing: 10) {
                                        ProviderLogo(provider: provider.name, size: 32)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(provider.displayName)
                                                .lineLimit(1)
                                            if connections.contains(where: { $0.provider == provider.name }) {
                                                Text("Already connected")
                                                    .font(.caption2)
                                                    .foregroundStyle(.secondary)
                                            }
                                        }
                                        Spacer()
                                    }
                                    .padding(10)
                                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 9))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .padding(16)
        }
    }

    private var groupedProviders: [(category: String, providers: [ProviderCatalogEntry])] {
        Dictionary(grouping: providers, by: \.category)
            .map { category, providers in
                (
                    category: category,
                    providers: providers.sorted {
                        $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
                    }
                )
            }
            .sorted { $0.category.localizedCaseInsensitiveCompare($1.category) == .orderedAscending }
    }

    private func providerForm(_ provider: ProviderCatalogEntry) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 11) {
                        Button {
                            selectedProviderName = nil
                            clearFormValues()
                        } label: {
                            Image(systemName: "chevron.left")
                        }
                        .buttonStyle(.borderless)
                        ProviderLogo(provider: provider.name, size: 38)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.displayName)
                                .font(.headline)
                            if let tokenType = provider.tokenType {
                                Text(tokenType)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        Spacer()
                        ForEach(provider.setupLinks) { link in
                            Link(destination: link.url) {
                                Label(link.label, systemImage: "arrow.up.right.square")
                            }
                            .font(.caption)
                        }
                    }

                    if !provider.requiredPermissions.isEmpty || !provider.notes.isEmpty {
                        DisclosureGroup("Permissions and setup notes", isExpanded: $showingGuidance) {
                            VStack(alignment: .leading, spacing: 7) {
                                ForEach(provider.requiredPermissions, id: \.self) { permission in
                                    Label(permission, systemImage: "checkmark.circle")
                                }
                                ForEach(provider.notes, id: \.self) { note in
                                    Label(note, systemImage: "info.circle")
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.top, 8)
                        }
                    }

                    if provider.credentialFields != nil {
                        Picker("Credential source", selection: $mode) {
                            ForEach(CredentialMode.allCases) { mode in
                                Text(mode.rawValue).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)
                    } else {
                        Label(
                            "This Hypervibe version does not describe this provider's fields. Use a secure reference instead.",
                            systemImage: "info.circle"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }

                    if mode == .direct, let fields = provider.credentialFields {
                        if fields.isEmpty {
                            Label("This provider does not require credentials.", systemImage: "checkmark.circle")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(fields) { field in
                                credentialField(field)
                            }
                        }
                    } else {
                        referenceFields(provider)
                    }

                    VStack(alignment: .leading, spacing: 5) {
                        Text("Scope (optional)")
                            .font(.caption.weight(.medium))
                        TextField("global, owner/repo, or example.com", text: $scope)
                            .textFieldStyle(.roundedBorder)
                        Text("Leave blank for a global connection. Scoped connections can coexist.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

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
                .padding(16)
            }

            Divider()
            HStack {
                Button("Cancel") {
                    clearCredentialState()
                    dismiss()
                }
                Spacer()
                if submitting {
                    ProgressView()
                        .controlSize(.small)
                    Text("Adding and verifying…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button(hasMatchingConnection(provider) ? "Replace Connection" : "Add Connection") {
                    Task { await submit(provider) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit(provider) || submitting)
            }
            .padding(14)
        }
    }

    @ViewBuilder
    private func credentialField(_ field: CredentialField) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 3) {
                Text(field.label)
                    .font(.caption.weight(.medium))
                if field.required {
                    Text("Required")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            switch field.inputKind {
            case .choice:
                Picker(field.label, selection: fieldBinding(field.name)) {
                    Text("Select…").tag("")
                    ForEach(field.options, id: \.self) { option in
                        Text(option).tag(option)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
            case .secret:
                SecureField(field.label, text: fieldBinding(field.name))
                    .textFieldStyle(.roundedBorder)
            case .multilineSecret:
                HStack {
                    SecureField("Paste \(field.label.lowercased())", text: fieldBinding(field.name))
                        .textFieldStyle(.roundedBorder)
                    Button("Load File…") {
                        loadFile(into: field.name)
                    }
                }
            case .text:
                TextField(field.label, text: fieldBinding(field.name))
                    .textFieldStyle(.roundedBorder)
            }
            if let description = field.description {
                Text(description)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func referenceFields(_ provider: ProviderCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Credentials reference")
                        .font(.caption.weight(.medium))
                    Spacer()
                    Button("Choose File…") {
                        chooseReferenceFile()
                    }
                }
                TextField(
                    "env:NAME, dotenv:/path/.env#KEY, file:/path, or 1password://…",
                    text: $credentialsReference
                )
                .textFieldStyle(.roundedBorder)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("Credential key (optional)")
                    .font(.caption.weight(.medium))
                TextField(provider.defaultScalarKey ?? "apiToken", text: $credentialsKey)
                    .textFieldStyle(.roundedBorder)
                Text("Only needed when the reference resolves to one scalar value.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func fieldBinding(_ name: String) -> Binding<String> {
        Binding(
            get: { fieldValues[name] ?? "" },
            set: { fieldValues[name] = $0 }
        )
    }

    private func select(_ provider: ProviderCatalogEntry) {
        selectedProviderName = provider.name
        mode = provider.credentialFields == nil ? .reference : .direct
        credentialsKey = provider.defaultScalarKey ?? ""
        errorMessage = nil
    }

    private func canSubmit(_ provider: ProviderCatalogEntry) -> Bool {
        if mode == .reference || provider.credentialFields == nil {
            return !credentialsReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return (provider.credentialFields ?? []).allSatisfy { field in
            !field.required || !(fieldValues[field.name] ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func hasMatchingConnection(_ provider: ProviderCatalogEntry) -> Bool {
        let normalizedScope = scope.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedScope = normalizedScope.isEmpty ? "global" : normalizedScope
        return connections.contains {
            $0.provider == provider.name
                && $0.scope.caseInsensitiveCompare(requestedScope) == .orderedSame
        }
    }

    private func submit(_ provider: ProviderCatalogEntry) async {
        guard !submitting else { return }
        submitting = true
        errorMessage = nil
        defer { submitting = false }

        let source: ConnectionCredentialSource
        if mode == .reference || provider.credentialFields == nil {
            source = .reference(
                value: credentialsReference.trimmingCharacters(in: .whitespacesAndNewlines),
                credentialKey: credentialsKey
            )
        } else {
            let credentials = fieldValues.filter {
                !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            source = .direct(credentials)
        }

        do {
            _ = try await onSubmit(
                ConnectionRequest(
                    provider: provider.name,
                    source: source,
                    scope: scope
                )
            )
            clearCredentialState()
            dismiss()
        } catch {
            if let localized = error as? LocalizedError,
                let description = localized.errorDescription {
                errorMessage = description
            } else {
                errorMessage = "Hypervibe could not add this connection."
            }
        }
    }

    private func loadFile(into field: String) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            fieldValues[field] = try String(contentsOf: url, encoding: .utf8)
            errorMessage = nil
        } catch {
            errorMessage = "The selected credential file could not be read."
        }
    }

    private func chooseReferenceFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        credentialsReference = "file:\(url.path)"
    }

    private func clearFormValues() {
        fieldValues.removeAll(keepingCapacity: false)
        credentialsReference = ""
        credentialsKey = ""
        scope = ""
        mode = .direct
        errorMessage = nil
        showingGuidance = false
    }

    private func clearCredentialState() {
        clearFormValues()
        selectedProviderName = nil
    }
}
