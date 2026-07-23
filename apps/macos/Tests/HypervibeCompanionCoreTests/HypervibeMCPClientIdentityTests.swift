import Testing
@testable import HypervibeCompanionCore

struct HypervibeMCPClientIdentityTests {
    @Test
    func usesTheInjectedCompanionVersion() {
        let client = HypervibeMCPClient(clientVersion: "2.4.6")
        #expect(client.clientVersion == "2.4.6")
    }

    @Test
    func givesDevelopmentBuildsAnHonestFallbackIdentity() {
        let client = HypervibeMCPClient(clientVersion: "  ")
        #expect(client.clientVersion == "development")
    }
}
