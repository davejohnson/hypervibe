import Foundation
import HypervibeCompanionCore
import ServiceManagement

@MainActor
enum CompanionLoginItemSystem {
    static let controller = CompanionLoginItemController(
        registration: SystemCompanionLoginItemRegistration()
    )
}

@MainActor
private final class SystemCompanionLoginItemRegistration: CompanionLoginItemRegistering {
    var status: CompanionLoginItemStatus {
        guard CompanionDistribution.canRegisterForLogin else {
            return .unavailable
        }

        switch SMAppService.mainApp.status {
        case .enabled:
            return .enabled
        case .notRegistered:
            return .disabled
        case .requiresApproval:
            return .requiresApproval
        case .notFound:
            return .unavailable
        @unknown default:
            return .unavailable
        }
    }

    func register() throws {
        guard CompanionDistribution.canRegisterForLogin else {
            throw CompanionLoginItemSystemError.unavailable
        }
        try SMAppService.mainApp.register()
    }

    func unregister() throws {
        guard CompanionDistribution.canRegisterForLogin else {
            throw CompanionLoginItemSystemError.unavailable
        }
        try SMAppService.mainApp.unregister()
    }
}

private enum CompanionLoginItemSystemError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        "Move Hypervibe to Applications and reopen it before enabling launch at login."
    }
}
