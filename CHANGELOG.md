# Changelog

所有重要变更都会记录在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
