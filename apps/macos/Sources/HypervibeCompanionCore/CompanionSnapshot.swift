import Foundation

public enum EnvironmentHealth: String, Codable, Equatable, Sendable {
    case inSync
    case drifted
    case blocked
    case unverified
    case failed
    case stale
    case unknown
}

public enum ResourceKind: String, Codable, Equatable, Sendable {
    case service
    case database
    case storage
    case domain
    case queue
    case ci
    case ios
}

public enum RelationshipKind: String, Codable, Equatable, Sendable {
    case uses
    case injectsInto
    case dependsOn
}

public struct ResourceRelationship: Codable, Equatable, Sendable {
    public let kind: RelationshipKind
    public let targetResourceID: String

    public init(kind: RelationshipKind, targetResourceID: String) {
        self.kind = kind
        self.targetResourceID = targetResourceID
    }
}

public struct ResourceSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: ResourceKind
    public let name: String
    public let desiredProvider: String
    public let observedProvider: String?
    public let relationships: [ResourceRelationship]
    public let workloadKind: String?
    public let isPublic: Bool?
    public let healthCheckPath: String?
    public let boundURL: URL?

    public init(
        id: String,
        kind: ResourceKind,
        name: String,
        desiredProvider: String,
        observedProvider: String? = nil,
        relationships: [ResourceRelationship] = [],
        workloadKind: String? = nil,
        isPublic: Bool? = nil,
        healthCheckPath: String? = nil,
        boundURL: URL? = nil
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.desiredProvider = desiredProvider
        self.observedProvider = observedProvider
        self.relationships = relationships
        self.workloadKind = workloadKind
        self.isPublic = isPublic
        self.healthCheckPath = healthCheckPath
        self.boundURL = boundURL
    }
}

public struct PublicEndpointHealth: Codable, Equatable, Identifiable, Sendable {
    public var id: String { service }

    public let service: String
    public let url: URL
    public let ok: Bool
    public let status: Int?
    public let latencyMs: Int
    public let checkedAt: Date

    public init(
        service: String,
        url: URL,
        ok: Bool,
        status: Int?,
        latencyMs: Int,
        checkedAt: Date
    ) {
        self.service = service
        self.url = url
        self.ok = ok
        self.status = status
        self.latencyMs = latencyMs
        self.checkedAt = checkedAt
    }
}

public enum ServiceLiveStatus: String, Codable, Equatable, Sendable {
    case running
    case failed
    case empty
    case unknown
}

public struct ServiceObservation: Codable, Equatable, Sendable {
    public let name: String
    public let status: ServiceLiveStatus
    public let url: URL?
    public let customDomains: [String]

    public init(
        name: String,
        status: ServiceLiveStatus,
        url: URL?,
        customDomains: [String]
    ) {
        self.name = name
        self.status = status
        self.url = url
        self.customDomains = customDomains
    }

    /// Custom domain when one is attached, otherwise the provider URL.
    public var preferredURL: URL? {
        PublicServiceEndpoint.preferredURL(
            customDomains: customDomains,
            fallbackURL: url
        )
    }
}

public struct DriftedResource: Codable, Equatable, Sendable {
    public let kind: String
    public let name: String
    public let actionType: String
    public let provider: String

    public init(kind: String, name: String, actionType: String, provider: String) {
        self.kind = kind
        self.name = name
        self.actionType = actionType
        self.provider = provider
    }
}

public struct ObservationSummary: Codable, Equatable, Sendable {
    public let health: EnvironmentHealth
    public let verified: Bool
    public let driftCount: Int
    public let unmanagedCount: Int
    public let blockedProviders: [String]
    public let latestAttemptAt: Date
    public let latestSuccessfulAt: Date?
    // Optional so snapshots cached by older companion builds still decode.
    public let services: [ServiceObservation]?
    public let driftedResources: [DriftedResource]?

    public init(
        health: EnvironmentHealth,
        verified: Bool,
        driftCount: Int,
        unmanagedCount: Int,
        blockedProviders: [String],
        latestAttemptAt: Date,
        latestSuccessfulAt: Date?,
        services: [ServiceObservation]? = nil,
        driftedResources: [DriftedResource]? = nil
    ) {
        self.health = health
        self.verified = verified
        self.driftCount = driftCount
        self.unmanagedCount = unmanagedCount
        self.blockedProviders = blockedProviders
        self.latestAttemptAt = latestAttemptAt
        self.latestSuccessfulAt = latestSuccessfulAt
        self.services = services
        self.driftedResources = driftedResources
    }

    public func service(named name: String) -> ServiceObservation? {
        services?.first { $0.name == name }
    }

    public func driftedResource(matching resource: ResourceSummary) -> DriftedResource? {
        guard let driftedResources else { return nil }
        if let exactMatch = driftedResources.first(where: {
            $0.kind == resource.kind.rawValue && $0.name == resource.name
        }) {
            return exactMatch
        }

        // These desired-state rows are singletons, while hv_status actions use
        // provider-specific names such as the database engine or CI workflow.
        switch resource.kind {
        case .database, .ci, .ios:
            return driftedResources.first { $0.kind == resource.kind.rawValue }
        default:
            return nil
        }
    }
}

public enum AggregateHealth {
    public static func needsAttention(
        snapshots: [ProjectSnapshot],
        hasRefreshFailure: Bool
    ) -> Bool {
        if hasRefreshFailure { return true }
        return snapshots.contains { snapshot in
            snapshot.environments.contains { environment in
                if environment.publicEndpointHealth?.contains(where: { !$0.ok }) == true {
                    return true
                }
                switch environment.observation?.health {
                case .drifted, .blocked, .failed:
                    return true
                default:
                    return false
                }
            }
        }
    }
}

public struct EnvironmentSnapshot: Codable, Equatable, Identifiable, Sendable {
    public var id: String { name }

    public let name: String
    public let specRevision: Int
    public let resources: [ResourceSummary]
    public let observation: ObservationSummary?
    public let publicEndpointHealth: [PublicEndpointHealth]?

    public init(
        name: String,
        specRevision: Int,
        resources: [ResourceSummary],
        observation: ObservationSummary?,
        publicEndpointHealth: [PublicEndpointHealth]? = nil
    ) {
        self.name = name
        self.specRevision = specRevision
        self.resources = resources
        self.observation = observation
        self.publicEndpointHealth = publicEndpointHealth
    }
}

public enum RecentRunStatus: String, Codable, Equatable, Sendable {
    case pending
    case running
    case succeeded
    case failed
    case blocked
    case cancelled
    case unknown
}

public enum ConnectionStatus: String, Equatable, Sendable {
    case pending
    case verified
    case failed
    case unknown
}

public struct ConnectionSummary: Equatable, Identifiable, Sendable {
    public var id: String { "\(provider)|\(scope)" }

    public let provider: String
    public let scope: String
    public let status: ConnectionStatus
    public let lastVerifiedAt: Date?

    public init(
        provider: String,
        scope: String,
        status: ConnectionStatus,
        lastVerifiedAt: Date?
    ) {
        self.provider = provider
        self.scope = scope
        self.status = status
        self.lastVerifiedAt = lastVerifiedAt
    }
}

public struct CompanionRefresh: Equatable, Sendable {
    public let snapshot: ProjectSnapshot
    public let connections: [ConnectionSummary]

    public init(
        snapshot: ProjectSnapshot,
        connections: [ConnectionSummary]
    ) {
        self.snapshot = snapshot
        self.connections = connections
    }
}

public struct RecentRunSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let environment: String?
    public let type: String
    public let status: RecentRunStatus
    public let startedAt: Date?
    public let completedAt: Date?

    public init(
        id: String,
        environment: String?,
        type: String,
        status: RecentRunStatus,
        startedAt: Date?,
        completedAt: Date?
    ) {
        self.id = id
        self.environment = environment
        self.type = type
        self.status = status
        self.startedAt = startedAt
        self.completedAt = completedAt
    }
}

public struct ProjectSnapshot: Codable, Equatable, Sendable {
    public static let schemaVersion = 1

    public let projectID: UUID
    public let projectName: String
    public let generatedAt: Date
    public let environments: [EnvironmentSnapshot]
    public let recentRuns: [RecentRunSummary]
    public let github: GitHubInfrastructureSummary?

    public init(
        projectID: UUID,
        projectName: String,
        generatedAt: Date,
        environments: [EnvironmentSnapshot],
        recentRuns: [RecentRunSummary],
        github: GitHubInfrastructureSummary? = nil
    ) {
        self.projectID = projectID
        self.projectName = projectName
        self.generatedAt = generatedAt
        self.environments = environments
        self.recentRuns = recentRuns
        self.github = github
    }

    public func markingObservationsStale() -> ProjectSnapshot {
        ProjectSnapshot(
            projectID: projectID,
            projectName: projectName,
            generatedAt: generatedAt,
            environments: environments.map { environment in
                guard let observation = environment.observation else {
                    return environment
                }
                return EnvironmentSnapshot(
                    name: environment.name,
                    specRevision: environment.specRevision,
                    resources: environment.resources,
                    observation: ObservationSummary(
                        health: .stale,
                        verified: observation.verified,
                        driftCount: observation.driftCount,
                        unmanagedCount: observation.unmanagedCount,
                        blockedProviders: observation.blockedProviders,
                        latestAttemptAt: observation.latestAttemptAt,
                        latestSuccessfulAt: observation.latestSuccessfulAt,
                        services: observation.services,
                        driftedResources: observation.driftedResources
                    ),
                    publicEndpointHealth: environment.publicEndpointHealth
                )
            },
            recentRuns: recentRuns,
            github: github
        )
    }
}

public struct GitHubAutomationSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let enabled: Bool
    public let cron: String?
    public let timezone: String?
    public let requiresOpenAI: Bool

    public init(
        id: String,
        kind: String,
        enabled: Bool,
        cron: String?,
        timezone: String?,
        requiresOpenAI: Bool
    ) {
        self.id = id
        self.kind = kind
        self.enabled = enabled
        self.cron = cron
        self.timezone = timezone
        self.requiresOpenAI = requiresOpenAI
    }
}

public struct GitHubInfrastructureSummary: Codable, Equatable, Sendable {
    public let repository: String?
    public let canonicalEnvironment: String?
    public let automations: [GitHubAutomationSummary]
    public let dependencyFeatures: [String]
    public let securityFeatures: [String]

    public init(
        repository: String?,
        canonicalEnvironment: String?,
        automations: [GitHubAutomationSummary],
        dependencyFeatures: [String],
        securityFeatures: [String]
    ) {
        self.repository = repository
        self.canonicalEnvironment = canonicalEnvironment
        self.automations = automations
        self.dependencyFeatures = dependencyFeatures
        self.securityFeatures = securityFeatures
    }
}
