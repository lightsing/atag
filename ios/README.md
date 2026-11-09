# ATAG 查找（iOS）

原生 iOS 17+ App，查看自己 ATAG 的最后上报位置、时间、精度和电池电压。iPhone 直接向 Apple 登录和查询位置报告，在本机解密。查询时无需运行 Mac 服务，也不依赖局域网。

Apple 没有给第三方 App 提供读取系统「查找」里的设备或联系人的公开 API。这里查询的是你持有私钥的 ATAG 标签，使用 Apple 的私有接口，能否登录和取得报告由 Apple 决定。

## 安装和使用

1. 在仓库根目录运行 `npm --prefix web run install:ci`，准备构建依赖。Xcode 构建时会打包网页和 iOS 共用的 SRP、报告解密与备份导入代码。使用非标准安装路径时，可用构建设置 `ATAG_NODE` 指向 Node 22.18+ 的可执行文件。
2. 打开 `ios/ATAG.xcodeproj`，在 Signing & Capabilities 选择 Team，选中连接的 iPhone，点击 Run。若默认 Bundle Identifier 已被占用，先改为自己的。
3. 把与已配置标签匹配的 `*_devices.json` 或 ATAG 网页加密备份传到手机，在 App 中点「导入标签档案」。导入上限 16 MiB；网页备份需要密码，手机只导入标签档案和轮换设置。CLI 轮换档案应覆盖当前窗口，可用原配置包通过 `atagctl export-rotating` 重新导出。
4. 在 App 内登录 Apple 账号，按提示选择受信任设备或短信验证。在标签详情页点「查询 Find My」。

## 机器认证

登录和每次查询需要由 macOS 机器身份生成的 Anisette 数据。默认地址是 [SideStore 列出的 v3 服务](https://github.com/SideStore/anisette-servers)，也可在登录页填写自己信任的、提供 macOS 身份的 Anisette v3 HTTPS 服务根地址。服务只收到随机机器标识和机器注册数据，不接收 Apple 密码、验证码、查询令牌、标签私钥或位置。手机将查询会话和机器注册材料保存在本机钥匙串，设备档案保存在受系统保护的 App 容器。

普通 iOS App 没有读取系统 Anisette 的公开 API。手机上模拟 Android CoreADI 可以产生 Anisette，但 [上游实测](https://github.com/malmeloo/FindMy.py/issues/278) 显示 Android 身份即使完成账号验证也可能拿不到 Find My 查询令牌。若 Apple 拒绝机器身份或不签发查询令牌，App 会显示相应错误，不会把账号验证成功当作 Find My 可用。更换服务需重新登录。

## 验证

```sh
xcodebuild -project ios/ATAG.xcodeproj -scheme ATAG \
  -destination 'generic/platform=iOS' -derivedDataPath .build-host/atag-ios \
  CODE_SIGNING_ALLOWED=NO build
npm --prefix web test
```
