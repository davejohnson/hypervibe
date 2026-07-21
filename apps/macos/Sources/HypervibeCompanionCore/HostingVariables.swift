import Foundation
import MCP

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

public enum HostingVariableSource: Equatable, Sendable {
    case direct(String)
    case reference(String)
    case generated(length: Int?)
}

public struct HostingVariableRequest: Equatable, Sendable {
    public let environment: String
    public let service: String
    public let key: String
    public let source: HostingVariableSource

    public init(
        environment: String,
        service: String,
        key: String,
        source: HostingVariableSource
    ) {
        self.environment = environment
        self.service = service
        self.key = key
        self.source = source
    }

    func toolArguments(projectName: String) -> [String: Value] {
        var arguments: [String: Value] = [
            "project": .string(projectName),
            "env": .string(environment),
            "service": .string(service),
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
    public let environment: String
    public let service: String
    public let variables: [String]
    public let valueSource: String

    public init(
        environment: String,
        service: String,
        variables: [String],
        valueSource: String
    ) {
        self.environment = environment
        self.service = service
        self.variables = variables
        self.valueSource = valueSource
    }
}
