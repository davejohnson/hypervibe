import Foundation

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
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
