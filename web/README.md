# ATAG 网页 App

网页管理 ATAG 档案、Find My 位置报告和附近的蓝牙设备。用户数据归浏览器所有：
IndexedDB 保存私钥、种子、芯片绑定、查询设置、历史报告和 Apple 查询会话。
本地 `atag-agent` 提供 Anisette 和固定 Apple 地址的请求转发。

## 开发与验证

需要 Node.js ≥ 22.18。

```sh
npm run install:ci
npm run dev
npm test
npm run typecheck
npm run build
```

开发端口为 5173，生产构建使用 Vinext / Vite 和 Sites 插件，输出到 `dist/`。
`.openai/hosting.json` 保存站点配置。构建、测试和发布输出不进入源码。

公开站点在 [ATAG Pages](https://lightsing.github.io/atag/)。`main` 的网页改动由
GitHub Actions 构建并部署。要在本地验证相同路径，设定 `ATAG_PAGES_BASE_PATH=/atag`
并运行 `npm run build:pages`，输出位于 `out/`。

## 数据与备份

设备档案可离线创建、编辑和删除。固定档案持有一把私钥；轮换档案持有主私钥和
对称种子，并按用户指定的起始轮次与查询数量派生密钥。创建档案后为草稿，收到
Tag 的密钥提交回执才绑定芯片序列号。可以从已保存的档案重建同一份配置包。

设置中的“数据与备份”支持密码加密下载、解密预览和原子合并恢复。默认不包含
Apple 查询会话；密码和验证码永不包含。密钥或芯片绑定冲突时整体
拒绝，重复恢复不重复记录。工作区使用 schema 1，仅接受当前数据结构。

清除站点数据或更换浏览器会丢失本地私钥，请保管加密备份。IndexedDB 没有额外的
应用密码保护。普通显示偏好和桥接地址保存在 localStorage，不进入备份。

## Apple 登录和报告

```sh
cargo run -p atag-agent -- serve
```

网页打开时自动探测本机 Agent。探测失败后，在设置中重试，或填写托盘和 CLI
显示的 loopback 地址。Chrome 弹出本地网络权限提示时，网页会等待，选择「允许」后
会继续自动连接。浏览器
计算 SRP 证明、校验服务端证明并处理双重认证；最终查询会话在完整成功后原子保存。
验证码只能通过用户选择的真实验证方式发送。关闭设置、取消或断开桥接会终止
未完成的登录，失败不会覆盖已有会话。

默认的 `mac-coreadi` 来源使用随托盘打包的 Rust worker。首次登录时 Agent 会从 Apple
下载并校验 CoreADI 运行库，再注册机器身份。[准备流程](../tools/atag-agent/README.md#anisette)

刷新报告使用 `findmy`：桥接返回密文，浏览器解密、校验、去重并保存。没有新
报告是正常结果。报告电池电压固定按 2.4–4.2 V 六位编码解析，不换算百分比。
列表、地图和 24 小时 / 7 天历史联动；离线时仍可查看已保存的数据。

## 附近管理

当前协议见 [固件说明](../firmware-nrf52832/README.md)。Web Bluetooth 需要安全
上下文和支持该 API 的浏览器；不可用时页面明确提示，档案和备份仍可使用。

- 短按 Tag 开窗，按服务 UUID 选择设备；公开读取身份、电池电压和按键计数。
- 启用加密管理后读取名称、设置和 40 字节遥测。只有配对状态 2 才表示已加密。
- 浏览器屏蔽标准序列号特征，芯片序列号取自加密遥测。档案按序列号绑定。
- 改名、设置、密钥写入只认本次匹配的 Flash 提交回执。ATT 响应和断连不代表成功。
- 按键计数变化可辨认设备。LED 查找需要明确硬件能力、加密连接及已保存的启用设置；
  闪灯最多 10 秒，停止、断连、禁用或 OTA 会取消。无 LED 硬件使用按键辨认。
- 重启和恢复出厂在重连后核验。连接时限从原连接时间计算，按键和 LED 不延长时限。

网页不提供 OTA、响铃、UWB 或 GPS 读取。真实 Apple 账号、系统配对和硬件行为需要
单独联调；自动测试使用合成 Apple 上游与 fake GATT，不连接真实账号或 Tag。

## 代码入口

| 路径 | 职责 |
| --- | --- |
| `components/atag/` | 页面、工作区和附近管理会话 |
| `lib/workspace/` | 数据 schema、IndexedDB、密码学、备份和报告 |
| `lib/auth/` | 浏览器 Apple 登录、SRP 与 plist |
| `lib/agent/bridge-client.ts` | 当前 v1 本地桥接传输 |
| `lib/ble/` | 当前 GATT 协议、校验和蓝牙客户端 |
| `lib/client-support.ts` | 错误、地址校验和报告任务轮询 |
| `tests/` | 协议、密码学、备份、登录与蓝牙回归测试 |

产品约束见 [网页需求](../docs/WEB_APP_REQUIREMENTS.md)，桥接接口见
[本地 API](../docs/LOCAL_AGENT_API.md)。
