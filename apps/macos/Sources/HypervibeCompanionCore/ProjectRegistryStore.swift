import Foundation

public enum ProjectRegistryError: Error, Equatable {
    case invalidDisplayName
    case invalidRepositoryPath
    case invalidExecutablePath
    case invalidRefreshInterval
}

private struct ProjectRegistryDocument: Codable {
    let schemaVersion: Int
    var projects: [CompanionProject]
}

public actor ProjectRegistryStore {
    public static let schemaVersion = 1

    public let fileURL: URL
    private let fileManager: FileManager

    public init(fileURL: URL, fileManager: FileManager = .default) {
        self.fileURL = fileURL
        self.fileManager = fileManager
    }

    public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
        let root = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? fileManager.homeDirectoryForCurrentUser

        return root
            .appendingPathComponent("HypervibeCompanion", isDirectory: true)
            .appendingPathComponent("projects.json", isDirectory: false)
    }

    public func load() throws -> [CompanionProject] {
        guard fileManager.fileExists(atPath: fileURL.path) else {
            return []
        }

        let data = try Data(contentsOf: fileURL)
        let document = try Self.decoder.decode(ProjectRegistryDocument.self, from: data)
        return document.projects.sorted(by: Self.projectOrder)
    }

    @discardableResult
    public func upsert(_ project: CompanionProject) throws -> [CompanionProject] {
        try Self.validate(project)

        var projects = try load()
        if let index = projects.firstIndex(where: { $0.id == project.id }) {
            projects[index] = project
        } else {
            projects.append(project)
        }
        projects.sort(by: Self.projectOrder)
        try save(projects)
        return projects
    }

    @discardableResult
    public func remove(id: UUID) throws -> [CompanionProject] {
        let projects = try load().filter { $0.id != id }
        try save(projects)
        return projects
    }

    public func save(_ projects: [CompanionProject]) throws {
        for project in projects {
            try Self.validate(project)
        }

        let directory = fileURL.deletingLastPathComponent()
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let document = ProjectRegistryDocument(
            schemaVersion: Self.schemaVersion,
            projects: projects.sorted(by: Self.projectOrder)
        )
        let data = try Self.encoder.encode(document)
        try data.write(to: fileURL, options: .atomic)
    }

    private static func validate(_ project: CompanionProject) throws {
        if project.displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ProjectRegistryError.invalidDisplayName
        }
        if project.repositoryPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ProjectRegistryError.invalidRepositoryPath
        }
        if project.hypervibeExecutablePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ProjectRegistryError.invalidExecutablePath
        }
        if !(5...1_440).contains(project.refreshIntervalMinutes) {
            throw ProjectRegistryError.invalidRefreshInterval
        }
    }

    private static func projectOrder(
        _ lhs: CompanionProject,
        _ rhs: CompanionProject
    ) -> Bool {
        lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
