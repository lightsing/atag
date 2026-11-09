import CryptoKit
import Foundation
import Security

struct DirectError: LocalizedError, Codable {
    let code: String
    let message: String
    var errorDescription: String? { message }

    init(_ code: String, _ message: String) { self.code = code; self.message = message }

    static let invalid = Self("INVALID_REQUEST", "请求或文件格式无效。")
    static let network = Self("UPSTREAM_UNAVAILABLE", "无法连接 Apple 或机器认证服务，请检查网络。")
    static let timeout = Self("TIMEOUT", "Apple 或机器认证服务请求超时。")
    static let machine = Self("UPSTREAM_UNAVAILABLE", "机器认证服务未返回可用数据，请检查服务地址。")
    static let keychain = Self("INTERNAL_ERROR", "无法访问手机钥匙串，请解锁设备后重试。")
}

private enum Endpoint: String, Decodable {
    case gsa, mobileme, methods, sms_request, sms_submit, trusted_request, trusted_submit, findmy

    var target: (String, String) {
        switch self {
        case .gsa: ("https://gsa.apple.com/grandslam/GsService2", "POST")
        case .mobileme: ("https://setup.icloud.com/setup/iosbuddy/loginDelegates", "POST")
        case .methods: ("https://gsa.apple.com/auth", "GET")
        case .sms_request: ("https://gsa.apple.com/auth/verify/phone", "PUT")
        case .sms_submit: ("https://gsa.apple.com/auth/verify/phone/securitycode", "POST")
        case .trusted_request: ("https://gsa.apple.com/auth/verify/trusteddevice", "GET")
        case .trusted_submit: ("https://gsa.apple.com/grandslam/GsService2/validate", "GET")
        case .findmy: ("https://gateway.icloud.com/findmyservice/v2/fetch", "POST")
        }
    }
}

private struct AppleRequest: Decodable {
    let endpoint: Endpoint
    let method: String
    let headers: [String: String]
    let bodyBase64: String?

    func request() throws -> URLRequest {
        let (url, expected) = endpoint.target
        guard method == expected, headers.count <= 64,
              (method == "GET") == (bodyBase64 == nil) else { throw DirectError.invalid }
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = method
        let allowed: Set<String> = [
            "authorization", "user-agent", "accept", "accept-language", "loc",
            "content-type", "x-mme-client-info", "x-mme-device-id", "security-code",
        ]
        var seen = Set<String>()
        for (name, value) in headers {
            let lower = name.lowercased()
            guard (allowed.contains(lower) || lower.hasPrefix("x-apple-")),
                  name.utf8.count <= 100, lower.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }),
                  value.utf8.count <= 8192, DirectHTTP.safeHeader(value),
                  seen.insert(lower).inserted else { throw DirectError.invalid }
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let bodyBase64 {
            guard bodyBase64.utf8.count <= 65_536, let bytes = Data(base64Encoded: bodyBase64) else { throw DirectError.invalid }
            request.httpBody = bytes
        }
        return request
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class DirectHTTP: Sendable {
    let session: URLSession

    init(protocolClasses: [AnyClass]? = nil) {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 40
        config.timeoutIntervalForResource = 50
        if let protocolClasses { config.protocolClasses = protocolClasses }
        session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    static func safeHeader(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { (32...126).contains($0) }
    }

    func response(_ request: URLRequest, limit: Int) async throws -> (Data, HTTPURLResponse) {
        do {
            let (stream, raw) = try await session.bytes(for: request)
            guard let response = raw as? HTTPURLResponse, raw.expectedContentLength <= limit else {
                throw DirectError.network
            }
            var body = Data()
            for try await byte in stream {
                guard body.count < limit else { throw DirectError.network }
                body.append(byte)
            }
            return (body, response)
        } catch let error as DirectError {
            throw error
        } catch let error as URLError where error.code == .timedOut {
            throw DirectError.timeout
        } catch {
            throw DirectError.network
        }
    }

    func forwardApple(_ payload: Data) async throws -> Data {
        let request = try JSONDecoder().decode(AppleRequest.self, from: payload).request()
        let (data, response) = try await response(request, limit: 8 * 1024 * 1024)
        return try JSONSerialization.data(withJSONObject: [
            "status": response.statusCode, "headers": [:], "bodyBase64": data.base64EncodedString(),
        ])
    }
}

actor AnisetteV3 {
    static let defaultSource = "https://new.ani.sidestore.io"
    private let http: DirectHTTP
    private let limit = 64 * 1024

    init(http: DirectHTTP) { self.http = http }

    static func normalize(_ input: String) throws -> String {
        guard let parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "https", let host = parts.host?.lowercased(), !host.isEmpty,
              parts.port == nil || parts.port == 443,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              host.utf8.count <= 253, host.contains("."),
              host.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 }) else {
            throw DirectError("INVALID_REQUEST", "请填写 Anisette v3 服务的 HTTPS 根地址。")
        }
        return "https://" + host
    }

    private struct Machine: Codable {
        let id: UUID
        var adi: String?
        var identifier: Data {
            var value = id.uuid
            return withUnsafeBytes(of: &value) { Data($0) }
        }
        var uid: String { SHA256.hash(data: identifier).map { String(format: "%02x", $0) }.joined() }
        var deviceID: String { id.uuidString.lowercased() }
    }

    private struct Metadata: Decodable {
        let client_info: String
        let user_agent: String

        func forFindMy() throws -> Self {
            guard client_info.utf8.count <= 1024, user_agent.utf8.count <= 1024,
                  DirectHTTP.safeHeader(client_info), DirectHTTP.safeHeader(user_agent),
                  client_info.range(of: #"^<[^<>]+> <(?:macOS|Mac OS X);[^<>]+> <[^<>]+>$"#, options: .regularExpression) != nil else {
                throw DirectError("UPSTREAM_UNAVAILABLE", "请使用提供 macOS 机器身份的 Anisette v3 服务。")
            }
            if client_info == "<MacBookPro13,3> <Mac OS X;10.12.6;16G29> <com.apple.AuthKit/1 (com.apple.akd/1.0)>" {
                // Match the repository's v3 provider for the older advertised Sierra profile.
                return .init(client_info: "<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AuthKit/1 (com.apple.akd/1.0)>",
                             user_agent: "akd/1.0 CFNetwork/1404.0.5 Darwin/22.2.0")
            }
            return self
        }
    }

    func headers(source input: String) async throws -> Data {
        let source = try Self.normalize(input)
        let key = "anisette:" + source
        var machine = try SecureStore.load(Machine.self, key: key) ?? Machine(id: UUID())
        if machine.adi == nil { try SecureStore.save(machine, key: key) }
        let metadataBytes = try await success(URLRequest(url: URL(string: source + "/v3/client_info")!))
        let info = try JSONDecoder().decode(Metadata.self, from: metadataBytes).forFindMy()

        for attempt in 0...1 {
            if machine.adi == nil {
                machine.adi = try await provision(source: source, info: info, machine: machine)
                try SecureStore.save(machine, key: key)
            }
            var request = URLRequest(url: URL(string: source + "/v3/get_headers")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "identifier": machine.identifier.base64EncodedString(), "adi_pb": machine.adi!,
            ])
            let reply = try await dictionary(success(request))
            if reply["result"] as? String == "GetHeadersError",
               (reply["message"] as? String)?.contains("-45061") == true, attempt == 0 {
                machine.adi = nil
                try SecureStore.save(machine, key: key)
                continue
            }
            guard reply["result"] as? String == "Headers" else { throw DirectError.machine }
            var headers = machineHeaders(machine)
            for name in ["X-Apple-I-MD", "X-Apple-I-MD-M"] {
                guard let value = reply[name] as? String, value.utf8.count <= 1024, DirectHTTP.safeHeader(value),
                      let decoded = Data(base64Encoded: value), !decoded.isEmpty else { throw DirectError.machine }
                headers[name] = value
            }
            let routing = reply["X-Apple-I-MD-RINFO"] as? String
                ?? (reply["X-Apple-I-MD-RINFO"] as? NSNumber)?.stringValue ?? "17106176"
            guard (1...20).contains(routing.utf8.count), routing.utf8.allSatisfy({ (48...57).contains($0) }) else {
                throw DirectError.machine
            }
            headers["X-Apple-I-MD-RINFO"] = routing
            headers["X-Apple-I-SRL-NO"] = "0"
            headers["loc"] = "en_US"
            return try JSONSerialization.data(withJSONObject: [
                "headers": headers, "clientInfo": info.client_info, "userAgent": info.user_agent,
            ])
        }
        throw DirectError.machine
    }

    private func machineHeaders(_ machine: Machine) -> [String: String] {
        ["X-Apple-I-MD-LU": machine.uid, "X-Mme-Device-Id": machine.deviceID,
         "X-Apple-I-Client-Time": ISO8601DateFormatter().string(from: Date()),
         "X-Apple-I-TimeZone": "UTC", "X-Apple-Locale": "en_US"]
    }

    private func success(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await http.response(request, limit: limit)
        guard (200...299).contains(response.statusCode) else {
            throw DirectError("UPSTREAM_UNAVAILABLE", "机器认证服务返回 HTTP \(response.statusCode)。")
        }
        return data
    }

    private func dictionary(_ data: Data) throws -> [String: Any] {
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DirectError.machine }
        return result
    }

    private func appleURL(_ raw: Any?) throws -> URL {
        guard let raw = raw as? String, let parts = URLComponents(string: raw), parts.scheme == "https",
              parts.host == "gsa.apple.com", parts.port == nil || parts.port == 443,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              let url = parts.url else { throw DirectError.machine }
        return url
    }

    private func blob(_ value: Any?) throws -> String {
        guard let text = value as? String, (1...49_152).contains(text.utf8.count),
              Data(base64Encoded: text) != nil else { throw DirectError.machine }
        return text
    }

    private func plist(_ url: URL, _ info: Metadata, _ machine: Machine, body: [String: String]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        for (name, value) in machineHeaders(machine) { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue(info.client_info, forHTTPHeaderField: "X-Mme-Client-Info")
        request.setValue(info.user_agent, forHTTPHeaderField: "User-Agent")
        request.setValue("text/x-xml-plist", forHTTPHeaderField: "Content-Type")
        if let body {
            request.httpMethod = "POST"
            request.httpBody = try PropertyListSerialization.data(fromPropertyList: ["Header": [:], "Request": body],
                                                                  format: .xml, options: 0)
        }
        let bytes = try await success(request)
        guard let result = try PropertyListSerialization.propertyList(from: bytes, format: nil) as? [String: Any] else {
            throw DirectError.machine
        }
        return result
    }

    private func provision(source: String, info: Metadata, machine: Machine) async throws -> String {
        let lookup = URL(string: "https://gsa.apple.com/grandslam/GsService2/lookup")!
        let urls = try await plist(lookup, info, machine)["urls"] as? [String: Any]
        let start = try appleURL(urls?["midStartProvisioning"])
        let finish = try appleURL(urls?["midFinishProvisioning"])
        let socket = http.session.webSocketTask(with: URL(string: "wss" + source.dropFirst(5) + "/v3/provisioning_session")!)
        socket.maximumMessageSize = limit
        socket.resume()
        let timeout = Task {
            try await Task.sleep(for: .seconds(40))
            socket.cancel(with: .goingAway, reason: nil)
        }
        defer { timeout.cancel(); socket.cancel(with: .normalClosure, reason: nil) }
        for step in ["GiveIdentifier", "GiveStartProvisioningData", "GiveEndProvisioningData", "ProvisioningSuccess"] {
            guard case .string(let text) = try await socket.receive(),
                  text.utf8.count <= limit else { throw DirectError.machine }
            let message = try dictionary(Data(text.utf8))
            guard message["result"] as? String == step else { throw DirectError.machine }
            let reply: [String: String]
            switch step {
            case "GiveIdentifier":
                reply = ["identifier": machine.identifier.base64EncodedString()]
            case "GiveStartProvisioningData":
                let response = try await plist(start, info, machine, body: [:])["Response"] as? [String: Any]
                reply = ["spim": try blob(response?["spim"])]
            case "GiveEndProvisioningData":
                let response = try await plist(finish, info, machine, body: ["cpim": try blob(message["cpim"])])["Response"] as? [String: Any]
                reply = ["ptm": try blob(response?["ptm"]), "tk": try blob(response?["tk"])]
            default:
                return try blob(message["adi_pb"])
            }
            let data = try JSONSerialization.data(withJSONObject: reply)
            try await socket.send(.string(String(decoding: data, as: UTF8.self)))
        }
        throw DirectError.machine
    }
}
