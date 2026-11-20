import Foundation

/// How urgently something needs the owner's attention, ordered so the worst
/// level of several is their maximum.
public enum StatusLevel: Int, Comparable, Sendable {
    case good
    case unknown
    case attention
    case down

    public static func < (lhs: StatusLevel, rhs: StatusLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

/// One thing that needs attention, in plain language, with a prompt the owner
/// can paste into their coding agent. Prompts contain names only.
public struct StatusIssue: Equatable, Identifiable, Sendable {
    public let id: String
    public let level: StatusLevel
    public let title: String
    public let chatPrompt: String?

    public init(id: String, level: StatusLevel, title: String, chatPrompt: String?) {
        self.id = id
        self.level = level
        self.title = title
        self.chatPrompt = chatPrompt
    }
}

public enum ChatPrompts {
    public static let starter =
        "Use Hypervibe to inspect this repository. Tell me what is configured, what you can verify from this Mac, and what I should do next."
}

public struct EnvironmentStatus: Equatable, Sendable {
    public let level: StatusLevel
    public let label: String
    public let issues: [StatusIssue]

    public static func evaluate(
        _ environment: EnvironmentSnapshot,
        projectName: String
    ) -> EnvironmentStatus {
        let name = environment.name
        let health = environment.observation?.health
        let checks = environment.publicEndpointHealth ?? []

        // A cached snapshot describes the last run of the app, not now.
        if health == .stale {
            return EnvironmentStatus(level: .unknown, label: "Not checked yet", issues: [])
        }

        var issues: [StatusIssue] = []
        var downServices = Set<String>()
        for check in checks where !check.ok {
            downServices.insert(check.service)
            let code = check.status.map { " (HTTP \($0))" } ?? ""
            issues.append(
                StatusIssue(
                    id: "\(name)|down|\(check.service)",
                    level: .down,
                    title: "\(check.service) is not responding in \(name)\(code)",
                    chatPrompt: "Use Hypervibe to find out why the \(check.service) service in the \(name) environment of \(projectName) is not responding\(code). Check its status and recent logs, tell me in plain language what went wrong, and suggest a fix."
                )
            )
        }
        for service in environment.observation?.services ?? []
        where service.status == .failed && !downServices.contains(service.name) {
            issues.append(
                StatusIssue(
                    id: "\(name)|failed|\(service.name)",
                    level: .down,
                    title: "\(service.name) failed in \(name)",
                    chatPrompt: "Use Hypervibe to find out why the \(service.name) service in the \(name) environment of \(projectName) failed. Check its status and recent logs, tell me in plain language what went wrong, and suggest a fix."
                )
            )
        }

        var label: String?
        if !issues.isEmpty {
            label = "Down"
        }

        for worker in environment.observation?.workers ?? [] where worker.needsAttention && health != .failed {
            // A failed workload is not a wake-up problem; say which one it is.
            if worker.workloadFailed {
                issues.append(StatusIssue(
                    id: "\(name)|worker|\(worker.service)", level: .attention,
                    title: "\(worker.service) has failed in \(name)",
                    chatPrompt: "Use Hypervibe to inspect the \(worker.service) worker in the \(name) environment of \(projectName). It has failed. Check its status and logs, then explain what needs fixing before making changes."
                ))
                label = label ?? "Worker failed"
            } else {
                issues.append(StatusIssue(
                    id: "\(name)|worker|\(worker.service)", level: .attention,
                    title: "\(worker.service)'s wake-up check needs attention in \(name)",
                    chatPrompt: "Use Hypervibe to inspect the \(worker.service) worker in the \(name) environment of \(projectName). Check its wake-up status and logs, then explain what needs fixing before making changes."
                ))
                label = label ?? "Worker needs attention"
            }
        }

        switch health {
        case .blocked:
            let providers = environment.observation?.blockedProviders ?? []
            let title = providers.isEmpty
                ? "\(name) is waiting for your input"
                : "Hypervibe needs access to \(providers.joined(separator: ", ")) to check \(name)"
            issues.append(
                StatusIssue(
                    id: "\(name)|blocked",
                    level: .attention,
                    title: title,
                    chatPrompt: "Use Hypervibe to check the \(name) environment of \(projectName). Something is blocking it. Tell me what access or input is missing and walk me through fixing it."
                )
            )
            label = label ?? (providers.isEmpty ? "Needs input" : "Needs access")
        case .failed:
            issues.append(
                StatusIssue(
                    id: "\(name)|check-failed",
                    level: .attention,
                    title: "Hypervibe couldn't check \(name)",
                    chatPrompt: "Use Hypervibe to check the status of the \(name) environment of \(projectName). The last check failed. Tell me why and what I should do."
                )
            )
            label = label ?? "Couldn't check"
        case .drifted:
            let count = max(environment.observation?.driftCount ?? 0, 1)
            issues.append(
                StatusIssue(
                    id: "\(name)|changes",
                    level: .attention,
                    title: "\(count) \(count == 1 ? "change is" : "changes are") waiting in \(name)",
                    chatPrompt: "Use Hypervibe to plan the \(name) environment of \(projectName). Explain in plain language what would change and why, then ask me before applying anything."
                )
            )
            label = label ?? "Changes waiting"
        default:
            break
        }

        if let label {
            return EnvironmentStatus(
                level: issues.map(\.level).max() ?? .attention,
                label: label,
                issues: issues
            )
        }

        // A public address that answered is live, whether or not this Mac has
        // the cloud access needed to compare settings.
        if !checks.isEmpty {
            return EnvironmentStatus(level: .good, label: "Live", issues: [])
        }
        guard health == .inSync else {
            return EnvironmentStatus(level: .unknown, label: environment.observation?.engine == "opentofu" ? "Drift not checked" : "Not checked", issues: [])
        }
        let services = environment.observation?.services ?? []
        if !services.isEmpty, services.allSatisfy({ $0.status == .empty }) {
            return EnvironmentStatus(level: .unknown, label: "Not deployed yet", issues: [])
        }
        return EnvironmentStatus(level: .good, label: "Up to date", issues: [])
    }
}

public struct ProjectStatus: Equatable, Sendable {
    public let level: StatusLevel
    public let headline: String
    public let detail: String?
    public let issues: [StatusIssue]
    /// Where the owner's app can be opened: production first.
    public let liveURL: URL?

    public static func evaluate(
        snapshot: ProjectSnapshot?,
        refreshError: String?,
        isInitialized: Bool
    ) -> ProjectStatus {
        guard let snapshot else {
            if let refreshError {
                return ProjectStatus(
                    level: .attention,
                    headline: "Couldn't check this project",
                    detail: refreshError,
                    issues: [],
                    liveURL: nil
                )
            }
            if !isInitialized {
                return ProjectStatus(
                    level: .unknown,
                    headline: "Ready for chat",
                    detail: "This project isn't set up yet. Restart your coding agent and ask it to set the project up with Hypervibe.",
                    issues: [],
                    liveURL: nil
                )
            }
            return ProjectStatus(
                level: .unknown,
                headline: "Not checked yet",
                detail: nil,
                issues: [],
                liveURL: nil
            )
        }

        let environments = snapshot.environments.map {
            EnvironmentStatus.evaluate($0, projectName: snapshot.projectName)
        }
        var issues = environments.flatMap(\.issues)
        if let refreshError {
            issues.append(
                StatusIssue(
                    id: "refresh-failed",
                    level: .attention,
                    title: "Couldn't refresh, so this is the last known status. \(refreshError)",
                    chatPrompt: nil
                )
            )
        }
        // Stable sort: worst first, otherwise environment order.
        issues = issues.enumerated()
            .sorted { ($0.element.level, $1.offset) > ($1.element.level, $0.offset) }
            .map(\.element)

        let liveURL = liveURL(in: snapshot)
        guard let worst = issues.first else {
            let headline: String
            let level: StatusLevel
            if environments.contains(where: { $0.label == "Live" }) {
                (level, headline) = (.good, "Everything is running")
            } else if environments.contains(where: { $0.level == .good }) {
                (level, headline) = (.good, "Everything is up to date")
            } else if !environments.isEmpty,
                environments.allSatisfy({ $0.label == "Not deployed yet" }) {
                (level, headline) = (.unknown, "Not deployed yet")
            } else {
                (level, headline) = (.unknown, "Not checked yet")
            }
            return ProjectStatus(
                level: level,
                headline: headline,
                detail: nil,
                issues: [],
                liveURL: liveURL
            )
        }

        let sameLevel = issues.filter { $0.level == worst.level }.count
        let headline: String
        if issues.count == 1 {
            headline = worst.title
        } else if worst.level == .down {
            headline = sameLevel == 1 ? "1 service is down" : "\(sameLevel) services are down"
        } else {
            headline = "\(issues.count) things need your attention"
        }
        return ProjectStatus(
            level: worst.level,
            headline: headline,
            detail: nil,
            issues: issues,
            liveURL: liveURL
        )
    }

    private static func liveURL(in snapshot: ProjectSnapshot) -> URL? {
        let ordered = snapshot.environments.filter(\.isProductionTarget)
            + snapshot.environments.filter { !$0.isProductionTarget }
        for environment in ordered {
            for resource in environment.resources where resource.kind == .service {
                if let url = environment.observation?
                    .service(named: resource.name)?
                    .preferredURL {
                    return url
                }
            }
        }
        return nil
    }
}

/// A change worth interrupting the owner for. Text contains names only.
public struct StatusNotice: Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let body: String

    public init(id: String, title: String, body: String) {
        self.id = id
        self.title = title
        self.body = body
    }
}

public enum StatusChanges {
    /// Public addresses that stopped or resumed responding between two checks.
    /// A first check has nothing to compare against and reports nothing.
    public static func notices(
        previous: ProjectSnapshot?,
        current: ProjectSnapshot
    ) -> [StatusNotice] {
        guard let previous else { return [] }
        var notices: [StatusNotice] = []
        for environment in current.environments {
            let earlier = previous.environments
                .first { $0.name == environment.name }?
                .publicEndpointHealth ?? []
            for check in environment.publicEndpointHealth ?? [] {
                guard let before = earlier.first(where: { $0.service == check.service }),
                    before.ok != check.ok else {
                    continue
                }
                let id = "\(current.projectID.uuidString)|\(environment.name)|\(check.service)"
                notices.append(
                    check.ok
                        ? StatusNotice(
                            id: id,
                            title: "\(current.projectName) is back up",
                            body: "\(check.service) in \(environment.name) is responding again."
                        )
                        : StatusNotice(
                            id: id,
                            title: "\(current.projectName) is down",
                            body: "\(check.service) in \(environment.name) stopped responding."
                        )
                )
            }
        }
        return notices
    }
}
