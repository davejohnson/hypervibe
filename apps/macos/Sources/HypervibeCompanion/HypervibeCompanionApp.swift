import AppKit
import SwiftUI

@main
struct HypervibeCompanionApp: App {
    @StateObject private var model: CompanionAppModel

    init() {
        let model = CompanionAppModel()
        _model = StateObject(wrappedValue: model)
        NSApplication.shared.setActivationPolicy(.accessory)
        Task {
            await model.loadIfNeeded()
        }
    }

    var body: some Scene {
        MenuBarExtra {
            CompanionMenuView(model: model)
        } label: {
            RocketIcon()
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

        Settings {
            CompanionSettingsView(model: model)
        }
    }
}
