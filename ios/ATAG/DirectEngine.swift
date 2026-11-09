import Foundation
import Security
import WebKit

enum SecureStore {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "ATAG Find My",
         kSecAttrAccount as String: key,
         kSecUseDataProtectionKeychain as String: true]
    }

    static func load<T: Decodable>(_ type: T.Type, key: String) throws -> T? {
        var request = query(key)
        request[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw DirectError.keychain }
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func save<T: Encodable>(_ value: T, key: String) throws {
        let data = try JSONEncoder().encode(value)
        let request = query(key)
        let attributes: [String: Any] = [kSecValueData as String: data,
                                        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(request as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(request.merging(attributes) { _, value in value } as CFDictionary, nil) == errSecSuccess
            else { throw DirectError.keychain }
        } else if status != errSecSuccess {
            throw DirectError.keychain
        }
    }

    static func remove(key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DirectError.keychain }
    }
}

struct SavedAccount: Codable {
    static let storageKey = "account"

    struct Account: Codable {
        let dsid: String
        let searchPartyToken: String
        let uid: String
        let deviceId: String
        let accountLabel: String?
    }

    let account: Account
    let source: String

    func save() throws {
        guard try AnisetteV3.normalize(source) == source,
              (1...256).contains(account.dsid.utf8.count), account.dsid.utf8.allSatisfy({ (48...57).contains($0) }),
              (1...8192).contains(account.searchPartyToken.utf8.count), DirectHTTP.safeHeader(account.searchPartyToken),
              account.uid.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
              UUID(uuidString: account.deviceId) != nil else { throw DirectError.invalid }
        try SecureStore.save(self, key: Self.storageKey)
    }
}

struct TagProfile: Codable, Identifiable {
    struct Keys: Codable {
        let kind: String
        let privateKey: String?
        let masterPrivateKey: String?
        let symmetricSeed: String?
        let privateKeys: [String]?
    }
    struct Query: Codable {
        let rotationStart: Int
        let rotationCount: Int
    }
    let id: String
    let name: String
    let keys: Keys
    let query: Query?
}

struct TagLocation: Codable {
    let observedAt: String
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyMeters: Int
    let batteryMillivolts: Int

    var date: Date? { try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(observedAt) }
    var formattedDate: String { date?.formatted(date: .abbreviated, time: .shortened) ?? observedAt }
}

struct TagLibrary: Codable {
    var tags: [TagProfile] = []
    var reports: [String: TagLocation] = [:]

    private static func file() throws -> URL {
        var directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                    appropriateFor: nil, create: true).appending(path: "ATAG")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory.appending(path: "tags-v1.json")
    }

    static func load() throws -> Self {
        do { return try JSONDecoder().decode(Self.self, from: Data(contentsOf: file())) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return Self() }
    }

    func save() throws {
        try JSONEncoder().encode(self).write(to: Self.file(), options: [.atomic, .completeFileProtection])
    }
}

struct LoginSnapshot: Decodable {
    struct Method: Identifiable, Decodable { let id: String; let label: String }
    let phase: String
    let methods: [Method]
    let selectedMethodId: String?
    let attemptsRemaining: Int
    let sendsRemaining: Int
    let error: DirectError?
}

@MainActor
final class DirectEngine: NSObject, WKNavigationDelegate {
    private let world = WKContentWorld.world(name: "ATAG")
    private let http: DirectHTTP
    private let headers: @Sendable (String) async throws -> Data
    private let webView: WKWebView
    private let html: URL?
    private var ready = false
    private var waiting: [CheckedContinuation<Void, Error>] = []

    init(resources: URL? = Bundle.main.resourceURL, http: DirectHTTP = DirectHTTP(),
         headers: (@Sendable (String) async throws -> Data)? = nil) {
        self.http = http
        let anisette = AnisetteV3(http: http)
        self.headers = headers ?? { try await anisette.headers(source: $0) }
        html = resources?.appending(path: "QueryEngine.html")
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        if let script = resources?.appending(path: "QueryEngine.js"),
           let source = try? String(contentsOf: script, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart,
                forMainFrameOnly: true, in: world))
        }
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.addScriptMessageHandler(Host(engine: self), contentWorld: world, name: "atag")
        webView.navigationDelegate = self
    }

    private struct Reply<Value: Decodable>: Decodable {
        let value: Value?
        let error: DirectError?
        let hasValue: Bool

        enum CodingKeys: CodingKey { case value, error }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            error = try values.decodeIfPresent(DirectError.self, forKey: .error)
            hasValue = values.contains(.value)
            value = hasValue ? try values.decode(Value.self, forKey: .value) : nil
        }
    }

    func run<T: Decodable, Input: Encodable>(_ command: String, input: Input) async throws -> T {
        let encoded = try JSONEncoder().encode(input)
        let inputJSON = String(decoding: encoded, as: UTF8.self)
        try await prepare()
        let raw: Any?
        do {
            raw = try await webView.callAsyncJavaScript("return await globalThis.atag.run(command, input);",
                arguments: ["command": command, "input": inputJSON], contentWorld: world)
        } catch {
            // WKError may contain source code or arguments; only show a fixed message.
            throw Self.engineError
        }
        guard let raw = raw as? String else { throw Self.engineError }
        let reply = try JSONDecoder().decode(Reply<T>.self, from: Data(raw.utf8))
        if let error = reply.error { throw error }
        guard reply.hasValue, let value = reply.value else { throw Self.engineError }
        return value
    }

    func run<T: Decodable>(_ command: String) async throws -> T {
        try await run(command, input: Optional<String>.none)
    }

    private static let engineError = DirectError("INTERNAL_ERROR", "手机查询组件无法启动，请重新打开 ATAG。")

    private func prepare() async throws {
        if ready { return }
        guard let html, FileManager.default.fileExists(atPath: html.path) else { throw Self.engineError }
        try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
            if waiting.count == 1 { webView.loadFileURL(html, allowingReadAccessTo: html) }
        }
    }

    private func complete(_ error: Error?) {
        ready = error == nil
        let pending = waiting
        waiting.removeAll()
        for waiter in pending {
            if let error { waiter.resume(throwing: error) } else { waiter.resume() }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        navigationAction.targetFrame?.isMainFrame == true && navigationAction.request.url == html ? .allow : .cancel
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { complete(nil) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { complete(Self.engineError) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { complete(Self.engineError) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { complete(Self.engineError) }

    private final class Host: NSObject, WKScriptMessageHandlerWithReply {
        weak var engine: DirectEngine?
        init(engine: DirectEngine) { self.engine = engine }

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage,
                                   replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
            guard let engine, message.frameInfo.isMainFrame, let text = message.body as? String,
                  text.utf8.count <= 100_000 else { replyHandler(nil, "Invalid message"); return }
            Task {
                do {
                    let body = try await engine.handle(Data(text.utf8))
                    replyHandler("{\"value\":" + String(decoding: body, as: UTF8.self) + "}", nil)
                } catch {
                    let safe = error as? DirectError ?? DirectError.network
                    if let data = try? JSONEncoder().encode(safe) {
                        replyHandler("{\"error\":" + String(decoding: data, as: UTF8.self) + "}", nil)
                    } else { replyHandler(nil, "Invalid response") }
                }
            }
        }
    }

    private func handle(_ bytes: Data) async throws -> Data {
        guard let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let op = request["op"] as? String, let payload = request["payload"] as? [String: Any] else {
            throw DirectError.invalid
        }
        switch op {
        case "apple":
            return try await http.forwardApple(JSONSerialization.data(withJSONObject: payload))
        case "anisette":
            guard let source = payload["source"] as? String else { throw DirectError.invalid }
            return try await headers(source)
        case "saveAccount":
            let value = try JSONDecoder().decode(SavedAccount.self, from: JSONSerialization.data(withJSONObject: payload))
            try value.save()
            return Data("true".utf8)
        default: throw DirectError.invalid
        }
    }
}
