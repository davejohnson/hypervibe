import Foundation
import Testing
@testable import HypervibeCompanionCore

struct ConnectionGuidanceTests {
    @Test
    func selectedRepositoryGuidanceUsesReadOnlyContextWithoutReadingSpec() async throws {
        let fixture = try ConnectionGuidanceFixture(initialized: true)
        defer { fixture.remove() }
        let client = HypervibeMCPClient(clientVersion: "test")
        let catalog = try await client.connectionCatalog(project: fixture.project)
        let calls = try fixture.calls()
        #expect(calls.map { $0["name"] as? String } == ["hv_connections"])
        #expect((calls.last?["arguments"] as? [String: Any])?["repositoryContext"] as? Bool == true)
        #expect(catalog.providers.first?.setupLinks.first?.url.absoluteString == ConnectionGuidanceFixture.formURL)
    }

    @Test
    func freshRepositoryDoesNotInventAProjectToGetGuidance() async throws {
        let fixture = try ConnectionGuidanceFixture(initialized: false)
        defer { fixture.remove() }
        let client = HypervibeMCPClient(clientVersion: "test")
        _ = try await client.connectionCatalog(project: fixture.project)
        let calls = try fixture.calls()
        #expect(calls.map { $0["name"] as? String } == ["hv_connections"])
        #expect((calls.last?["arguments"] as? [String: Any])?["repositoryContext"] as? Bool == true)
        #expect((calls.last?["arguments"] as? [String: Any])?["project"] == nil)
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent(".hypervibe").path))
    }

    @Test
    func describeUsesTheSelectedScopeAndPreservesPreparedURL() async throws {
        let fixture = try ConnectionGuidanceFixture(initialized: true)
        defer { fixture.remove() }
        let client = HypervibeMCPClient(clientVersion: "test")
        let guidance = try await client.describeConnection(project: fixture.project, provider: "github", scope: "acme/storefront")
        let calls = try fixture.calls()
        let arguments = try #require(calls.last?["arguments"] as? [String: Any])
        #expect(arguments["action"] as? String == "describe")
        #expect(arguments["provider"] as? String == "github")
        #expect(arguments["scope"] as? String == "acme/storefront")
        #expect(arguments["repositoryContext"] as? Bool == true)
        #expect(arguments["project"] == nil)
        #expect(guidance.recommendedSetupURL?.absoluteString == ConnectionGuidanceFixture.formURL)
        #expect(guidance.provider.setupLinks.first?.url.absoluteString == ConnectionGuidanceFixture.formURL)
        #expect(!guidance.provider.requiresAgentSetup)
    }

    @Test
    func cloudDescriptionPreservesManagedSetupAsThePreferredPath() throws {
        let data = Data(#"""
        {"ok":true,"data":{"provider":{"name":"cloudrun","displayName":"GCP Cloud Run",
          "bootstrap":{"provider":"cloudrun","action":"bootstrap","adminAuth":"default"},
          "localSetup":{"cloud":"gcp","connectionAction":"bootstrap"},
          "credentialFields":[{"name":"credentialsJson","required":true,"sensitive":true}]},
          "connectionSetup":{"project":"storefront","credentialExample":"hv_connections provider=cloudrun action=bootstrap"}}}
        """#.utf8)
        let guidance = try HypervibeResponseMapper.decodeConnectionGuidance(data)
        #expect(guidance.provider.requiresAgentSetup)
        #expect(guidance.provider.bootstrap?.action == "bootstrap")
        #expect(guidance.provider.localSetup?.cloud == "gcp")
        #expect(guidance.agentSetupPrompt.contains("storefront"))
        #expect(guidance.agentSetupPrompt.contains("approvals"))
        #expect(guidance.provider.credentialFields?.first?.name == "credentialsJson")
    }
}

// The fixture speaks MCP over the actual subprocess/Swift SDK boundary.
// Its static form fields follow GitHub's documented prefill contract; no
// request-derived provider response or live credential operation is involved.
private struct ConnectionGuidanceFixture {
    static let formURL = "https://github.com/settings/personal-access-tokens/new?name=Hypervibe+storefront&description=Hypervibe+repository+management+for+acme%2Fstorefront&target_name=acme&expires_in=90&contents=write"
    let root: URL
    let project: CompanionProject

    init(initialized: Bool) throws {
        let manager = FileManager.default
        root = manager.temporaryDirectory.appendingPathComponent("hypervibe-connection-guidance-\(UUID())", isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        if initialized {
            let state = root.appendingPathComponent(".hypervibe", isDirectory: true)
            try manager.createDirectory(at: state, withIntermediateDirectories: true)
            try Data("{}".utf8).write(to: state.appendingPathComponent("spec.json"))
        }
        let fixture = root.appendingPathComponent("server.cjs")
        let script = #"""
        const fs=require('node:fs');
        const readline=require('node:readline');
        const catalog={connections:[],availableProviders:{deployment:[{
          name:'github',displayName:'GitHub',setupHelpUrls:[{label:'Fine-grained token',url:process.argv[3]}]
        }]}};
        readline.createInterface({input:process.stdin}).on('line',line=>{
          const request=JSON.parse(line);if(request.id===undefined)return;
          let result;
          if(request.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}};
          else if(request.method==='tools/list')result={tools:['hv_spec','hv_connections'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))};
          else if(request.method==='tools/call'){
            fs.appendFileSync(process.argv[2],JSON.stringify(request.params)+'\n');
            const description={provider:catalog.availableProviders.deployment[0],connectionSetup:{project:'storefront',scope:'acme/storefront',recommendedSetupUrl:process.argv[3],credentialExample:'hv_connections provider=github credentialsRef=env:HYPERVIBE_GITHUB_TOKEN'}};
            const envelope={ok:true,data:request.params.name==='hv_spec'?{project:{name:'storefront'},revision:1,spec:{environments:{}}}:request.params.arguments?.action==='describe'?description:catalog};
            result={content:[{type:'text',text:JSON.stringify(envelope)}],structuredContent:envelope};
          }else result={};
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
        });
        """#
        try Data(script.utf8).write(to: fixture)
        project = CompanionProject(
            displayName: "A user-facing label is not the project identity",
            repositoryPath: root.path,
            hypervibeExecutablePath: "/usr/bin/env",
            hypervibeArguments: ["node", fixture.path, root.appendingPathComponent("calls.jsonl").path, Self.formURL]
        )
    }

    func calls() throws -> [[String: Any]] {
        try String(contentsOf: root.appendingPathComponent("calls.jsonl"), encoding: .utf8)
            .split(separator: "\n")
            .map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    }

    func remove() { try? FileManager.default.removeItem(at: root) }
}
