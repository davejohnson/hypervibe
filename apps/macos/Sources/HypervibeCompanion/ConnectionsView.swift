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
                initialProvider: preselectedProvider,
                onDescribe: { provider, scope in
                    try await model.describeConnection(projectID: project.id, provider: provider, scope: scope)
                }
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
            .clickTargetCursor()
            Button("Cancel", role: .cancel) {
                pendingDelete = nil
            }
            .clickTargetCursor()
        } message: {
            Text("Hypervibe will remove the encrypted \(pendingDelete?.provider ?? "provider") credentials for scope \(pendingDelete?.scope ?? "global") from this Mac's shared Hypervibe connection store.")
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
            .clickTargetCursor()
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
                .clickTargetCursor()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let catalog {
            VStack(spacing: 0) {
                if let refreshError = model.connectionCatalogErrors[project.id] {
                    Label(refreshError, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(CompanionColor.warning)
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
                    .foregroundStyle(
                        notice.isError ? Color.red : CompanionColor.success
                    )
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
                            .clickTargetCursor()
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
            Text("Connections are encrypted in this Mac's shared Hypervibe store. Scopes control where each credential is used; the app never stores credential values.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                showingAdd = true
            } label: {
                Label("Add Connection", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .clickTargetCursor()
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
                .clickTargetCursor()
                Button(role: .destructive) {
                    pendingDelete = connection
                } label: {
                    Image(systemName: "trash")
                }
                .help("Delete \(provider?.displayName ?? connection.provider) connection")
                .clickTargetCursor()
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
        case .verified: CompanionColor.success
        case .pending: CompanionColor.warning
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
    let onDescribe: (String, String) async throws -> ConnectionGuidance
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
    @State private var guidance: ConnectionGuidance?
    @State private var loadingGuidance = false
    @State private var guidanceRequestID = UUID()
    @State private var guidanceSelection: [String]?
    @State private var useExistingCredentials = false

    init(
        providers: [ProviderCatalogEntry],
        connections: [ConnectionSummary],
        initialProvider: String?,
        onDescribe: @escaping (String, String) async throws -> ConnectionGuidance,
        onSubmit: @escaping (ConnectionRequest) async throws -> ConnectionMutationResult
    ) {
        self.providers = providers
        self.connections = connections
        self.initialProvider = initialProvider
        self.onDescribe = onDescribe
        self.onSubmit = onSubmit
        _selectedProviderName = State(initialValue: initialProvider)
    }

    private var selectedProvider: ProviderCatalogEntry? {
        guard let selectedProviderName else { return nil }
        return providers.first { $0.name == selectedProviderName }
    }

    private var currentGuidance: ConnectionGuidance? {
        guidanceSelection == [selectedProviderName ?? "", scope] ? guidance : nil
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
        .task(id: [selectedProviderName ?? "", scope]) { await loadGuidance() }
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
                                    .companionCardSurface(cornerRadius: 9)
                                }
                                .buttonStyle(.plain)
                                .clickTargetCursor()
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

    private func providerForm(_ catalogProvider: ProviderCatalogEntry) -> some View {
        let provider = currentGuidance?.provider ?? catalogProvider
        return VStack(spacing: 0) {
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
                        .clickTargetCursor()
                        ProviderLogo(provider: provider.name, size: 38)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.displayName).font(.headline)
                            if let tokenType = provider.tokenType {
                                Text(tokenType).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        Spacer()
                    }

                    VStack(alignment: .leading, spacing: 5) {
                        Text("Scope (optional)").font(.caption.weight(.medium))
                        TextField("global, owner/repo, or example.com", text: $scope)
                            .textFieldStyle(.roundedBorder)
                        Text("Leave blank for a global connection. Setup links update for the scope you enter.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }

                    if loadingGuidance {
                        ProgressView("Preparing setup guidance…")
                    } else if let guidance = currentGuidance {
                        if provider.requiresAgentSetup && !useExistingCredentials {
                            VStack(alignment: .leading, spacing: 10) {
                                Label("Continue with your coding agent", systemImage: "bubble.left.and.text.bubble.right")
                                    .font(.headline)
                                Text("Hypervibe can handle the supported account and sign-in setup. Your agent will reuse existing access and guide you through any browser sign-in or approvals.")
                                Text(guidance.agentSetupPrompt)
                                    .font(.callout).textSelection(.enabled)
                                Button("Copy setup prompt") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(guidance.agentSetupPrompt, forType: .string)
                                }
                                .buttonStyle(.borderedProminent).clickTargetCursor()
                                Button("Use credentials I already have") { useExistingCredentials = true }
                                    .buttonStyle(.link).clickTargetCursor()
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 9) {
                                if let url = guidance.recommendedSetupURL {
                                    Link(destination: url) {
                                        Label("Open recommended setup", systemImage: "arrow.up.right.square")
                                    }
                                    .font(.headline).clickTargetCursor()
                                }
                                ForEach(provider.setupLinks.filter { $0.url != guidance.recommendedSetupURL }) { link in
                                    Link(destination: link.url) {
                                        Label(link.label, systemImage: "arrow.up.right.square")
                                    }
                                    .font(.caption).clickTargetCursor()
                                }
                            }
                            if !provider.requiredPermissions.isEmpty || !provider.notes.isEmpty {
                                DisclosureGroup(isExpanded: $showingGuidance) {
                                    VStack(alignment: .leading, spacing: 7) {
                                        ForEach(provider.requiredPermissions, id: \.self) { Label($0, systemImage: "checkmark.circle") }
                                        ForEach(provider.notes, id: \.self) { Label($0, systemImage: "info.circle") }
                                    }
                                    .font(.caption).foregroundStyle(.secondary).padding(.top, 8)
                                } label: {
                                    Text("Permissions and setup notes").clickTargetCursor()
                                }
                            }
                            credentialInputs(provider)
                            if provider.requiresAgentSetup {
                                Button("Use guided setup instead") { useExistingCredentials = false }
                                    .buttonStyle(.link).clickTargetCursor()
                            }
                        }
                    }

                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout).foregroundStyle(.red).textSelection(.enabled)
                            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                        if currentGuidance == nil && !loadingGuidance {
                            Button("Retry setup guidance") { Task { await loadGuidance() } }
                                .clickTargetCursor()
                        }
                    }
                }
                .padding(16)
            }
            Divider()
            HStack {
                Button("Cancel") { clearCredentialState(); dismiss() }.clickTargetCursor()
                Spacer()
                if submitting {
                    ProgressView().controlSize(.small)
                    Text("Adding and verifying…").font(.caption).foregroundStyle(.secondary)
                }
                if !provider.requiresAgentSetup || useExistingCredentials {
                    Button(hasMatchingConnection(provider) ? "Replace Connection" : "Add Connection") {
                        Task { await submit(provider) }
                    }
                    .buttonStyle(.borderedProminent).clickTargetCursor()
                    .disabled(!canSubmit(provider) || submitting)
                }
            }
            .padding(14)
        }
    }

    private func credentialInputs(_ provider: ProviderCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if provider.credentialFields != nil {
                Picker("Credential source", selection: $mode) {
                    ForEach(CredentialMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .clickTargetCursor()
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

        }
    }

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
                .clickTargetCursor()
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
                    .clickTargetCursor()
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
                    .clickTargetCursor()
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
        guard currentGuidance != nil, !loadingGuidance,
            !provider.requiresAgentSetup || useExistingCredentials else { return false }
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
        guidance = nil
        guidanceSelection = nil
        guidanceRequestID = UUID()
        loadingGuidance = false
        useExistingCredentials = false
    }

    private func loadGuidance() async {
        guard let requestedProvider = selectedProviderName else { return }
        let requestedScope = scope
        let requestID = UUID()
        guidanceRequestID = requestID
        guidance = nil
        loadingGuidance = true
        errorMessage = nil
        do {
            try await Task.sleep(for: .milliseconds(250))
            let result = try await onDescribe(requestedProvider, requestedScope)
            guard !Task.isCancelled, guidanceRequestID == requestID,
                selectedProviderName == requestedProvider, scope == requestedScope else { return }
            guard result.provider.name == requestedProvider else {
                throw HypervibeClientError.malformedResponse("Setup guidance belongs to another provider.")
            }
            guidance = result
            guidanceSelection = [requestedProvider, requestedScope]
            loadingGuidance = false
        } catch {
            guard !Task.isCancelled, guidanceRequestID == requestID else { return }
            loadingGuidance = false
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Hypervibe could not prepare setup guidance."
        }
    }

    private func clearCredentialState() {
        clearFormValues()
        selectedProviderName = nil
    }
}
