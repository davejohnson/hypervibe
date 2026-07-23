import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite(.serialized)
@MainActor
struct CompanionLoginItemTests {
    @Test
    func firstLaunchRegistersOnceByDefault() throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }

        fixture.controller.configureOnFirstLaunch()
        fixture.controller.configureOnFirstLaunch()

        #expect(fixture.registration.registerCount == 1)
        #expect(fixture.controller.status == .enabled)
        #expect(fixture.controller.isEnabled)
    }

    @Test
    func userOptOutIsNotReversedOnTheNextLaunch() throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }

        fixture.controller.configureOnFirstLaunch()
        fixture.controller.setEnabled(false)
        let nextLaunch = CompanionLoginItemController(
            registration: fixture.registration,
            defaults: fixture.defaults,
            didConfigureKey: fixture.didConfigureKey
        )
        nextLaunch.configureOnFirstLaunch()

        #expect(fixture.registration.registerCount == 1)
        #expect(fixture.registration.unregisterCount == 1)
        #expect(nextLaunch.status == .disabled)
        #expect(!nextLaunch.isEnabled)
    }

    @Test
    func unavailableDevelopmentBuildRetriesWhenItBecomesInstallable() throws {
        let fixture = try Fixture(status: .unavailable)
        defer { fixture.cleanup() }

        fixture.controller.configureOnFirstLaunch()
        #expect(fixture.registration.registerCount == 0)

        fixture.registration.status = .disabled
        fixture.controller.configureOnFirstLaunch()

        #expect(fixture.registration.registerCount == 1)
        #expect(fixture.controller.status == .enabled)
    }

    @Test
    func approvalRequiredIsPresentedAsRegistered() throws {
        let fixture = try Fixture(status: .requiresApproval)
        defer { fixture.cleanup() }

        fixture.controller.configureOnFirstLaunch()

        #expect(fixture.registration.registerCount == 0)
        #expect(fixture.controller.status == .requiresApproval)
        #expect(fixture.controller.isEnabled)
    }

    @Test
    func registrationFailureIsReportedAndCanRetry() throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        fixture.registration.registerError = TestRegistrationError.denied

        fixture.controller.configureOnFirstLaunch()
        #expect(fixture.controller.errorMessage == "Registration denied for testing.")
        #expect(fixture.registration.registerCount == 1)

        fixture.registration.registerError = nil
        fixture.controller.configureOnFirstLaunch()

        #expect(fixture.registration.registerCount == 2)
        #expect(fixture.controller.errorMessage == nil)
        #expect(fixture.controller.status == .enabled)
    }
}

@MainActor
private final class Fixture {
    let registration: FakeLoginItemRegistration
    let defaults: UserDefaults
    let didConfigureKey: String
    let suiteName: String
    let controller: CompanionLoginItemController

    init(status: CompanionLoginItemStatus = .disabled) throws {
        suiteName = "CompanionLoginItemTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            throw FixtureError.defaultsUnavailable
        }
        self.defaults = defaults
        didConfigureKey = "didConfigure"
        registration = FakeLoginItemRegistration(status: status)
        controller = CompanionLoginItemController(
            registration: registration,
            defaults: defaults,
            didConfigureKey: didConfigureKey
        )
    }

    func cleanup() {
        defaults.removePersistentDomain(forName: suiteName)
    }
}

@MainActor
private final class FakeLoginItemRegistration: CompanionLoginItemRegistering {
    var status: CompanionLoginItemStatus
    var registerError: Error?
    var unregisterError: Error?
    private(set) var registerCount = 0
    private(set) var unregisterCount = 0

    init(status: CompanionLoginItemStatus) {
        self.status = status
    }

    func register() throws {
        registerCount += 1
        if let registerError {
            throw registerError
        }
        status = .enabled
    }

    func unregister() throws {
        unregisterCount += 1
        if let unregisterError {
            throw unregisterError
        }
        status = .disabled
    }
}

private enum TestRegistrationError: LocalizedError {
    case denied

    var errorDescription: String? {
        "Registration denied for testing."
    }
}

private enum FixtureError: Error {
    case defaultsUnavailable
}
