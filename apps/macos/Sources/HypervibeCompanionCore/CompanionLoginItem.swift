import Combine
import Foundation

public enum CompanionLoginItemStatus: Equatable, Sendable {
    case enabled
    case disabled
    case requiresApproval
    case unavailable
}

@MainActor
public protocol CompanionLoginItemRegistering: AnyObject {
    var status: CompanionLoginItemStatus { get }
    func register() throws
    func unregister() throws
}

@MainActor
public final class CompanionLoginItemController: ObservableObject {
    @Published public private(set) var status: CompanionLoginItemStatus
    @Published public private(set) var errorMessage: String?

    private let registration: any CompanionLoginItemRegistering
    private let defaults: UserDefaults
    private let didConfigureKey: String

    public init(
        registration: any CompanionLoginItemRegistering,
        defaults: UserDefaults = .standard,
        didConfigureKey: String = "companion.didConfigureLaunchAtLogin"
    ) {
        self.registration = registration
        self.defaults = defaults
        self.didConfigureKey = didConfigureKey
        self.status = registration.status
    }

    public var isEnabled: Bool {
        status == .enabled || status == .requiresApproval
    }

    public func configureOnFirstLaunch() {
        refresh()
        guard defaults.object(forKey: didConfigureKey) == nil else { return }
        guard status != .unavailable else { return }

        do {
            if !isEnabled {
                try registration.register()
            }
            defaults.set(true, forKey: didConfigureKey)
            errorMessage = nil
            refresh()
        } catch {
            errorMessage = error.localizedDescription
            refresh()
        }
    }

    public func setEnabled(_ enabled: Bool) {
        errorMessage = nil
        refresh()

        guard status != .unavailable else {
            errorMessage = "Move Hypervibe to Applications and reopen it before enabling launch at login."
            return
        }

        do {
            if enabled && !isEnabled {
                try registration.register()
            } else if !enabled && isEnabled {
                try registration.unregister()
            }
            defaults.set(true, forKey: didConfigureKey)
            refresh()
        } catch {
            errorMessage = error.localizedDescription
            refresh()
        }
    }

    public func refresh() {
        status = registration.status
    }
}
