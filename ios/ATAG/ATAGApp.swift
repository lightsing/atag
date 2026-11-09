import MapKit
import SwiftUI
import UniformTypeIdentifiers

@main
struct ATAGApp: App {
    var body: some Scene {
        WindowGroup { TagsView().tint(Color(red: 0.78, green: 0.31, blue: 0.16)) }
    }
}

private struct TagsView: View {
    @State private var engine = DirectEngine()
    @State private var library = TagLibrary()
    @State private var saved: SavedAccount?
    @State private var authExpired = false
    @State private var importing = false
    @State private var showImporter = false
    @State private var showLogin = false
    @State private var backupText: String?
    @State private var backupPassword = ""
    @State private var showBackup = false
    @State private var error: String?
    @State private var querying: String?
    @State private var queryNotes: [String: String] = [:]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { showLogin = true } label: {
                        Label(saved == nil ? "登录 Apple 账号" : saved?.account.accountLabel ?? "Apple 账号",
                              systemImage: authExpired ? "person.crop.circle.badge.exclamationmark" : "person.crop.circle")
                    }
                    .disabled(querying != nil)
                } footer: {
                    if authExpired {
                        Text("Find My 会话已失效，请重新登录。")
                    } else {
                        Text(saved == nil ? "登录后，iPhone 可以直接向 Apple 查询报告。" : "报告由附近的 Apple 设备上报，位置可能有延迟。")
                    }
                }
                Section("我的标签") {
                    if library.tags.isEmpty {
                        Text("导入设备档案或 ATAG 网页加密备份后，即可查询标签。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(library.tags) { tag in
                        NavigationLink(value: tag.id) {
                            VStack(alignment: .leading, spacing: 4) {
                                Label(tag.name, systemImage: "tag.fill").font(.headline)
                                Text(library.reports[tag.id]?.formattedDate ?? "暂无位置报告")
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button("导入标签档案", systemImage: "square.and.arrow.down") { showImporter = true }
                        .disabled(importing || querying != nil)
                    if importing { ProgressView("正在导入…") }
                }
            }
            .navigationTitle("ATAG 查找")
            .navigationDestination(for: String.self) { id in
                if let tag = library.tags.first(where: { $0.id == id }) {
                    TagDetail(tag: tag, location: library.reports[id], note: queryNotes[id],
                              loading: querying == id, busy: querying != nil || importing) {
                        if saved == nil || authExpired { showLogin = true }
                        else { Task { await refresh(tag) } }
                    }
                }
            }
            .toolbar {
                if saved != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu("账号", systemImage: "ellipsis.circle") {
                            Button("退出 Apple 账号", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                                do { try SecureStore.remove(key: SavedAccount.storageKey); saved = nil; authExpired = false }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                        .disabled(querying != nil)
                    }
                }
            }
        }
        .task {
            do {
                library = try TagLibrary.load()
                saved = try SecureStore.load(SavedAccount.self, key: SavedAccount.storageKey)
            } catch { self.error = error.localizedDescription }
        }
        .sheet(isPresented: $showLogin) {
            LoginView(engine: engine, source: saved?.source ?? AnisetteV3.defaultSource) { account in
                saved = account
                authExpired = false
            }
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                let file = try FileHandle(forReadingFrom: url)
                defer { try? file.close() }
                let limit = 16 * 1024 * 1024
                guard let data = try file.read(upToCount: limit + 1), data.count <= limit,
                      let text = String(data: data, encoding: .utf8) else {
                    throw DirectError("INVALID_REQUEST", "请选择不超过 16 MiB 的 UTF-8 JSON 文件。")
                }
                Task { await importTags(text) }
            } catch let failure as CocoaError where failure.code == .userCancelled {
                return
            } catch { self.error = error.localizedDescription }
        }
        .alert("备份密码", isPresented: $showBackup) {
            SecureField("密码", text: $backupPassword)
            Button("导入") {
                let password = backupPassword
                let text = backupText
                backupPassword = ""
                backupText = nil
                if let text { Task { await importTags(text, password: password) } }
            }
            Button("取消", role: .cancel) { backupPassword = ""; backupText = nil }
        } message: { Text("密码只用于在本机解密设备档案。") }
        .alert("ATAG", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("好", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }

    private struct ImportRequest: Encodable { let text: String; let password: String? }

    private func importTags(_ text: String, password: String? = nil) async {
        guard !importing else { return }
        importing = true
        defer { importing = false }
        do {
            let tags: [TagProfile] = try await engine.run("import", input: ImportRequest(text: text, password: password))
            var next = library
            for tag in tags {
                if let index = next.tags.firstIndex(where: { $0.id == tag.id }) { next.tags[index] = tag }
                else { next.tags.append(tag) }
                next.reports.removeValue(forKey: tag.id)
            }
            try next.save()
            library = next
        } catch let failure as DirectError where failure.code == "AUTH_REQUIRED" && password == nil {
            backupText = text
            showBackup = true
        } catch { self.error = error.localizedDescription }
    }

    private struct QueryRequest: Encodable { let tag: TagProfile; let saved: SavedAccount }

    private func refresh(_ tag: TagProfile) async {
        guard let saved, querying == nil else { return }
        querying = tag.id
        queryNotes[tag.id] = nil
        defer { querying = nil }
        do {
            let location: TagLocation? = try await engine.run("latest", input: QueryRequest(tag: tag, saved: saved))
            if let location {
                var next = library
                if (next.reports[tag.id]?.observedAt ?? "") <= location.observedAt {
                    next.reports[tag.id] = location
                    try next.save()
                    library = next
                }
            } else { queryNotes[tag.id] = "本次查询没有找到位置报告。" }
        } catch let failure as DirectError {
            authExpired = failure.code == "AUTH_EXPIRED"
            queryNotes[tag.id] = failure.message
        } catch { queryNotes[tag.id] = error.localizedDescription }
    }
}

private struct LoginView: View {
    let engine: DirectEngine
    let didLogin: (SavedAccount) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var source: String
    @State private var username = ""
    @State private var password = ""
    @State private var code = ""
    @State private var snapshot: LoginSnapshot?
    @State private var busy = false
    @State private var error: String?

    init(engine: DirectEngine, source: String, didLogin: @escaping (SavedAccount) -> Void) {
        self.engine = engine
        self.didLogin = didLogin
        _source = State(initialValue: source)
    }

    private var verifying: Bool { ["choose_method", "awaiting_code"].contains(snapshot?.phase ?? "") }

    var body: some View {
        NavigationStack {
            Form {
                if verifying, let snapshot {
                    Section("Apple 双重认证") {
                        ForEach(snapshot.methods) { method in
                            Button(snapshot.selectedMethodId == method.id ? "重新发送到\(method.label)" : method.label) {
                                Task { await perform("sendCode", input: method.id) }
                            }
                            .disabled(busy || snapshot.sendsRemaining == 0)
                        }
                        if snapshot.phase == "awaiting_code" {
                            TextField("6 位验证码", text: $code)
                                .textContentType(.oneTimeCode).keyboardType(.numberPad)
                            Button("验证") {
                                let value = code
                                code = ""
                                Task { await perform("submitCode", input: value) }
                            }
                            .disabled(code.utf8.count != 6 || busy || snapshot.attemptsRemaining == 0)
                        }
                    }
                } else {
                    Section("Apple 账号") {
                        TextField("Apple 账号", text: $username)
                            .textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        SecureField("密码", text: $password).textContentType(.password)
                        Button("登录") {
                            do {
                                let address = try AnisetteV3.normalize(source)
                                let input = Credentials(username: username, password: password, anisetteSource: address)
                                password = ""
                                Task { await perform("login", input: input) }
                            } catch { self.error = error.localizedDescription }
                        }
                        .disabled(username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty || busy)
                    }
                    Section {
                        TextField("HTTPS 服务地址", text: $source).keyboardType(.URL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    } header: {
                        Text("Anisette v3 机器认证")
                    } footer: {
                        Text("服务只接收机器注册数据。登录和位置查询由手机直接发送给 Apple。")
                    }
                }
                if busy { ProgressView("正在联系 Apple…") }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("登录 Find My")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        Task {
                            let _: Bool? = try? await engine.run("cancelLogin")
                            dismiss()
                        }
                    }
                    .disabled(busy)
                }
            }
        }
        .interactiveDismissDisabled()
    }

    private struct Credentials: Encodable { let username: String; let password: String; let anisetteSource: String }

    private func perform<Input: Encodable>(_ command: String, input: Input) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let result: LoginSnapshot = try await engine.run(command, input: input)
            snapshot = result
            if result.phase == "complete" {
                guard let saved = try SecureStore.load(SavedAccount.self, key: SavedAccount.storageKey)
                else { throw DirectError.keychain }
                didLogin(saved)
                dismiss()
            }
        } catch {
            self.error = error.localizedDescription
            snapshot = try? await engine.run("loginState")
        }
    }
}

private struct TagDetail: View {
    let tag: TagProfile
    let location: TagLocation?
    let note: String?
    let loading: Bool
    let busy: Bool
    let refresh: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let location {
                    let point = CLLocationCoordinate2D(latitude: location.latitude, longitude: location.longitude)
                    let span = max(500, Double(location.horizontalAccuracyMeters) * 5)
                    Map(initialPosition: .region(MKCoordinateRegion(center: point,
                        latitudinalMeters: span, longitudinalMeters: span))) {
                        if location.horizontalAccuracyMeters > 0 {
                            MapCircle(center: point, radius: Double(location.horizontalAccuracyMeters))
                                .foregroundStyle(Color.accentColor.opacity(0.18))
                        }
                        Marker(tag.name, coordinate: point).tint(Color.accentColor)
                    }
                    .id(location.observedAt)
                    .frame(height: 340)
                    .clipShape(.rect(cornerRadius: 18))

                    VStack(spacing: 12) {
                        LabeledContent("上报时间", value: location.formattedDate)
                        LabeledContent("水平精度", value: location.horizontalAccuracyMeters > 0 ? "±\(location.horizontalAccuracyMeters) 米" : "未提供")
                        let volts = (Double(location.batteryMillivolts) / 1000).formatted(.number.precision(.fractionLength(2)))
                        LabeledContent("上报电压", value: "\(volts) V")
                    }
                    .padding(16)
                    .background(.regularMaterial, in: .rect(cornerRadius: 18))
                    Text("这是最后上报的位置，实际位置可能已变化。")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    ContentUnavailableView("暂无位置报告", systemImage: "location.slash",
                        description: Text("查询标签在过去 7 天内的上报位置。"))
                }
                if let note { Text(note).font(.subheadline).foregroundStyle(.secondary) }
                Button(action: refresh) {
                    if loading { ProgressView() }
                    else { Label("查询 Find My", systemImage: "arrow.clockwise") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
            }
            .frame(maxWidth: .infinity)
            .padding()
        }
        .navigationTitle(tag.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
