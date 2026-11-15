import Foundation
import MCP

public enum CredentialInputKind: String, Equatable, Sendable {
    case text
    case secret
    case multilineSecret
    case choice
}

public struct CredentialField: Equatable, Identifiable, Sendable {
    public var id: String { name }

    public let name: String
    public let label: String
    public let required: Bool
    public let sensitive: Bool
    public let inputKind: CredentialInputKind
    public let options: [String]
    public let description: String?

    public init(
        name: String,
        label: String,
        required: Bool,
        sensitive: Bool,
        inputKind: CredentialInputKind,
        options: [String] = [],
        description: String? = nil
    ) {
        self.name = name
        self.label = label
        self.required = required
        self.sensitive = sensitive
        self.inputKind = inputKind
        self.options = options
        self.description = description
    }
}

public struct ProviderSetupLink: Equatable, Identifiable, Sendable {
    public var id: String { url.absoluteString }

    public let label: String
    public let url: URL

    public init(label: String, url: URL) {
        self.label = label
        self.url = url
    }
}

public struct ProviderCatalogEntry: Equatable, Identifiable, Sendable {
    public var id: String { name }

    public let name: String
    public let displayName: String
    public let category: String
    public let setupLinks: [ProviderSetupLink]
    public let tokenType: String?
    public let requiredPermissions: [String]
    public let notes: [String]
    public let credentialFields: [CredentialField]?
    public let defaultScalarKey: String?
    public let bootstrap: ProviderBootstrap?
    public let localSetup: ProviderLocalSetup?
    public var requiresAgentSetup: Bool { bootstrap != nil || localSetup != nil }

    public init(
        name: String,
        displayName: String,
        category: String,
        setupLinks: [ProviderSetupLink] = [],
        tokenType: String? = nil,
        requiredPermissions: [String] = [],
        notes: [String] = [],
        credentialFields: [CredentialField]? = nil,
        defaultScalarKey: String? = nil,
        bootstrap: ProviderBootstrap? = nil,
        localSetup: ProviderLocalSetup? = nil
    ) {
        self.name = name
        self.displayName = displayName
        self.category = category
        self.setupLinks = setupLinks
        self.tokenType = tokenType
        self.requiredPermissions = requiredPermissions
        self.notes = notes
        self.credentialFields = credentialFields
        self.defaultScalarKey = defaultScalarKey
        self.bootstrap = bootstrap
        self.localSetup = localSetup
    }
}

public struct ProviderBootstrap: Equatable, Sendable, Decodable {
    public let provider: String
    public let action: String
    public let adminAuth: String
}

public struct ProviderLocalSetup: Equatable, Sendable, Decodable {
    public let cloud: String
    public let connectionAction: String
}

public struct ConnectionGuidance: Equatable, Sendable {
    public let provider: ProviderCatalogEntry
    public let recommendedSetupURL: URL?
    public let credentialExample: String
    public let projectName: String?
    public let scope: String?

    public var agentSetupPrompt: String {
        var prompt = "Use Hypervibe to help me connect \(provider.displayName) for this repository."
        if let projectName { prompt += " The existing Hypervibe project is \(projectName)." }
        if let scope { prompt += " Use connection scope \(scope)." }
        prompt += " Follow its provider-owned bootstrap or local sign-in setup. Reuse verified access, show the concrete plan before consequential approvals, and leave browser consent and billing choices to me. Do not ask me to create cloud projects or generated credentials manually."
        return prompt
    }
}

public struct ConnectionCatalog: Equatable, Sendable {
    public let connections: [ConnectionSummary]
    public let providers: [ProviderCatalogEntry]

    public init(
        connections: [ConnectionSummary],
        providers: [ProviderCatalogEntry]
    ) {
        self.connections = connections
        self.providers = providers
    }
}

public enum ConnectionCredentialSource: Equatable, Sendable {
    case direct([String: String])
    case reference(value: String, credentialKey: String?)
}

public struct ConnectionRequest: Equatable, Sendable {
    public let provider: String
    public let source: ConnectionCredentialSource
    public let scope: String?

    public init(
        provider: String,
        source: ConnectionCredentialSource,
        scope: String? = nil
    ) {
        self.provider = provider
        self.source = source
        self.scope = scope
    }

    func toolArguments() -> [String: Value] {
        var arguments: [String: Value] = [
            "provider": .string(provider),
            "action": .string("add"),
        ]
        if let scope = scope?.trimmingCharacters(in: .whitespacesAndNewlines),
            !scope.isEmpty,
            scope.caseInsensitiveCompare("global") != .orderedSame {
            arguments["scope"] = .string(scope)
        }
        switch source {
        case .direct(let credentials):
            arguments["credentials"] = .object(
                credentials.reduce(into: [:]) { result, entry in
                    result[entry.key] = .string(entry.value)
                }
            )
        case .reference(let value, let credentialKey):
            arguments["credentialsRef"] = .string(value)
            if let credentialKey = credentialKey?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !credentialKey.isEmpty {
                arguments["credentialsKey"] = .string(credentialKey)
            }
        }
        return arguments
    }
}

public struct ConnectionMutationResult: Equatable, Sendable {
    public let provider: String
    public let scope: String
    public let status: ConnectionStatus
    public let message: String
    public let identity: String?
    public let warnings: [String]
    public let removed: Bool

    public init(
        provider: String,
        scope: String,
        status: ConnectionStatus,
        message: String,
        identity: String? = nil,
        warnings: [String] = [],
        removed: Bool = false
    ) {
        self.provider = provider
        self.scope = scope
        self.status = status
        self.message = message
        self.identity = identity
        self.warnings = warnings
        self.removed = removed
    }
}
