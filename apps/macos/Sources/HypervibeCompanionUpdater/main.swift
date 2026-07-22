import Darwin
import Foundation

private enum UpdaterExit: Int32 {
    case invalidArguments = 2
    case appDidNotExit = 3
    case replacementFailed = 4
    case relaunchFailed = 5
}

private enum UpdaterError: Error {
    case relaunchFailed
}

private func stop(_ reason: UpdaterExit) -> Never {
    Darwin.exit(reason.rawValue)
}

guard CommandLine.arguments.count == 5,
    let processIdentifier = Int32(CommandLine.arguments[1]) else {
    stop(.invalidArguments)
}

let fileManager = FileManager.default
let currentURL = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
let stagedURL = URL(fileURLWithPath: CommandLine.arguments[3]).standardizedFileURL
let expectedVersion = CommandLine.arguments[4]
let parentURL = currentURL.deletingLastPathComponent()
let path = currentURL.path
let userApplications = fileManager.homeDirectoryForCurrentUser
    .appendingPathComponent("Applications", isDirectory: true)
    .standardizedFileURL.path + "/"

guard !expectedVersion.isEmpty,
    currentURL.pathExtension == "app",
    currentURL.lastPathComponent == "Hypervibe.app",
    path.hasPrefix("/Applications/") || path.hasPrefix(userApplications),
    stagedURL.pathExtension == "app",
    stagedURL.deletingLastPathComponent() == parentURL,
    stagedURL.lastPathComponent.hasPrefix(".Hypervibe-update-"),
    let currentBundle = Bundle(url: currentURL),
    let stagedBundle = Bundle(url: stagedURL),
    currentBundle.bundleIdentifier == "com.hypervibe.companion",
    stagedBundle.bundleIdentifier == currentBundle.bundleIdentifier,
    stagedBundle.object(
        forInfoDictionaryKey: "CFBundleShortVersionString"
    ) as? String == expectedVersion else {
    stop(.invalidArguments)
}

for _ in 0..<300 {
    if kill(processIdentifier, 0) != 0 {
        break
    }
    usleep(100_000)
}
guard kill(processIdentifier, 0) != 0 else {
    try? fileManager.removeItem(at: stagedURL)
    stop(.appDidNotExit)
}

let verifyProcess = Process()
verifyProcess.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
verifyProcess.arguments = ["--verify", "--deep", "--strict", stagedURL.path]
verifyProcess.standardOutput = FileHandle.nullDevice
verifyProcess.standardError = FileHandle.nullDevice
do {
    try verifyProcess.run()
    verifyProcess.waitUntilExit()
    guard verifyProcess.terminationStatus == 0 else {
        try? fileManager.removeItem(at: stagedURL)
        stop(.invalidArguments)
    }
} catch {
    try? fileManager.removeItem(at: stagedURL)
    stop(.invalidArguments)
}

let backupURL = parentURL.appendingPathComponent(
    ".Hypervibe-previous-\(UUID().uuidString).app",
    isDirectory: true
)

do {
    try fileManager.moveItem(at: currentURL, to: backupURL)
    do {
        try fileManager.moveItem(at: stagedURL, to: currentURL)
    } catch {
        try? fileManager.moveItem(at: backupURL, to: currentURL)
        stop(.replacementFailed)
    }
} catch {
    try? fileManager.removeItem(at: stagedURL)
    stop(.replacementFailed)
}

let openProcess = Process()
openProcess.executableURL = URL(fileURLWithPath: "/usr/bin/open")
openProcess.arguments = [currentURL.path]
openProcess.standardOutput = FileHandle.nullDevice
openProcess.standardError = FileHandle.nullDevice

do {
    try openProcess.run()
    openProcess.waitUntilExit()
    guard openProcess.terminationStatus == 0 else {
        throw UpdaterError.relaunchFailed
    }
} catch {
    try? fileManager.removeItem(at: currentURL)
    try? fileManager.moveItem(at: backupURL, to: currentURL)
    stop(.relaunchFailed)
}

try? fileManager.removeItem(at: backupURL)
