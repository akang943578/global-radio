# Changelog

所有重要变更都会记录在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [2.0.9] - 2026-06-14

### Security

- **使用正经的 release keystore 签名 APK** —— 之前所有 release 包都是用 SDK 自带的 debug keystore 签的，导致：
  - Google Play Protect 每次安装都报"未检测到此开发者上提供的应用，可能不安全"
  - 不同 CI runner 上 debug key 不同，每次升级强制要求用户卸载重装
  - debug key 是所有 Android 开发者机器上随机生成的，安全模型上接近裸奔

  现在使用一份独立生成的 RSA 2048 release keystore（有效期到 2053 年），keystore 文件存放在 GitHub Secrets（base64 编码），CI 在每次构建时解码并签名。本地构建从 `android/keystore.properties` 读取（已加入 `.gitignore`），没配置时退回 debug 签名以保证 `assembleDebug` 仍可用。

  **⚠️ 从 v2.0.6 / 2.0.7 / 2.0.8 升级到 v2.0.9 需要先卸载旧版本再安装**——这是 Android 平台要求，签名变更后无法直接覆盖安装。这一刀切完，从 v2.0.9 起所有后续版本都可以丝滑覆盖升级，Play Protect 也只会在用户首次安装该签名时提示一次，之后版本不再触发。

  Release keystore SHA-256 指纹：
  `9B:C9:13:97:D5:59:F8:7F:E5:7F:2D:99:92:6D:A9:2A:CA:13:A9:B8:59:AD:AB:51:EB:25:AC:BF:A3:6E:AF:19`

## [2.0.8] - 2026-06-14

### Fixed

- **Android 锁屏后几秒内播放停止（v2.0.6 引入的回归）** —— v2.0.6 把 `targetSdkVersion` 升到 34，但 `MediaPlaybackService.startForeground()` 还在用旧的两参数版本。Android 14 (API 34) 严格要求 mediaPlayback 类型的前台服务必须用 3 参数版本传入 `FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK`，否则系统不把它当媒体服务，息屏几秒内就被杀掉。现在按 API 级别分发：API 29+ 用 3 参数版本，老设备保留旧调用。`BackgroundAudioPlugin` 同时加上 `startForegroundService` 失败时降级到 `startService` 的兜底，避免被 `ForegroundServiceStartNotAllowedException` 卡住。
- **Android 前台时不息屏（怀疑由媒体通知触发）** —— HyperOS / MIUI 上有些版本看到"媒体类"通知就强行保持屏幕常亮。`@jofr/capacitor-media-session` 已经在提供真正的锁屏控件，我们自己的 `MediaPlaybackService` 通知没必要再标成 `CATEGORY_TRANSPORT` + `VISIBILITY_PUBLIC`。改成 `CATEGORY_SERVICE` + `VISIBILITY_PRIVATE` + `PRIORITY_MIN`，并从 manifest 里删掉误导性的 `MEDIA_BUTTON` intent-filter，避免被系统当作第二个媒体控制器。

### Improved

- **音频被系统意外暂停时自动恢复** —— 锁屏瞬间 WebView 偶尔会短暂把 `<audio>` 元素停掉（即便前台服务已经持锁）。新增 `playbackIntent` 追踪用户真实意图，监听 `pause` 事件时如果用户其实想"playing"，500ms 后自动 `play()` 一次。15 秒内最多重试 3 次，避免真坏掉的流陷入死循环。

## [2.0.7] - 2026-06-14

### Improved

- **Shell 连接按钮加入加载反馈** —— 输入后台 URL 点"连接"后，按钮立即变灰 + 转圈、文案切换为"连接中…"，并禁用整个表单。之前点击后 `window.location.replace()` 卡在网络请求里完全没有反馈，用户以为没点中。
- 20 秒兜底超时：服务器不可达时自动恢复表单，提示"无法连接到该服务器，请检查 URL 或网络。"
- bfcache 兼容：用户从浏览器历史返回 shell 时自动清掉 loading 态，避免按钮永远卡在转圈。

## [2.0.6] - 2026-06-14

### Changed

- **Android `targetSdkVersion` 33 → 34**：去掉 HyperOS / 新版 MIUI 安装时"为老版本 Android 系统开发"的警告
- `compileSdkVersion` 33 → 34
- AGP 8.0.0 → 8.1.4
- GitHub Actions 工作流安装 `platforms;android-34 build-tools;34.0.0`
- 已在本地 `./gradlew assembleDebug` 验证编译通过

## [2.0.5] - 2026-06-14

### Fixed

- **app 打开时屏幕一直不息屏** —— 上游代码原本用 `navigator.wakeLock.request('screen')`（Screen Wake Lock API）强制屏幕保持点亮来阻止 WebView 暂停音频。这种做法的副作用是用户长时间不操作也无法自动息屏，非常费电。改为 no-op，Android 端依靠 v2.0.4 引入的原生 `MediaPlaybackService`（持有 `PARTIAL_WAKE_LOCK`：CPU 不睡但屏幕可正常息屏）来维持后台播放。

## [2.0.4] - 2026-06-14

### Fixed

- **Android 锁屏几秒内播放停止** —— 之前 `AndroidManifest` 声明了 `MediaPlaybackService` 但根本没有对应的 Java 实现，前台服务从未真正启动。现在补齐 `MediaPlaybackService.java`：启动后获取 `PARTIAL_WAKE_LOCK` + `WifiLock(WIFI_MODE_FULL_LOW_LATENCY)`，显示常驻媒体通知，确保 WebView 在锁屏后不被 Doze 节流。
- `player.ts` 之前只调用 `MediaSession.setActionHandler` 注册回调，从未调用 `setMetadata` / `setPlaybackState`。现在在播放/暂停/恢复/停止时都正确通知系统，锁屏页和通知栏可以显示当前电台。

### Added

- 新增 Capacitor 插件 `BackgroundAudio`（`start/stop`），从 JS 端启停前台服务并附带电台名/国别作为通知内容。
- 检测到小米/红米/POCO 设备时，首次启动会弹出一次性引导，指导用户在 MIUI 设置中放行自启动、关闭省电策略、允许通知、锁定任务卡片。
- 新增权限：`FOREGROUND_SERVICE_MEDIA_PLAYBACK`（Android 14+ 必需）、`POST_NOTIFICATIONS`（Android 13+ 通知需要）。

## [2.0.3] - 2026-06-13

### Fixed

- 已登录用户的 PC 端顶部导航条因为 `TopNavigation.vue` 模板里直接使用了未声明的 `t`，渲染报错导致整条导航不显示 → 改用 `languageStore.t('auth.logoutShort')`，恢复设置 / 主题 / 退出按钮
- `package.json` `scripts` 中重复的 `version:bump` 键

## [2.0.2] - 2026-06-13

### Added

- 设置页「关于」中的版本号现在会在构建时从 `package.json` 注入（通过 Vite `define`），不再硬编码
- `scripts/bump-version.mjs` 一键同步 `package.json` / Android `versionName` + `versionCode` / iOS `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION`
- `npm run version:bump` 脚本入口，支持 `patch | minor | major | <显式版本>`，可选 `--tag` 一键 commit + 打 tag + push

### Changed

- Android `versionName` 同步到 2.0.2（`versionCode = 4`）
- iOS `MARKETING_VERSION` 同步到 2.0.2（`CURRENT_PROJECT_VERSION = 4`）

## [2.0.1] - 2026-06-13

### Security

- 客户端连接页不再预填本地缓存的后端 URL，避免在 Android / iOS / Windows 三端泄漏私有后端地址
- 客户端打开「服务器设置」时强制走 `?change=1` 显示空表单
- `shell/i18n.js` 中所有占位 URL 改为 `https://your-server.example.com`

### Added

- 当本地缓存了上次连接的服务器时，连接页会显示「使用上次的服务器」按钮一键复用（不显示 URL 本身）
- `stream-proxy` 新增 `/api/radio/*` 反向代理，对 `radio-browser.info` 做粘性轮询失败转移，解决移动网络下首页 "Network error"
- 前端 `radioApi` 将本地 `/api/radio` 列为最高优先级 provider，自动回落到公开镜像

### Fixed

- 移除 GET 请求里多余的 `Content-Type` / `User-Agent`，避免不必要的 CORS 预检
- E2E 脚本 `scripts/e2e-bbc.mjs` 改为读取 `E2E_TARGET` 环境变量，不再硬编码私有域名

## [2.0.0] - 2026-06-13

### Added

- **跨平台 Release 流水线**
  - `.github/workflows/release.yml`：推送 `v*` tag 自动并行编译 Android / iOS / Windows 三端，并发布到 GitHub Release
  - `scripts/release-build.sh` / `scripts/release-publish.sh`：本地一键批量构建 + 上传
- **Android 客户端**：Capacitor + 远程壳模式，支持 14 种语言原生菜单
- **iOS 客户端**：Capacitor + Swift 远程壳，支持服务器切换
- **Windows 客户端**：Electron NSIS 安装包，菜单内提供服务器设置入口
- **多用户登录与云端同步**
  - `stream-proxy` 增加 `/api/auth/*`、`/api/user/data` API
  - 收藏 / 历史 / 语言 / 主题按账号保存到服务端 `data/users/<user>.json`
  - `config/users.example.json` 提供账号配置示例
- **HLS 流代理**：`stream-proxy/` 解决 HTTPS 站点播放 BBC、NHK 等 HLS 电台的 mixed-content 问题
- **electron-builder 完整配置**：`productName`、`asar`、NSIS 桌面快捷方式、产物命名等
