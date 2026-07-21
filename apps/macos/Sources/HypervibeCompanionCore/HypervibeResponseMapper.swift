import Foundation

enum HypervibeResponseMapper {
    struct Topology: Equatable, Sendable {
        let projectName: String
        let specRevision: Int
        let environments: [EnvironmentSnapshot]
    }

    static func decodeTopology(_ data: Data) throws -> Topology {
        let envelope: ToolEnvelope<SpecToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse("hv_spec_get returned no data.")
        }

        let environments = payload.spec.environments
            .map { name, environment in
                EnvironmentSnapshot(
                    name: name,
                    specRevision: payload.revision,
                    resources: resources(for: environment),
                    observation: nil
                )
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        return Topology(
            projectName: payload.project.name,
            specRevision: payload.revision,
            environments: environments
        )
    }

    static func decodeObservation(
        _ data: Data,
        attemptedAt: Date,
        previous: ObservationSummary?
    ) throws -> ObservationSummary {
        let envelope: ToolEnvelope<StatusToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse("hv_status returned no data.")
        }

        let blockedProviders = Array(Set(payload.blocked.map(\.provider))).sorted()
        let isBlocked = !blockedProviders.isEmpty || payload.inputRequired.count > 0
        let health: EnvironmentHealth
        if isBlocked {
            health = .blocked
        } else if !payload.verified {
            health = .unverified
        } else if payload.inSync {
            health = .inSync
        } else {
            health = .drifted
        }

        return ObservationSummary(
            health: health,
            verified: payload.verified,
            driftCount: payload.drift.count,
            unmanagedCount: payload.unmanaged.count,
            blockedProviders: blockedProviders,
            latestAttemptAt: attemptedAt,
            latestSuccessfulAt: payload.verified
                ? parseDate(payload.observedAt) ?? attemptedAt
                : previous?.latestSuccessfulAt,
            services: payload.services?.map { service in
                ServiceObservation(
                    name: service.name,
                    status: ServiceLiveStatus(rawValue: service.status) ?? .unknown,
                    url: PublicServiceEndpoint.originURL(from: service.url),
                    customDomains: PublicServiceEndpoint.hostnames(
                        from: service.customDomains ?? []
                    )
                )
            },
            driftedResources: payload.drift.compactMap { action in
                action.resource.map { resource in
                    DriftedResource(
                        kind: resource.kind,
                        name: resource.name,
                        actionType: action.type ?? "change",
                        provider: resource.provider
                    )
                }
            }
        )
    }

    static func failedObservation(
        attemptedAt: Date,
        previous: ObservationSummary?
    ) -> ObservationSummary {
        ObservationSummary(
            health: .failed,
            verified: false,
            driftCount: previous?.driftCount ?? 0,
            unmanagedCount: previous?.unmanagedCount ?? 0,
            blockedProviders: previous?.blockedProviders ?? [],
            latestAttemptAt: attemptedAt,
            latestSuccessfulAt: previous?.latestSuccessfulAt,
            services: previous?.services,
            driftedResources: previous?.driftedResources
        )
    }

    static func decodeRuns(_ data: Data) throws -> [RecentRunSummary] {
        let envelope: ToolEnvelope<RunsToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse("hv_runs returned no data.")
        }

        return payload.runs.map { run in
            RecentRunSummary(
                id: run.id,
                environment: run.environment,
                type: run.type,
                status: RecentRunStatus(rawValue: run.status) ?? .unknown,
                startedAt: parseDate(run.startedAt),
                completedAt: parseDate(run.completedAt)
            )
        }
    }

    static func decodeConnections(_ data: Data) throws -> [ConnectionSummary] {
        try decodeConnectionCatalog(data).connections
    }

    static func decodeConnectionCatalog(_ data: Data) throws -> ConnectionCatalog {
        let envelope: ToolEnvelope<ConnectionsToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse(
                "hv_connections_list returned no data."
            )
        }

        let connections = payload.connections
            .map { connection in
                ConnectionSummary(
                    provider: connection.provider,
                    scope: connection.scope,
                    status: ConnectionStatus(rawValue: connection.status) ?? .unknown,
                    lastVerifiedAt: parseDate(connection.lastVerifiedAt)
                )
            }
            .sorted {
                if $0.provider == $1.provider {
                    return $0.scope.localizedCaseInsensitiveCompare($1.scope)
                        == .orderedAscending
                }
                return $0.provider.localizedCaseInsensitiveCompare($1.provider)
                    == .orderedAscending
            }

        let providers = payload.availableProviders.flatMap { category, entries in
            entries.map { entry in
                let links = setupLinks(for: entry)
                return ProviderCatalogEntry(
                    name: entry.name,
                    displayName: entry.displayName ?? entry.name,
                    category: category,
                    setupLinks: links,
                    tokenType: entry.tokenType,
                    requiredPermissions: entry.requiredPermissions ?? [],
                    notes: entry.notes ?? [],
                    credentialFields: entry.credentialFields?.map { field in
                        CredentialField(
                            name: field.name,
                            label: field.label ?? field.name,
                            required: field.required ?? false,
                            sensitive: field.sensitive ?? true,
                            inputKind: CredentialInputKind(rawValue: field.inputKind ?? "secret") ?? .secret,
                            options: field.options ?? [],
                            description: field.description
                        )
                    },
                    defaultScalarKey: entry.defaultScalarKey
                )
            }
        }.sorted {
            if $0.category == $1.category {
                return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
            return $0.category.localizedCaseInsensitiveCompare($1.category) == .orderedAscending
        }

        return ConnectionCatalog(connections: connections, providers: providers)
    }

    static func decodeConnectionMutation(_ data: Data) throws -> ConnectionMutationResult {
        let envelope: ToolEnvelope<ConnectionMutationToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse("hv_connect returned no data.")
        }
        let removed = payload.removed ?? false
        let status = removed
            ? ConnectionStatus.unknown
            : ConnectionStatus(rawValue: payload.status ?? "") ?? .unknown
        let message = payload.message
            ?? (removed ? "\(payload.provider) connection removed." : "\(payload.provider) connection updated.")
        let identity = payload.identity
            ?? payload.login
            ?? payload.email
            ?? payload.accountId
            ?? payload.workspaceId
            ?? payload.version
        return ConnectionMutationResult(
            provider: payload.provider,
            scope: payload.scope ?? "global",
            status: status,
            message: message,
            identity: identity,
            warnings: envelope.warnings ?? [],
            removed: removed
        )
    }

    static func decodeHostingVariables(_ data: Data) throws -> HostingVariableCatalog {
        let envelope: ToolEnvelope<HostingVariablesToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse("hv_secrets_get returned no data.")
        }
        let variables = payload.vars.map { name, maskedValue in
            HostingVariableSummary(name: name, maskedValue: maskedValue)
        }.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        return HostingVariableCatalog(
            environment: payload.environment,
            service: payload.service,
            variables: variables
        )
    }

    static func decodeHostingVariableMutation(
        _ data: Data
    ) throws -> HostingVariableMutationResult {
        let envelope: ToolEnvelope<HostingVariableMutationToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse("hv_secrets_set returned no data.")
        }
        let destinations: [HostingVariableTarget]
        if let explicit = payload.destinations, !explicit.isEmpty {
            destinations = explicit
        } else if let environment = payload.environment, let service = payload.service {
            destinations = [HostingVariableTarget(environment: environment, service: service)]
        } else {
            throw HypervibeClientError.malformedResponse(
                "hv_secrets_set returned no destination receipt."
            )
        }
        return HostingVariableMutationResult(
            destinations: destinations,
            variables: payload.variables.sorted(),
            valueSource: payload.valueSource
        )
    }

    static func decodeUpgradeStatus(_ data: Data) throws {
        let envelope: ToolEnvelope<UpgradeToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse("hv_upgrade returned no data.")
        }
        if payload.sqlite.needsMigration {
            throw HypervibeClientError.schemaMigrationRequired
        }
    }

    private static func decodeEnvelope<Payload: Decodable>(
        _ data: Data
    ) throws -> ToolEnvelope<Payload> {
        let envelope = try JSONDecoder().decode(ToolEnvelope<Payload>.self, from: data)
        if !envelope.ok {
            throw HypervibeClientError.tool(
                code: envelope.error?.code ?? "UNKNOWN",
                message: envelope.error?.message ?? "Hypervibe returned an unknown error.",
                hint: envelope.hint
            )
        }
        return envelope
    }

    private static func setupLinks(for entry: ConnectionsToolData.Provider) -> [ProviderSetupLink] {
        var links: [ProviderSetupLink] = []
        var seen = Set<String>()
        for link in entry.setupHelpUrls ?? [] {
            guard let url = URL(string: link.url), seen.insert(url.absoluteString).inserted else {
                continue
            }
            links.append(ProviderSetupLink(label: link.label, url: url))
        }
        if let rawURL = entry.setupHelpUrl,
            let url = URL(string: rawURL),
            seen.insert(url.absoluteString).inserted {
            links.append(ProviderSetupLink(label: "Setup guide", url: url))
        }
        return links
    }

    private static func resources(
        for environment: DesiredEnvironment
    ) -> [ResourceSummary] {
        let databaseID = environment.database.map { _ in "database:primary" }
        var resources: [ResourceSummary] = environment.services.keys.sorted().map { name in
            ResourceSummary(
                id: "service:\(name)",
                kind: .service,
                name: name,
                desiredProvider: environment.hosting.provider,
                relationships: databaseID.map {
                    [ResourceRelationship(kind: .uses, targetResourceID: $0)]
                } ?? []
            )
        }

        if let database = environment.database {
            resources.append(
                ResourceSummary(
                    id: databaseID!,
                    kind: .database,
                    name: "database",
                    desiredProvider: database.provider
                )
            )
        }

        for (name, storage) in environment.storage.sorted(by: { $0.key < $1.key }) {
            resources.append(
                ResourceSummary(
                    id: "storage:\(name)",
                    kind: .storage,
                    name: name,
                    desiredProvider: storage.provider,
                    relationships: storage.injectInto.sorted().map {
                        ResourceRelationship(
                            kind: .injectsInto,
                            targetResourceID: "service:\($0)"
                        )
                    }
                )
            )
        }

        for name in environment.queues.keys.sorted() {
            let provider: String
            switch environment.hosting.provider {
            case "cloudrun":
                provider = "gcp-pubsub"
            case "railway":
                provider = environment.database?.provider ?? "postgres"
            default:
                provider = environment.hosting.provider
            }
            resources.append(
                ResourceSummary(
                    id: "queue:\(name)",
                    kind: .queue,
                    name: name,
                    desiredProvider: provider
                )
            )
        }

        if let domain = environment.domain {
            resources.append(
                ResourceSummary(
                    id: "domain:\(domain)",
                    kind: .domain,
                    name: domain,
                    desiredProvider: environment.domainRegistration?.provider
                        ?? environment.hosting.provider
                )
            )
        }

        if environment.deploy?.strategy == "branch" {
            let trigger = environment.deploy?.trigger ?? "ci"
            resources.append(
                ResourceSummary(
                    id: "ci:deploy",
                    kind: .ci,
                    name: "deploy",
                    desiredProvider: trigger == "ci"
                        ? "github-actions"
                        : environment.hosting.provider
                )
            )
        }

        if let ios = environment.ios {
            resources.append(
                ResourceSummary(
                    id: "ios:\(ios.bundleId)",
                    kind: .ios,
                    name: ios.bundleId,
                    desiredProvider: "app-store-connect"
                )
            )
        }

        return resources
    }

    private static func parseDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        if let date = fractionalFormatter.date(from: value) {
            return date
        }
        return ISO8601DateFormatter().date(from: value)
    }
}

private struct ToolEnvelope<Payload: Decodable>: Decodable {
    let ok: Bool
    let data: Payload?
    let error: ToolError?
    let hint: String?
    let warnings: [String]?
}

private struct ToolError: Decodable {
    let code: String
    let message: String
}

private struct SpecToolData: Decodable {
    let project: ProjectReference
    let revision: Int
    let spec: DesiredProjectSpec
}

private struct ProjectReference: Decodable {
    let name: String
}

private struct DesiredProjectSpec: Decodable {
    let environments: [String: DesiredEnvironment]
}

private struct DesiredEnvironment: Decodable {
    let hosting: Hosting
    let services: [String: IgnoredObject]
    let database: Database?
    let storage: [String: Storage]
    let queues: [String: IgnoredObject]
    let domain: String?
    let domainRegistration: DomainRegistration?
    let deploy: Deploy?
    let ios: IOS?

    private enum CodingKeys: String, CodingKey {
        case hosting
        case services
        case database
        case storage
        case queues
        case domain
        case domainRegistration
        case deploy
        case ios
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hosting = try container.decode(Hosting.self, forKey: .hosting)
        services = try container.decodeIfPresent(
            [String: IgnoredObject].self,
            forKey: .services
        ) ?? [:]
        database = try container.decodeIfPresent(Database.self, forKey: .database)
        storage = try container.decodeIfPresent(
            [String: Storage].self,
            forKey: .storage
        ) ?? [:]
        queues = try container.decodeIfPresent(
            [String: IgnoredObject].self,
            forKey: .queues
        ) ?? [:]
        domain = try container.decodeIfPresent(String.self, forKey: .domain)
        domainRegistration = try container.decodeIfPresent(
            DomainRegistration.self,
            forKey: .domainRegistration
        )
        deploy = try container.decodeIfPresent(Deploy.self, forKey: .deploy)
        ios = try container.decodeIfPresent(IOS.self, forKey: .ios)
    }

    struct Hosting: Decodable {
        let provider: String
    }

    struct Database: Decodable {
        let provider: String
    }

    struct Storage: Decodable {
        let provider: String
        let injectInto: [String]
    }

    struct DomainRegistration: Decodable {
        let provider: String
    }

    struct Deploy: Decodable {
        let strategy: String
        let trigger: String?
    }

    struct IOS: Decodable {
        let bundleId: String
    }
}

private typealias Hosting = DesiredEnvironment.Hosting
private typealias Database = DesiredEnvironment.Database
private typealias Storage = DesiredEnvironment.Storage
private typealias DomainRegistration = DesiredEnvironment.DomainRegistration
private typealias Deploy = DesiredEnvironment.Deploy
private typealias IOS = DesiredEnvironment.IOS

private struct StatusToolData: Decodable {
    let verified: Bool
    let inSync: Bool
    let drift: [DriftAction]
    let unmanaged: CountedItems
    let blocked: [Block]
    let inputRequired: CountedItems
    let observedAt: String?
    let services: [Service]?

    private enum CodingKeys: String, CodingKey {
        case verified
        case inSync
        case drift
        case unmanaged
        case blocked
        case inputRequired
        case observedAt
        case services
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        verified = try container.decode(Bool.self, forKey: .verified)
        inSync = try container.decode(Bool.self, forKey: .inSync)
        drift = try container.decodeIfPresent([DriftAction].self, forKey: .drift) ?? []
        unmanaged = try container.decodeIfPresent(
            CountedItems.self,
            forKey: .unmanaged
        ) ?? CountedItems()
        blocked = try container.decodeIfPresent([Block].self, forKey: .blocked) ?? []
        inputRequired = try container.decodeIfPresent(
            CountedItems.self,
            forKey: .inputRequired
        ) ?? CountedItems()
        observedAt = try container.decodeIfPresent(String.self, forKey: .observedAt)
        services = try container.decodeIfPresent([Service].self, forKey: .services)
    }

    struct Block: Decodable {
        let provider: String
    }

    struct DriftAction: Decodable {
        let type: String?
        let resource: Resource?

        struct Resource: Decodable {
            let kind: String
            let name: String
            let provider: String
        }
    }

    struct Service: Decodable {
        let name: String
        let status: String
        let url: String?
        let customDomains: [String]?
    }
}

private struct RunsToolData: Decodable {
    let runs: [Run]

    struct Run: Decodable {
        let id: String
        let environment: String?
        let type: String
        let status: String
        let startedAt: String?
        let completedAt: String?
    }
}

private struct UpgradeToolData: Decodable {
    let sqlite: SQLite

    struct SQLite: Decodable {
        let needsMigration: Bool
    }
}

private struct ConnectionsToolData: Decodable {
    let connections: [Connection]
    let availableProviders: [String: [Provider]]

    private enum CodingKeys: String, CodingKey {
        case connections
        case availableProviders
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connections = try container.decodeIfPresent([Connection].self, forKey: .connections) ?? []
        availableProviders = try container.decodeIfPresent(
            [String: [Provider]].self,
            forKey: .availableProviders
        ) ?? [:]
    }

    struct Connection: Decodable {
        let provider: String
        let scope: String
        let status: String
        let lastVerifiedAt: String?
    }

    struct Provider: Decodable {
        let name: String
        let displayName: String?
        let setupHelpUrl: String?
        let setupHelpUrls: [SetupLink]?
        let tokenType: String?
        let requiredPermissions: [String]?
        let notes: [String]?
        let credentialFields: [Field]?
        let defaultScalarKey: String?
    }

    struct SetupLink: Decodable {
        let label: String
        let url: String
    }

    struct Field: Decodable {
        let name: String
        let label: String?
        let required: Bool?
        let sensitive: Bool?
        let inputKind: String?
        let options: [String]?
        let description: String?
    }
}

private struct ConnectionMutationToolData: Decodable {
    let provider: String
    let scope: String?
    let status: String?
    let message: String?
    let identity: String?
    let login: String?
    let email: String?
    let accountId: String?
    let workspaceId: String?
    let version: String?
    let removed: Bool?
}

private struct HostingVariablesToolData: Decodable {
    let environment: String
    let service: String
    let vars: [String: String]
}

private struct HostingVariableMutationToolData: Decodable {
    let environment: String?
    let service: String?
    let destinations: [HostingVariableTarget]?
    let variables: [String]
    let valueSource: String
}

private struct IgnoredObject: Decodable {
    init(from decoder: Decoder) throws {
        _ = try DiscardedValue(from: decoder)
    }
}

private struct CountedItems: Decodable {
    let count: Int

    init() {
        count = 0
    }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var count = 0
        while !container.isAtEnd {
            _ = try container.decode(DiscardedValue.self)
            count += 1
        }
        self.count = count
    }
}

private struct DiscardedValue: Decodable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            return
        }
        if (try? container.decode(Bool.self)) != nil
            || (try? container.decode(Int.self)) != nil
            || (try? container.decode(Double.self)) != nil
            || (try? container.decode(String.self)) != nil {
            return
        }
        if (try? container.decode([DiscardedValue].self)) != nil
            || (try? container.decode([String: DiscardedValue].self)) != nil {
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unsupported JSON value."
        )
    }
}
