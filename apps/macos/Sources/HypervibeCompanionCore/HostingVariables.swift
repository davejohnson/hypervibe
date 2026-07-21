import Foundation
import MCP

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

public enum HostingVariableSource: Equatable, Sendable {
    case direct(String)
    case reference(String)
    case generated(length: Int?)
}

public struct HostingVariableRequest: Equatable, Sendable {
    public let destinations: [HostingVariableTarget]
    public let key: String
    public let source: HostingVariableSource

    public init(
        destinations: [HostingVariableTarget],
        key: String,
        source: HostingVariableSource
    ) {
        self.destinations = destinations
        self.key = key
        self.source = source
    }

    func toolArguments(projectName: String) -> [String: Value] {
        var arguments: [String: Value] = [
            "project": .string(projectName),
            "destinations": .array(destinations.map { destination in
                .object([
                    "env": .string(destination.environment),
                    "service": .string(destination.service),
                ])
            }),
            "target": .string("hosting"),
            "key": .string(key.trimmingCharacters(in: .whitespacesAndNewlines)),
        ]
        switch source {
        case .direct(let value):
            arguments["value"] = .string(value)
        case .reference(let reference):
            arguments["secretRef"] = .string(
                reference.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        case .generated(let length):
            arguments["generate"] = true
            if let length {
                arguments["generateLength"] = .int(length)
            }
        }
        return arguments
    }
}

public struct HostingVariableMutationResult: Codable, Equatable, Sendable {
    public let destinations: [HostingVariableTarget]
    public let variables: [String]
    public let valueSource: String

    public init(
        destinations: [HostingVariableTarget],
        variables: [String],
        valueSource: String
    ) {
        self.destinations = destinations
        self.variables = variables
        self.valueSource = valueSource
    }
}
