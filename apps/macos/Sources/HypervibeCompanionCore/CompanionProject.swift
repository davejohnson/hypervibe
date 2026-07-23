import Foundation

public enum CompanionProjectReadiness: String, Codable, Equatable, Sendable {
    case unknown
    case uninitialized
    case initialized
}

public struct CompanionProject: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var displayName: String
    public var repositoryPath: String
    public var repositoryBookmark: Data?
    public var hypervibeExecutablePath: String
    public var hypervibeArguments: [String]?
    public var hypervibeDataDirectory: String?
    public var enabledEnvironments: [String]?
    public var scheduledRefreshEnabled: Bool
    public var refreshIntervalMinutes: Int
    public var lastSelectedEnvironment: String?
    public var readiness: CompanionProjectReadiness
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        displayName: String,
        repositoryPath: String,
        repositoryBookmark: Data? = nil,
        hypervibeExecutablePath: String,
        hypervibeArguments: [String]? = nil,
        hypervibeDataDirectory: String? = nil,
        enabledEnvironments: [String]? = nil,
        scheduledRefreshEnabled: Bool = false,
        refreshIntervalMinutes: Int = 30,
        lastSelectedEnvironment: String? = nil,
        readiness: CompanionProjectReadiness = .unknown,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.displayName = displayName
        self.repositoryPath = repositoryPath
        self.repositoryBookmark = repositoryBookmark
        self.hypervibeExecutablePath = hypervibeExecutablePath
        self.hypervibeArguments = hypervibeArguments
        self.hypervibeDataDirectory = hypervibeDataDirectory
        self.enabledEnvironments = enabledEnvironments
        self.scheduledRefreshEnabled = scheduledRefreshEnabled
        self.refreshIntervalMinutes = refreshIntervalMinutes
        self.lastSelectedEnvironment = lastSelectedEnvironment
        self.readiness = readiness
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case displayName
        case repositoryPath
        case repositoryBookmark
        case hypervibeExecutablePath
        case hypervibeArguments
        case hypervibeDataDirectory
        case enabledEnvironments
        case scheduledRefreshEnabled
        case refreshIntervalMinutes
        case lastSelectedEnvironment
        case readiness
        case createdAt
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        displayName = try container.decode(String.self, forKey: .displayName)
        repositoryPath = try container.decode(String.self, forKey: .repositoryPath)
        repositoryBookmark = try container.decodeIfPresent(Data.self, forKey: .repositoryBookmark)
        hypervibeExecutablePath = try container.decode(String.self, forKey: .hypervibeExecutablePath)
        hypervibeArguments = try container.decodeIfPresent([String].self, forKey: .hypervibeArguments)
        hypervibeDataDirectory = try container.decodeIfPresent(String.self, forKey: .hypervibeDataDirectory)
        enabledEnvironments = try container.decodeIfPresent([String].self, forKey: .enabledEnvironments)
        scheduledRefreshEnabled = try container.decode(Bool.self, forKey: .scheduledRefreshEnabled)
        refreshIntervalMinutes = try container.decode(Int.self, forKey: .refreshIntervalMinutes)
        lastSelectedEnvironment = try container.decodeIfPresent(String.self, forKey: .lastSelectedEnvironment)
        readiness = try container.decodeIfPresent(
            CompanionProjectReadiness.self,
            forKey: .readiness
        ) ?? .unknown
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }
}
