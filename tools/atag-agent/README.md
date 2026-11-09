# ATAG 本地能力桥接

Agent 只提供 Anisette 和限定 Apple 地址的请求转发。账号、密码、验证码和登录流程全部在网页操作，最终查询会话保存在此浏览器。Agent 不管理用户、登录挑战、设备、Tag 私钥或报告；程序配置与本机 Anisette 机器材料不属于用户档案。

## 启动

```sh
cargo run -p atag-agent -- serve
```

默认只监听 IPv4 loopback。Agent 优先使用 `127.0.0.1:18432`，占用时按网页共用的固定端口序列尝试下一个端口。网页打开时自动寻找可用的 Agent，找不到时可填写实际地址。登录支持受信任设备与短信验证，密码证明在浏览器计算。桥接无需访问令牌。

使用 CLI 为发布站点提供桥接时，允许该站点的 Origin。

```sh
cargo run -p atag-agent -- serve --allow-origin https://lightsing.github.io
```

## 桌面托盘

`atag-agent-tray` 支持 macOS 菜单栏、Windows 通知区域和 Linux 系统托盘。启动后等待本机 API 就绪，再用默认浏览器打开 GitHub Pages。菜单显示 API 地址，并可再次打开网页、启动或停止 API、退出托盘。Linux 需要桌面会话的 D-Bus 和支持 StatusNotifierItem 的托盘，例如 KDE Plasma 或启用 AppIndicator 扩展的 GNOME。托盘源码构建需要 Rust 1.90 或更新版本。[ATAG 网页](https://lightsing.github.io/atag/)

```sh
cargo build --locked -p atag-agent -p atag-agent-tray -p atag-coreadi-worker
cargo run --locked -p atag-agent-tray
```

`--web-url` 可指定自托管网页，并将该网址的 Origin 加入白名单。托盘和 CLI 共用 `--listen`、`--allow-origin`、`--data-dir` 和 `ATAG_AGENT_DATA_DIR`。显式指定 `--listen 127.0.0.1:18433` 时只尝试该地址。运行时将 `atag-coreadi-worker` 与托盘程序放在同一目录。

在 GitHub Actions 的 **ATAG tray packages** 工作流填入发布网页 URL，可以构建并下载
macOS、Windows 和 Linux 压缩包。也可以在目标平台运行
`node tools/atag-agent-tray/package.mjs <网页 URL>`，产物位于 `target/packages/`。
压缩包包含托盘、CLI 和 Rust CoreADI worker，启动托盘无需 Python。macOS 包为 ad hoc
签名。打开托盘后可以直接在网页登录，首次使用模拟 CoreADI 时会联网完成准备。

## 嵌入 Rust 应用

托盘和 `atag-agent serve` 均调用库的 `AgentServer`。在 Tokio 运行时中绑定后，可读取实际地址并传入关闭信号。

```rust
use atag_agent::server::{AgentServer, ServerConfig};

let server = AgentServer::bind(ServerConfig::default()).await?;
println!("http://{}", server.local_addr());
server.serve(async { let _ = tokio::signal::ctrl_c().await; }).await?;
```

若嵌入的应用需要支持 `local` 或 `portable` 来源，可像 CLI 和托盘一样解析并分发 `atag_agent::cli_support::WorkerCommand`，在运行 UI 前处理本机 Anisette 子进程。

## Anisette

新登录默认使用“模拟 macOS（默认）” (`mac-coreadi`)。Agent 通过独立的 Rust 进程 `atag-coreadi-worker` 使用 Unicorn 执行 Apple 的 x86_64 CoreADI。源码构建需要 C/C++ 工具链、CMake 和 libclang。部署时将两个可执行文件放在同一目录。

首次登录时，Agent 从 Apple 下载 iTunes 安装镜像中约 3.5 MB 的 CoreADI 分段，校验
SHA-256 后提取 `CoreADI.x86_64`，缓存运行库并完成机器注册。准备过程需要联网，升级
时会复用原数据目录中的运行库和 `anisette/mac-coreadi/machine`。

也可以用 CLI 手动导入运行库。在 macOS 上用 `pkgutil --expand-full` 解包 iTunes
安装器，再用 `lipo -thin x86_64` 提取 `CoreADI.pkg/Payload` 中 CoreADI.framework
的二进制切片。[Apple iTunes 12.8.3 安装包](https://support.apple.com/en-us/106374)

```sh
cargo build --locked -p atag-agent -p atag-coreadi-worker
cargo run -p atag-agent --locked -- anisette install-mac-coreadi \
  --library /path/to/CoreADI.x86_64
cargo run -p atag-agent --locked -- anisette init
```

从其他目录导入时，可在安装命令中加 `--machine /path/to/machine`。`anisette init`
可单独触发准备和机器注册。后续请求复用机器标识和注册材料，客户端类型与模拟机器一致。

`atag-coreadi-worker` 独立链接 `adi-core` 和 Unicorn，按 GPL-2.0-only 提供。[上游 `adi-core`](https://github.com/sacca97/os-findmy-e/tree/d4d2a832baf47d1cf43d989879950ac2aec45f47/native/adi-core) · [Worker 许可证](../atag-coreadi-worker/LICENSE)

网页仍可显式选择“本机系统” (`local`)、便携运行库 (`portable`) 或远端来源；已保存的查询会话继续使用其原有来源。`anisette init --system` 在 macOS 使用系统后端，其他平台使用便携运行库；`anisette init --portable` 强制使用便携运行库，可加 `--repair` 重新下载其运行库并保留机器身份。

网页登录的“高级选项 → Anisette 来源 → SideStore 官方”使用
[官方列表](https://github.com/SideStore/anisette-servers/blob/main/servers.json)中的
`https://new.ani.sidestore.io`，通过 v3 协议为本机注册独立身份。
客户端类型自动配置。官方节点若仍报告早于离线 Find My 的 macOS 10.12.6，agent
沿用同一机器缓存，使用 [macOS 13.1 客户端资料](https://github.com/sacca97/os-findmy-e/blob/main/tools/machoadi/provider.py)。
首次使用需要联网完成 Apple 机器注册；后续使用
本地 `anisette/sidestore-v3/machine.json` 缓存。这里只保存随机机器标识和 provisioning
材料，不保存账号、密码或用户会话。自定义服务地址仍使用 v1 JSON 接口。

网页的 GrandSlam 登录使用 agent 返回的 AuthKit 客户端资料，随后 MobileMe 授权使用
同一机型、系统和网络版本对应的 AOSKit/accountsd 与 iCloudHelper 身份。
每轮 SRP 的初始化和密码证明共用一份机器认证数据与请求编号。Apple 登录各步骤
（包括获取验证方式、验证码和 MobileMe 授权）各有 60 秒等待上限，HTTP 桥接为
65 秒，网页为 70 秒；报告查询仍为 20 秒。超时不会自动重发密码证明或验证码。
本地/便携 Anisette 子进程最多等待 240 秒，以容纳首次运行库下载和机器注册；
其 HTTP 桥接为 245 秒，网页为 250 秒。其他认证来源仍保留各自更短的内部上限。
网页会显示正在准备机器认证、初始化登录或验证密码等具体步骤，可随时取消。
授权请求的 `client-id` 和浏览器保存的查询身份同样采用 Anisette 提供方的机器标识，
不再另造一套客户端身份；登录期间若机器标识变化则终止。
登录成功必须取得 `searchPartyToken`；仅通过账号和双重认证不算 Find My 会话可用。

初始化命令只准备运行库与机器材料，不会更改网页选中的来源，也不使用 Apple 账号。网页会显示桥接返回的具体错误；
agent 的失败日志仅包含失败环节、固定 Apple endpoint、HTTP 状态和错误代码，不包含请求体或认证头。Apple 返回的非成功 HTTP 状态也会记录；网页错误会标明登录步骤与 HTTP 状态。

`anisette init` 成功仅表示可以生成机器认证头，不验证 Apple 是否接受该机器身份。
如果登录返回 `-80045` 等机器认证错误，需要排查当前 Anisette 来源；改账号密码或
重复提交验证码不能修复机器认证失败。portable 的客户端标识使用 AuthKit daemon
`com.apple.akd`，与当前 GrandSlam 请求保持一致。

## API

- GET /v1/health：公开能力元数据（anisette、appleRelay）。
- POST /v1/anisette：无账户状态的 Anisette 头。
- POST /v1/apple/request：固定 endpoint / 方法 / 头白名单的字节转发；返回 Apple 状态和原始响应体。

不提供终端 login、账户/验证码 API、设备 CRUD、密钥生成、报告解密或后台用户任务。

只监听 loopback，保留 Host/Origin/CORS/no-store；不跟随 Apple 重定向，拒绝任意目标和 Host/Cookie 头，不返回 Set-Cookie。网页负责所有 Apple 业务逻辑与报告解密。

## 检查

```sh
cargo test -p atag-agent -p atag-agent-tray -p atag-coreadi-worker --locked
cargo clippy -p atag-agent -p atag-agent-tray -p atag-coreadi-worker --all-targets --locked -- -D warnings
cargo fmt --package atag-agent --package atag-agent-tray --package atag-coreadi-worker --check
node tools/atag-agent/tests/bridge-client-smoke.mjs
```

密码学向量、合成 Apple 上游和临时目录测试不使用真实账户或物理 Tag。网页登录 UX 的浏览器验证也只使用本地测试上游。完整边界见 [LOCAL_AGENT_API.md](../../docs/LOCAL_AGENT_API.md)。
