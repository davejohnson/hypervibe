import Foundation

enum PublicServiceEndpoint {
    static func originURL(from raw: String?) -> URL? {
        guard let raw,
            let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            url.user == nil,
            url.password == nil,
            let host = url.host(),
            !host.isEmpty else {
            return nil
        }

        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        return components.url
    }

    static func hostname(from raw: String) -> String? {
        let hostname = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !hostname.isEmpty, hostname.utf8.count <= 253 else { return nil }

        let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return nil }
        for label in labels {
            guard !label.isEmpty,
                label.utf8.count <= 63,
                label.first.map(isASCIIAlphanumeric) == true,
                label.last.map(isASCIIAlphanumeric) == true,
                label.allSatisfy({ isASCIIAlphanumeric($0) || $0 == "-" }) else {
                return nil
            }
        }
        return hostname
    }

    static func hostnames(from raw: [String]) -> [String] {
        var seen = Set<String>()
        return raw.compactMap { hostname(from: $0) }
            .filter { seen.insert($0).inserted }
    }

    static func preferredURL(customDomains: [String], fallbackURL: URL?) -> URL? {
        if let hostname = customDomains.compactMap({ hostname(from: $0) }).first {
            return URL(string: "https://\(hostname)")
        }
        return originURL(from: fallbackURL?.absoluteString)
    }

    private static func isASCIIAlphanumeric(_ character: Character) -> Bool {
        guard character.unicodeScalars.count == 1,
            let scalar = character.unicodeScalars.first else {
            return false
        }
        return (scalar.value >= 48 && scalar.value <= 57)
            || (scalar.value >= 97 && scalar.value <= 122)
    }
}
