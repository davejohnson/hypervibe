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
                ? attemptedAt
                : previous?.latestSuccessfulAt
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
            latestSuccessfulAt: previous?.latestSuccessfulAt
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
        let envelope: ToolEnvelope<ConnectionsToolData> = try decodeEnvelope(data)
        guard let payload = envelope.data else {
            throw HypervibeClientError.malformedResponse(
                "hv_connections_list returned no data."
            )
        }

        return payload.connections
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
                message: envelope.error?.message ?? "Hypervibe returned an unknown error."
            )
        }
        return envelope
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
    let drift: CountedItems
    let unmanaged: CountedItems
    let blocked: [Block]
    let inputRequired: CountedItems

    private enum CodingKeys: String, CodingKey {
        case verified
        case inSync
        case drift
        case unmanaged
        case blocked
        case inputRequired
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        verified = try container.decode(Bool.self, forKey: .verified)
        inSync = try container.decode(Bool.self, forKey: .inSync)
        drift = try container.decodeIfPresent(CountedItems.self, forKey: .drift)
            ?? CountedItems()
        unmanaged = try container.decodeIfPresent(
            CountedItems.self,
            forKey: .unmanaged
        ) ?? CountedItems()
        blocked = try container.decodeIfPresent([Block].self, forKey: .blocked) ?? []
        inputRequired = try container.decodeIfPresent(
            CountedItems.self,
            forKey: .inputRequired
        ) ?? CountedItems()
    }

    struct Block: Decodable {
        let provider: String
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

    struct Connection: Decodable {
        let provider: String
        let scope: String
        let status: String
        let lastVerifiedAt: String?
    }
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
