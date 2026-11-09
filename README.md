# ATAG

ATAG 包含 Find My 广播算法、nRF52832 固件与 OTA bootloader、浏览器管理界面、
本地 Apple 请求桥接，以及配置、量产和诊断工具。

[打开 ATAG 网页](https://lightsing.github.io/atag-pages/)

项目发行版本为 `0.1.0`；自有桥接 API、GATT 协议、Flash 记录和浏览器数据格式
统一从 `v1` 开始。仓库只维护当前实现与当前协议。数据结构校验拒绝其他版本，
不提供旧格式导入、自动迁移或旧接口回退。生成的固件、量产记录、测试输出和构建
缓存不作为源码保留。

## 目录

| 目录 | 内容 |
| --- | --- |
| `atag/` | 无分配的 P-224 轮换密钥、广播数据和配置格式 |
| `firmware-nrf52832/` | 当前应用固件、GATT、Flash 存储与 OTA |
| `bootloader-nrf52832/` | Embassy 应用交换、试启动与回滚 |
| `web/` | 浏览器工作区、Apple 登录、地图和 Web Bluetooth |
| `ios/` | 原生 iPhone App，直连 Apple 查询自己的 ATAG 最后位置 |
| `tools/atag-agent/` | 本地桥接库与 CLI，提供 Anisette 和固定 Apple endpoint 转发 |
| `tools/atag-agent-tray/` | macOS、Windows 和 Linux 托盘程序 |
| `tools/atag-coreadi-worker/` | 独立运行 macOS CoreADI 的 Rust 子进程 |
| `tools/atagctl/` | 配置包、密钥和出厂 profile 生成 |
| `tools/gatt/` | 当前 GATT 管理 CLI 与设置编解码 |
| `tools/ota/` | 签名构建与蓝牙上传 |
| `tools/manufacturing/` | 出厂烧录与逐台验收 |
| `tools/findmy/` | 独立的 Find My 报告 CLI |
| `tools/diagnostics/` | 当前广播与连接时限的硬件检查 |
| `docs/` | 当前网页需求与桥接接口 |

## 环境

使用 Rust 工具链，固件构建安装 `thumbv7em-none-eabihf` 目标。网页需要 Node.js
≥ 22.18，Python 工具需要 Python ≥ 3.11。量产还需要 `probe-rs` 与
`arm-none-eabi-objcopy`。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm --prefix web run install:ci
rustup target add thumbv7em-none-eabihf
```

`.ota/` 保存 OTA 签名私钥，`.findmy/` 保存独立 CLI 的本地查询会话。它们是私密
运行数据，不进入版本控制。固件仅包含公开验证密钥；现有部署的后续签名使用同一
私钥。

## 版本控制与本地文件

源码、测试、文档、构建脚本、`Cargo.lock` 和 `web/package-lock.json` 进入 Git。
网页统一使用 npm 安装；`web/.openai/hosting.json` 是共享站点配置，继续保留。
固件的 `ota-public-key.bin`、S112 SoftDevice 及许可证、Apple 根证书和第三方
许可证也是构建所需的仓库文件。

以下内容由 `.gitignore` 排除：

| 内容 | 存放位置或文件类型 |
| --- | --- |
| 签名私钥、Apple 会话与本机认证材料 | `.ota/`、`.findmy/`、私钥和签名证书文件 |
| 设备密钥、种子、配置包与用户备份 | `*_devices.json`、`*.private-key.bin`、`*.master-private-key.bin`、`*.symmetric-seed.bin`、`*.atag-config.bin`、`*.provisioning-record.bin`、`atag-backup-*.json` |
| 量产输出、固件包与硬件测试记录 | `production/`、`test-artifacts/`、`*.atag-ota` |
| 已安装依赖 | `.venv/`、`web/node_modules/` |
| 构建、测试与开发服务缓存 | `target/`、`.build-host/`、`web/dist/`、`web/.next/`、`web/.vinext/`、`web/.wrangler/`、`web/.sites-runtime/` |
| 本机环境配置与编辑器状态 | `.env*`、`.dev.vars*`、Xcode 用户状态；无敏感值的 `.env.example`、`.env.sample`、`.dev.vars.example` 可提交 |

生成配置包时使用 `test-artifacts/`，量产与发布输出使用 `production/`；自定义
`atag-agent --data-dir` 时也应使用被忽略的本地目录，例如 `.findmy/agent/`。
这些目录可能包含无法重新生成的设备密钥和记录，应单独备份。清理构建缓存时，
不要删除 `.ota/`、`.findmy/`、量产记录或用户备份，也不要直接运行 `git clean -fdx`。

## 验证

```sh
cargo test --workspace --locked
cargo clippy -p atag-agent -p atag-agent-tray -p atag-coreadi-worker --all-targets --locked -- -D warnings
cargo fmt --all --check
.venv/bin/python -m unittest discover -s tools/gatt -v
.venv/bin/python -m unittest discover -s tools/findmy -v
.venv/bin/python -m unittest discover -s tools/manufacturing -v
.venv/bin/python -m unittest discover -s tools/ota -v
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
node tools/atag-agent/tests/bridge-client-smoke.mjs
cargo build-nrf52832 --locked
cargo build-bootloader --locked
```

这些检查不烧录硬件，也不登录真实 Apple 账号。硬件验收步骤见
[固件说明](firmware-nrf52832/README.md)、[量产工具](tools/manufacturing/README.md)
与 [OTA 工具](tools/ota/README.md)。网页和桥接分别见
[web](web/README.md) 与 [atag-agent](tools/atag-agent/README.md)。
真机安装和手机端查询见 [iOS App](ios/README.md)。
