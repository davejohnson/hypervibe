import Foundation

public struct DeploymentConfiguration: Codable, Equatable, Sendable {
    public let strategy: String
    public let trigger: String?
    public let branch: String?
    public let autoDeploy: Bool?
    public let promoteFrom: String?

    public init(
        strategy: String,
        trigger: String? = nil,
        branch: String? = nil,
        autoDeploy: Bool? = nil,
        promoteFrom: String? = nil
    ) {
        self.strategy = strategy
        self.trigger = trigger
        self.branch = branch
        self.autoDeploy = autoDeploy
        self.promoteFrom = promoteFrom
    }

    public var usesManagedCI: Bool {
        strategy == "branch" && (trigger ?? "ci") == "ci"
    }
}

public enum ProductionDeploymentMechanism: String, Equatable, Sendable {
    case direct
    case managedCI
}

public struct CIDefinitionSummary: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let path: String?
    public let state: String

    public init(id: String, name: String, path: String?, state: String) {
        self.id = id
        self.name = name
        self.path = path
        self.state = state
    }

    public var displayName: String {
        if let path, path != name {
            return "\(name) — \(path)"
        }
        return name
    }

    public func isExplicitlyScoped(to environment: String) -> Bool {
        [id, name, path]
            .compactMap { $0?.lowercased() }
            .contains { $0.contains(environment.lowercased()) }
    }
}

public struct ProductionDeploymentPreparation: Equatable, Sendable {
    public let mechanism: ProductionDeploymentMechanism
    public let environment: String
    public let specRevision: Int
    public let branch: String
    public let definitions: [CIDefinitionSummary]
    public let requiresExactRefSHA: Bool

    public init(
        mechanism: ProductionDeploymentMechanism,
        environment: String,
        specRevision: Int,
        branch: String,
        definitions: [CIDefinitionSummary] = [],
        requiresExactRefSHA: Bool = false
    ) {
        self.mechanism = mechanism
        self.environment = environment
        self.specRevision = specRevision
        self.branch = branch
        self.definitions = definitions
        self.requiresExactRefSHA = requiresExactRefSHA
    }

    public var eligibleDefinitions: [CIDefinitionSummary] {
        let active = definitions.filter {
            $0.state.caseInsensitiveCompare("active") == .orderedSame
        }
        let environmentMatches = active.filter {
            $0.isExplicitlyScoped(to: environment)
        }
        if !environmentMatches.isEmpty {
            return environmentMatches
        }
        if definitions.count == 1, active.count == 1 {
            return active
        }
        return []
    }

    public func suggestedDefinitionID() -> String? {
        let eligible = eligibleDefinitions
        if eligible.count == 1 {
            return eligible[0].id
        }
        return nil
    }
}

public struct ProductionDeploymentResult: Equatable, Sendable {
    public let status: String
    public let message: String
    public let runID: String?
    public let planID: String?
    public let applyRunID: String?
    public let webURL: URL?

    public init(
        status: String,
        message: String,
        runID: String? = nil,
        planID: String? = nil,
        applyRunID: String? = nil,
        webURL: URL? = nil
    ) {
        self.status = status
        self.message = message
        self.runID = runID
        self.planID = planID
        self.applyRunID = applyRunID
        self.webURL = webURL
    }
}
