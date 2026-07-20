import HypervibeCompanionCore
import SwiftUI

struct ProviderLogo: View {
    let provider: String
    var size: CGFloat = 26

    private var visual: ProviderVisual {
        ProviderVisual(provider: provider)
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                .fill(visual.background)

            mark
                .foregroundStyle(visual.foreground)
                .font(.system(size: size * 0.48, weight: .bold))
        }
        .frame(width: size, height: size)
        .accessibilityLabel(visual.displayName)
        .help(visual.displayName)
    }

    @ViewBuilder
    private var mark: some View {
        switch visual.mark {
        case .letters(let value):
            Text(value)
                .fontDesign(.rounded)
        case .symbol(let name):
            Image(systemName: name)
        case .sendGrid:
            SendGridMark()
                .padding(size * 0.2)
        }
    }
}

struct ConnectionCard: View {
    let connections: [ConnectionSummary]

    private var connection: ConnectionSummary {
        connections[0]
    }

    private var status: ConnectionStatus {
        if connections.contains(where: { $0.status == .failed }) {
            return .failed
        }
        if connections.contains(where: { $0.status == .pending }) {
            return .pending
        }
        if connections.allSatisfy({ $0.status == .verified }) {
            return .verified
        }
        return .unknown
    }

    private var visual: ProviderVisual {
        ProviderVisual(provider: connection.provider)
    }

    var body: some View {
        HStack(spacing: 9) {
            ProviderLogo(provider: connection.provider, size: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(visual.displayName)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                if connections.count > 1 {
                    Text("\(connections.count) connections")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else if connection.scope != "global" {
                    Text(connection.scope)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let verifiedAt = connection.lastVerifiedAt {
                    Text(verifiedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 4)

            Circle()
                .fill(status.color)
                .frame(width: 8, height: 8)
                .accessibilityLabel(status.title)
                .help(status.title)
        }
        .padding(9)
        .background(.background.opacity(0.65), in: RoundedRectangle(cornerRadius: 9))
    }
}

private struct SendGridMark: View {
    var body: some View {
        GeometryReader { geometry in
            let side = geometry.size.width * 0.42
            ZStack {
                square(side: side, x: 0, y: 0)
                square(side: side, x: geometry.size.width - side, y: 0)
                square(
                    side: side,
                    x: (geometry.size.width - side) / 2,
                    y: geometry.size.height - side
                )
            }
        }
    }

    private func square(side: CGFloat, x: CGFloat, y: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: side * 0.12)
            .frame(width: side, height: side)
            .position(x: x + side / 2, y: y + side / 2)
    }
}

private struct ProviderVisual {
    enum Mark {
        case letters(String)
        case symbol(String)
        case sendGrid
    }

    let displayName: String
    let background: Color
    let foreground: Color
    let mark: Mark

    init(provider rawProvider: String) {
        let provider = rawProvider.lowercased()
        switch provider {
        case "railway":
            self.init("Railway", background: .black, foreground: .white, mark: .letters("R"))
        case "cloudflare":
            self.init("Cloudflare", background: .orange, foreground: .white, mark: .symbol("cloud.sun.fill"))
        case "github", "github-actions":
            self.init("GitHub", background: .black, foreground: .white, mark: .symbol("chevron.left.forwardslash.chevron.right"))
        case "sendgrid":
            self.init("SendGrid", background: Color(red: 0.08, green: 0.55, blue: 0.88), foreground: .white, mark: .sendGrid)
        case "stripe":
            self.init("Stripe", background: Color(red: 0.39, green: 0.36, blue: 1), foreground: .white, mark: .letters("S"))
        case "supabase":
            self.init("Supabase", background: Color(red: 0.12, green: 0.68, blue: 0.43), foreground: .white, mark: .symbol("bolt.fill"))
        case "cloudrun", "cloudsql", "gcp-pubsub":
            self.init("Google Cloud", background: Color(red: 0.26, green: 0.52, blue: 0.96), foreground: .white, mark: .symbol("cloud.fill"))
        case "database", "postgres":
            self.init("PostgreSQL", background: Color(red: 0.20, green: 0.41, blue: 0.58), foreground: .white, mark: .symbol("cylinder.fill"))
        case "appstoreconnect", "app-store-connect":
            self.init("App Store Connect", background: .blue, foreground: .white, mark: .symbol("apple.logo"))
        case "1password":
            self.init("1Password", background: Color(red: 0.10, green: 0.49, blue: 0.93), foreground: .white, mark: .letters("1"))
        case "bitwarden":
            self.init("Bitwarden", background: Color(red: 0.10, green: 0.45, blue: 0.82), foreground: .white, mark: .symbol("shield.fill"))
        case "aws-secrets":
            self.init("AWS Secrets Manager", background: Color(red: 0.14, green: 0.17, blue: 0.21), foreground: .orange, mark: .symbol("key.fill"))
        case "doppler":
            self.init("Doppler", background: .yellow, foreground: .black, mark: .symbol("waveform.path"))
        case "vault":
            self.init("Vault", background: .yellow, foreground: .black, mark: .symbol("lock.fill"))
        case "recaptcha":
            self.init("reCAPTCHA", background: .blue, foreground: .white, mark: .symbol("arrow.triangle.2.circlepath"))
        case "tunnel":
            self.init("Cloudflare Tunnel", background: .orange, foreground: .white, mark: .symbol("point.3.connected.trianglepath.dotted"))
        case "xcode":
            self.init("Xcode", background: .blue, foreground: .white, mark: .symbol("hammer.fill"))
        case "local":
            self.init("Local", background: .gray, foreground: .white, mark: .symbol("shippingbox.fill"))
        default:
            let abbreviation = rawProvider
                .split(separator: "-")
                .prefix(2)
                .compactMap(\.first)
                .map { String($0).uppercased() }
                .joined()
            self.init(
                rawProvider.replacingOccurrences(of: "-", with: " ").capitalized,
                background: .secondary,
                foreground: .white,
                mark: .letters(abbreviation.isEmpty ? "?" : abbreviation)
            )
        }
    }

    private init(
        _ displayName: String,
        background: Color,
        foreground: Color,
        mark: Mark
    ) {
        self.displayName = displayName
        self.background = background
        self.foreground = foreground
        self.mark = mark
    }
}

private extension ConnectionStatus {
    var title: String {
        switch self {
        case .verified: "Verified"
        case .pending: "Pending verification"
        case .failed: "Verification failed"
        case .unknown: "Unknown"
        }
    }

    var color: Color {
        switch self {
        case .verified: .green
        case .pending: .orange
        case .failed: .red
        case .unknown: .secondary
        }
    }
}
