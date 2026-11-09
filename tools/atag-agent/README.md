# ATAG 本地能力桥接

Agent 只提供 Anisette 和限定 Apple 地址的请求转发。账号、密码、验证码和登录流程全部在网页操作，最终查询会话保存在此浏览器。Agent 不管理用户、登录挑战、设备、Tag 私钥或报告；程序配置与本机 Anisette 机器材料不属于用户档案。

## 启动

```sh
cargo run -p atag-agent -- serve
```

默认 http://127.0.0.1:18432，只监听 loopback。网页设置中填写地址，测试连接后直接登录 Apple 账号；支持受信任设备与短信验证，无需终端登录或导入账号文件。登录密码证明在浏览器计算，Agent 不接收原始密码。桥接无需访问令牌，启动不会创建传输或用户状态文件。

部署网页需允许精确 Origin：

```sh
cargo run -p atag-agent -- serve --allow-origin https://atag-hhq.flutedbrink.chatgpt.site
```

## Anisette

新登录默认使用“模拟 macOS（默认）” (`mac-coreadi`)。Agent 在独立的 Python 子进程中用 Unicorn 运行 Apple 的 x86_64 CoreADI。首次部署需准备装有 `unicorn==2.1.4` 的 Python 虚拟环境、[固定版本的模拟器](https://github.com/sacca97/os-findmy-e/tree/d4d2a832baf47d1cf43d989879950ac2aec45f47/tools/machoadi)，以及从 [Apple iTunes 12.8.3](https://support.apple.com/en-us/106374) 安装包提取的 `CoreADI.x86_64`。该版本上游的 `tools/fetch_mac_coreadi.py` 可用 `curl` 和 `7z` 下载并提取运行库。Agent 安装时验证文件哈希：

```sh
cargo run -p atag-agent --locked -- anisette install-mac-coreadi \
  --python /path/to/venv/bin/python \
  --emulator /path/to/os-findmy-e/tools/machoadi \
  --library /path/to/CoreADI.x86_64
cargo run -p atag-agent --locked -- anisette init
```

若已有同版本模拟器注册的机器，可在安装时加 `--machine /path/to/machine`。初始化会验证缓存，或通过 Apple 注册新的机器。后续请求复用 `anisette/mac-coreadi/machine` 的机器标识和注册材料；无需访问 SideStore，也不接收或保存 Apple 账号资料。客户端类型固定与模拟机器一致。

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
cargo test -p atag-agent --locked
cargo clippy -p atag-agent --all-targets --locked -- -D warnings
cargo fmt --package atag-agent --check
node tools/atag-agent/tests/bridge-client-smoke.mjs
```

密码学向量、合成 Apple 上游和临时目录测试不使用真实账户或物理 Tag。网页登录 UX 的浏览器验证也只使用本地测试上游。完整边界见 [LOCAL_AGENT_API.md](../../docs/LOCAL_AGENT_API.md)。
