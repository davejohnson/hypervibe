import Foundation

private struct SnapshotCacheDocument: Codable {
    let schemaVersion: Int
    var snapshots: [ProjectSnapshot]
}

public actor SnapshotCache {
    public static let schemaVersion = 1

    public let fileURL: URL
    private let fileManager: FileManager

    public init(fileURL: URL, fileManager: FileManager = .default) {
        self.fileURL = fileURL
        self.fileManager = fileManager
    }

    public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
        ProjectRegistryStore.defaultFileURL(fileManager: fileManager)
            .deletingLastPathComponent()
            .appendingPathComponent("snapshots.json", isDirectory: false)
    }

    public func load() throws -> [ProjectSnapshot] {
        guard fileManager.fileExists(atPath: fileURL.path) else {
            return []
        }

        let data = try Data(contentsOf: fileURL)
        let document = try Self.decoder.decode(SnapshotCacheDocument.self, from: data)
        guard document.schemaVersion == Self.schemaVersion else {
            return []
        }
        return document.snapshots
    }

    public func snapshot(for projectID: UUID) throws -> ProjectSnapshot? {
        try load().first { $0.projectID == projectID }
    }

    public func replace(_ snapshot: ProjectSnapshot) throws {
        var snapshots = try load()
        snapshots.removeAll { $0.projectID == snapshot.projectID }
        snapshots.append(snapshot)
        try save(snapshots)
    }

    public func remove(projectID: UUID) throws {
        try save(try load().filter { $0.projectID != projectID })
    }

    public func removeAll() throws {
        guard fileManager.fileExists(atPath: fileURL.path) else {
            return
        }
        try fileManager.removeItem(at: fileURL)
    }

    private func save(_ snapshots: [ProjectSnapshot]) throws {
        let directory = fileURL.deletingLastPathComponent()
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let document = SnapshotCacheDocument(
            schemaVersion: Self.schemaVersion,
            snapshots: snapshots.sorted {
                $0.projectName.localizedCaseInsensitiveCompare($1.projectName) == .orderedAscending
            }
        )
        let data = try Self.encoder.encode(document)
        try data.write(to: fileURL, options: .atomic)
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
