import Darwin
import Foundation

private enum LauncherError: LocalizedError {
    case missingValue(String)
    case invalidProjectRoot(String)
    case invalidDataDirectory(String)
    case missingBundledRuntime(String)
    case missingBundledServer(String)
    case cannotChangeDirectory(String)

    var errorDescription: String? {
        switch self {
        case .missingValue(let option):
            return "\(option) requires a value."
        case .invalidProjectRoot(let path):
            return "Project root is not an absolute directory: \(path)"
        case .invalidDataDirectory(let path):
            return "Hypervibe data directory must be absolute: \(path)"
        case .missingBundledRuntime(let path):
            return "Bundled Node runtime is missing or not executable: \(path)"
        case .missingBundledServer(let path):
            return "Bundled Hypervibe server is missing: \(path)"
        case .cannotChangeDirectory(let path):
            return "Could not start Hypervibe in project directory: \(path)"
        }
    }
}

private struct LaunchConfiguration {
    let projectRoot: String?
    let dataDirectory: String?
    let serverArguments: [String]

    static func parse(_ arguments: [String]) throws -> LaunchConfiguration {
        var projectRoot: String?
        var dataDirectory: String?
        var serverArguments: [String] = []
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--project-root", "--data-dir":
                let valueIndex = index + 1
                guard valueIndex < arguments.count else {
                    throw LauncherError.missingValue(argument)
                }
                if argument == "--project-root" {
                    projectRoot = arguments[valueIndex]
                } else {
                    dataDirectory = arguments[valueIndex]
                }
                index += 2
            case "--":
                serverArguments.append(contentsOf: arguments.dropFirst(index + 1))
                index = arguments.count
            default:
                serverArguments.append(argument)
                index += 1
            }
        }

        return LaunchConfiguration(
            projectRoot: projectRoot,
            dataDirectory: dataDirectory,
            serverArguments: serverArguments
        )
    }
}

private func bundledPath(
    environmentKey: String,
    relativeToResources relativePath: String
) -> String {
    if let override = ProcessInfo.processInfo.environment[environmentKey],
        !override.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return URL(fileURLWithPath: override).standardizedFileURL.path
    }
    return Bundle.main.resourceURL?
        .appendingPathComponent(relativePath)
        .standardizedFileURL.path ?? ""
}

private func run() throws -> Never {
    let configuration = try LaunchConfiguration.parse(
        Array(CommandLine.arguments.dropFirst())
    )
    let fileManager = FileManager.default

    if let projectRoot = configuration.projectRoot {
        var isDirectory: ObjCBool = false
        guard projectRoot.hasPrefix("/"),
            fileManager.fileExists(atPath: projectRoot, isDirectory: &isDirectory),
            isDirectory.boolValue else {
            throw LauncherError.invalidProjectRoot(projectRoot)
        }
        guard fileManager.changeCurrentDirectoryPath(projectRoot) else {
            throw LauncherError.cannotChangeDirectory(projectRoot)
        }
    }

    if let dataDirectory = configuration.dataDirectory {
        guard dataDirectory.hasPrefix("/") else {
            throw LauncherError.invalidDataDirectory(dataDirectory)
        }
        setenv("HYPERVIBE_DATA_DIR", dataDirectory, 1)
    }

    let nodePath = bundledPath(
        environmentKey: "HYPERVIBE_BUNDLED_NODE",
        relativeToResources: "runtime/node"
    )
    let serverPath = bundledPath(
        environmentKey: "HYPERVIBE_BUNDLED_SERVER",
        relativeToResources: "server/dist/index.js"
    )

    guard fileManager.isExecutableFile(atPath: nodePath) else {
        throw LauncherError.missingBundledRuntime(nodePath)
    }
    guard fileManager.fileExists(atPath: serverPath) else {
        throw LauncherError.missingBundledServer(serverPath)
    }

    let arguments = [nodePath, serverPath] + configuration.serverArguments
    var cArguments = arguments.map { strdup($0) }
    cArguments.append(nil)
    defer {
        for argument in cArguments where argument != nil {
            free(argument)
        }
    }

    execv(nodePath, &cArguments)
    let message = String(cString: strerror(errno))
    throw LauncherError.missingBundledRuntime("\(nodePath) (\(message))")
}

do {
    try run()
} catch {
    let message = (error as? LocalizedError)?.errorDescription
        ?? "Hypervibe MCP launcher failed."
    FileHandle.standardError.write(Data("hypervibe-mcp: \(message)\n".utf8))
    exit(127)
}
