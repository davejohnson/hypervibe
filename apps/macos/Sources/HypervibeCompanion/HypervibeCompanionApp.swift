import AppKit
import SwiftUI

struct ConnectionWindowRoute: Codable, Hashable {
    let projectID: UUID
    let provider: String?
}

struct VariableWindowRoute: Codable, Hashable {
    let projectID: UUID
    let environment: String
    let service: String?
}

@main
struct HypervibeCompanionApp: App {
    @NSApplicationDelegateAdaptor(CompanionApplicationDelegate.self)
    private var applicationDelegate
    @StateObject private var model: CompanionAppModel

    init() {
        let model = CompanionAppModel()
        _model = StateObject(wrappedValue: model)
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            CompanionMenuView(model: model)
        } label: {
            RocketIcon(alert: model.needsAttention)
                .frame(width: 17, height: 17)
        }
        .menuBarExtraStyle(.window)

        WindowGroup(
            "Add Hypervibe Project",
            id: "project-setup",
            for: String.self
        ) { _ in
            ProjectSetupView { draft in
                try await model.addProject(draft)
            }
        }
        .windowResizability(.contentSize)

        WindowGroup(
            "Provider Connections",
            id: "connections",
            for: ConnectionWindowRoute.self
        ) { route in
            if let route = route.wrappedValue,
                let project = model.projects.first(where: { $0.id == route.projectID }) {
                ConnectionsView(
                    model: model,
                    project: project,
                    preselectedProvider: route.provider
                )
            } else {
                ContentUnavailableView(
                    "Project unavailable",
                    systemImage: "shippingbox",
                    description: Text("Choose a project from the Hypervibe menu bar app.")
                )
                .frame(width: 640, height: 460)
            }
        }
        .defaultSize(width: 680, height: 520)

        WindowGroup(
            "Variables & Secrets",
            id: "variables",
            for: VariableWindowRoute.self
        ) { route in
            if let route = route.wrappedValue,
                let project = model.projects.first(where: { $0.id == route.projectID }),
                let snapshot = model.snapshots[route.projectID] {
                VariablesView(
                    model: model,
                    project: project,
                    snapshot: snapshot,
                    initialEnvironment: route.environment,
                    initialService: route.service
                )
            } else {
                ContentUnavailableView(
                    "Project unavailable",
                    systemImage: "shippingbox",
                    description: Text("Refresh the project from the Hypervibe menu bar app.")
                )
                .frame(width: 620, height: 440)
            }
        }
        .defaultSize(width: 680, height: 520)

        Settings {
            CompanionSettingsView(
                model: model,
                loginItemController: CompanionLoginItemSystem.controller
            )
        }
    }
}
