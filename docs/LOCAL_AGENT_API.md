# ATAG 网页登录与本地能力桥接 API

更新：2026-11-08。Apple 账号、密码和双重认证验证码由用户在网页操作。浏览器拥有 SRP、认证响应校验、验证状态和最终查询会话；Agent 仅提供 Anisette 与固定 Apple 地址的 HTTP 字节转发，不持有用户登录状态。产品无演示数据源、模拟 Tag 或假位置。

## 职责

| 浏览器 | 本地 Agent |
| --- | --- |
| Apple 密码 SHA256/PBKDF2、SRP-6a（RFC5054 2048-bit group / Apple s2k 与 s2k_fo）、M2 验证与 AES-CBC SPD 解密 | 用模拟 macOS CoreADI 或显式选择的其他来源生成 Anisette |
| 登录、受信任设备/短信方式、发送/重发/提交验证码、过期和取消 | 将明确列入白名单的请求发送到固定 Apple HTTPS endpoint，原样返回状态和响应体 |
| 二次验证后重新 SRP，取得并保存 Find My query session | 不解释 SRP、账户状态或验证码，不建立 challenge、账户或用户任务库 |
| IndexedDB 档案、Tag 私钥/seed、查询设置、历史、报告解密、备份与恢复 | 仅保有运行时 Origin 配置、本机 Anisette 机器材料与运行库缓存 |

## 路由

当前桥接协议为 v1，客户端校验版本和必需能力：

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| GET | /v1/health | service=atag-agent，protocolVersion=1，capabilities.anisette=true、appleRelay=true，storage=none。客户端据此验证服务、版本与能力 |
| POST | /v1/anisette | 请求 source、uid、deviceId、clientProfile；返回 headers、clientInfo、userAgent |
| POST | /v1/apple/request | 请求 endpoint、method、headers、bodyBase64?；返回 status、headers（仅 content-type）、bodyBase64 |

Anisette `source` 省略或为空时使用 `mac-coreadi`（模拟 macOS CoreADI）。首个请求按需从 Apple 下载并验证运行库，并为新数据目录注册机器身份。显式 `local` 仍使用旧的本机后端，也支持 `portable`、`sidestore` 或 HTTPS / loopback HTTP 服务。`clientProfile` 为 `auto`、`macos` 或 `windows`，模拟 CoreADI 和 SideStore 始终使用与机器注册一致的客户端资料。请求不含账号或密码。安装与初始化见 [Agent README](../tools/atag-agent/README.md)。

Apple endpoint 只能为 gsa、mobileme、methods、sms_request、sms_submit、trusted_request、trusted_submit、findmy。各自 URL 和 GET/POST/PUT 方法固定在 Rust，网页无法提交任意 URL、文件路径或命令。Host / Cookie / 转发控制头被拒绝；不跟随重定向，不代理 Set-Cookie，不记录请求体或响应凭据。Apple TLS 仍验证证书，固定 Apple endpoint 使用已有官方根证书。

报告的请求构造、解析、去重、解密和存储都在浏览器完成，仅使用 findmy。Agent 对 Apple 的 HTTP 401 等不作用户状态判断，而是返回原始状态；由网页标记查询会话过期。

## 访问与容量

- 只监听 loopback；精确 Host / Origin、CORS/OPTIONS、私网预检和 Cache-Control:no-store 保留。
- 网页打开时向共享的 IPv4 loopback 端口列表及用户保存的本机地址发送限时健康检查。发现失败可重试或手动连接。连接无需访问令牌，Anisette 机器材料与运行库按需缓存。
- 请求体最多 64 KiB，固定转发方法、头和 Base64 大小受限；每次上游响应最多 8 MiB，最多 2 个并发请求。连接/上游与总请求有超时。
- Apple 上游使用独立的 HTTP/1.1 连接，禁用空闲连接复用，避免 GrandSlam 初始化成功后，密码证明请求在复用连接上一直等待响应。TLS 证书验证和现有超时预算保持启用，不自动重发认证请求。
- Apple 认证步骤的上游超时为 60 秒、HTTP 桥接为 65 秒、浏览器为 70 秒。Find My 报告上游超时为 20 秒。Anisette HTTP 桥接为 245 秒、浏览器为 250 秒，覆盖本地/便携子进程的 240 秒初始化预算。手动健康检查最多等待 8 秒，自动探测的 5 秒预算从 Chrome 授权后开始计算。
- 仅 Anisette 来源可由用户显式选择远端；Apple 认证/查询凭据不会附带到 Anisette 提供方。
- HTTPS 网页到 loopback 的系统权限限制仍可能影响连接；离线档案和历史不依赖 Agent 或 Apple 登录。

## 浏览器登录生命周期

- 提交密码后计算内存中的 SHA256，再按 Apple 返回的 salt/iterations 生成 SRP 证明；原始密码和密码哈希不发送给 Agent。M2 通过后才解密 SPD，验证码阶段保留的材料仅在内存。
- 设置页在非密码错误后保留内存中的密码供手动重试，包括网络超时、账户处理要求、验证码错误和验证过期。只有 Apple 明确返回账户/密码错误（`-20101`）才按凭据错误清空；通用 `AUTH_REQUIRED`、HTTP 401/403 不作为密码错误。成功、取消或关闭设置也清空密码，始终不持久化。
- 验证方式只能来自 Apple 响应。用户明确点击才发送，支持受信任设备与掩码短信号码；最多发送 5 次、提交 3 次，总生命周期 10 分钟。
- 进行中的页面显示机器认证、登录初始化、密码验证等步骤。请求超时标明失败步骤；密码证明和验证码不会自动重发。
- 验证码通过后重新进行 SRP，再请求 mobileme delegate；其临时 PET 会随 Apple 请求转发，原始 Apple 密码不会作为 delegate password 发送。
- 只有完整成功且 IndexedDB 原子提交后显示已登录。密码/验证码/PET/IDMS challenge/SRP secret 不落盘或进入备份。只有最终 query account 和 Anisette 来源可持久化。
- 关闭设置、取消、换桥接、卸载、过期都会终止未完成流程。异步迟到响应不能继续请求或提交新会话；失败和取消保留先前有效登录。
- 退出登录仅移除 query session，设备、Tag 私钥和历史不受影响。备份默认不包含 query account，用户可明确勾选；从不包含密码或验证码。

## 浏览器数据

浏览器保存昵称、图标、颜色、Tag 主私钥/seed、芯片绑定、轮换窗口和历史。支持本机生成、相同档案重建配置、密码加密备份与原子合并恢复。账户只通过网页登录，或用户明确选择的加密备份恢复；没有独立会话文件登录入口。工作区只接受当前 schema 1；不执行格式迁移。

测试中的合成 Apple 上游、密码学向量和 fake GATT 仅用于自动验证，不被页面导入，也不构成产品数据源。
