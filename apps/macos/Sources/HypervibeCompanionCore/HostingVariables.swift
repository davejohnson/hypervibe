import Foundation

public struct HostingVariableTarget: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String { "\(environment)\u{0}\(service)" }

    public let environment: String
    public let service: String

    public init(environment: String, service: String) {
        self.environment = environment
        self.service = service
    }
}

public struct HostingVariableSummary: Codable, Equatable, Identifiable, Sendable {
    public var id: String { name }

    public let name: String
    public let maskedValue: String

    public init(name: String, maskedValue: String) {
        self.name = name
        self.maskedValue = maskedValue
    }
}

public struct HostingVariableCatalog: Codable, Equatable, Sendable {
    public let environment: String
    public let service: String
    public let variables: [HostingVariableSummary]

    public init(
        environment: String,
        service: String,
        variables: [HostingVariableSummary]
    ) {
        self.environment = environment
        self.service = service
        self.variables = variables
    }
}

public struct HostingVariableInventory: Equatable, Sendable {
    public let catalogs: [HostingVariableTarget: HostingVariableCatalog]
    public let failures: [HostingVariableTarget: String]

    public init(
        catalogs: [HostingVariableTarget: HostingVariableCatalog] = [:],
        failures: [HostingVariableTarget: String] = [:]
    ) {
        self.catalogs = catalogs
        self.failures = failures
    }

    public var keys: [String] {
        Array(Set(catalogs.values.flatMap { $0.variables.map(\.name) })).sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        }
    }

    public func variable(
        named name: String,
        at target: HostingVariableTarget
    ) -> HostingVariableSummary? {
        catalogs[target]?.variables.first { $0.name == name }
    }
}
