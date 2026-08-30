import AppKit
import CryptoKit
import Security
import ServiceManagement
import SwiftUI

private let service = "com.tryselvedge.mac"
private let account = "companion-token"
private let apiOrigin = URL(string: "https://tryselvedge.com")!

private struct PairStart: Decodable {
    let code: String
    let verification_url: URL
}

private struct PairStatus: Decodable { let approved: Bool }

private enum Keychain {
    static func read() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) throws {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        var row = base
        row[kSecValueData as String] = Data(token.utf8)
        row[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(row as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    static func remove() { SecItemDelete([kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary) }
}

@MainActor final class CompanionModel: ObservableObject {
    @Published var status = "Not connected"
    @Published var detail = "Connect this Mac once. No key copying required."
    @Published var paired = Keychain.read() != nil
    @Published var pairing = false
    @Published var tools: [(String, Bool)] = []
    private var worker: Process?

    init() {
        try? SMAppService.mainApp.register()
        refreshTools()
        if paired { startWorker() }
    }

    func pair() {
        guard !pairing else { return }
        pairing = true
        status = "Waiting for approval"
        detail = "Selvedge is opening in your browser."
        Task {
            do {
                let token = "slv_" + randomHex(bytes: 24)
                let hash = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
                var request = URLRequest(url: apiOrigin.appending(path: "/api/companion/pairings"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["name": Host.current().localizedName ?? "Mac", "token_hash": hash])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 201 else { throw PairError.start }
                let started = try JSONDecoder().decode(PairStart.self, from: data)
                NSWorkspace.shared.open(started.verification_url)
                for _ in 0..<120 {
                    try await Task.sleep(for: .seconds(2))
                    var poll = URLRequest(url: apiOrigin.appending(path: "/api/companion/pairings/\(started.code)"))
                    poll.setValue("Pair \(token)", forHTTPHeaderField: "Authorization")
                    let (pollData, pollResponse) = try await URLSession.shared.data(for: poll)
                    if (pollResponse as? HTTPURLResponse)?.statusCode == 200,
                       try JSONDecoder().decode(PairStatus.self, from: pollData).approved {
                        try Keychain.save(token)
                        paired = true
                        pairing = false
                        startWorker()
                        return
                    }
                }
                throw PairError.timeout
            } catch {
                pairing = false
                status = "Couldn’t connect"
                detail = "Try Connect this Mac again."
            }
        }
    }

    func disconnect() {
        worker?.terminate()
        worker = nil
        let token = Keychain.read()
        Task {
            if let token {
                var request = URLRequest(url: apiOrigin.appending(path: "/api/companion/me"))
                request.httpMethod = "DELETE"
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                _ = try? await URLSession.shared.data(for: request)
            }
            Keychain.remove()
            paired = false
            status = "Not connected"
            detail = "This Mac no longer has a Selvedge credential."
        }
    }

    func startWorker() {
        guard worker?.isRunning != true, let token = Keychain.read() else { return }
        guard let companion = Bundle.main.url(forResource: "selvedge-runtime", withExtension: nil) else {
            status = "Companion missing"; detail = "Reinstall Selvedge for Mac."; return
        }
        let process = Process()
        process.executableURL = companion
        process.arguments = ["runtime", "apple", "--name", Host.current().localizedName ?? "Mac"]
        var environment = ProcessInfo.processInfo.environment
        environment["SELVEDGE_TOKEN"] = token
        environment["SELVEDGE_API"] = apiOrigin.absoluteString
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        process.terminationHandler = { [weak self] _ in Task { @MainActor in
            self?.status = "Connection stopped"; self?.detail = "Choose Reconnect to start it again."
        } }
        do {
            try process.run()
            worker = process
            status = "Connected"
            detail = "Ready for Apple work from Selvedge chat."
        } catch {
            status = "Couldn’t start"
            detail = "Reinstall Selvedge for Mac, then choose Reconnect."
        }
    }

    private func refreshTools() {
        tools = [("Xcode", exists("xcodebuild")), ("Codex", exists("codex")), ("Claude Code", exists("claude"))]
    }

    private func exists(_ command: String) -> Bool {
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].contains { FileManager.default.isExecutableFile(atPath: "\($0)/\(command)") }
    }

    private func randomHex(bytes: Int) -> String {
        var data = Data(count: bytes)
        _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        return data.map { String(format: "%02x", $0) }.joined()
    }

    enum PairError: Error { case start, timeout }
}

@main struct SelvedgeMacApp: App {
    @StateObject private var model = CompanionModel()
    var body: some Scene {
        MenuBarExtra("Selvedge", systemImage: model.paired ? "checkmark.circle.fill" : "circle") {
            VStack(alignment: .leading, spacing: 10) {
                Text(model.status).font(.headline)
                Text(model.detail).font(.caption).foregroundStyle(.secondary).frame(width: 260, alignment: .leading)
                Divider()
                ForEach(model.tools, id: \.0) { tool in
                    HStack { Text(tool.0); Spacer(); Text(tool.1 ? "Ready" : "Needs setup").foregroundStyle(tool.1 ? .green : .secondary) }
                }
                Divider()
                if !model.paired { Button(model.pairing ? "Waiting for browser…" : "Connect this Mac") { model.pair() }.disabled(model.pairing) }
                else { Button("Reconnect") { model.startWorker() }; Button("Disconnect this Mac") { model.disconnect() } }
                Button("Open Selvedge") { NSWorkspace.shared.open(apiOrigin) }
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }.padding(12)
        }
    }
}
