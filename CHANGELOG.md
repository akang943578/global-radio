# Changelog

所有重要变更都会记录在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [2.0.16] - 2026-06-14

### Fixed

- **下拉播放卡片上的电台 logo（artwork）缺失** —— v2.0.14/v2.0.15 为了让 MediaStyle 大卡片稳定显示，`announceNativeMetadata()` 里硬塞了 `artwork: []`，因为 `@jofr/capacitor-media-session` 的 Android `urlToBitmap` 会在主线程同步 `HttpURLConnection` 抓 favicon，没有超时，favicon 慢 / 挂 / CORS 拦截就把 setMetadata 整个干掉、连带 startForeground 5s 窗口都错过。代价是卡片上没图。
- 修复：在 JS 端**异步**拿 favicon 转 base64 data URI，再传给 `MediaSession.setMetadata`。原理：我们已经 patch 过的 Android 端 `urlToBitmap` 仍然支持 `data:image/...;base64,...` 路径（纯 in-process 解码，零网络 IO），所以 base64 data URI 给原生不会再阻塞主线程：
  - 4 秒 `AbortController` 超时 + `credentials: 'omit'`，favicon 服务器再烂也不会卡住；
  - 256 KB 上限 + Content-Type 校验，防止误拉到 HTML/巨图；
  - 按 URL Map 缓存，电台切回去 / metadata 重播秒读不再抓一次；
  - **两步法**：先无 artwork `setMetadata` 一次让大卡片立刻贴出来（保证 startForeground 时序），抓完图后再 `setMetadata` 第二次替换为带图版本；
  - 抓图过程中如果用户已经切到别的电台，跳过覆盖，避免错位。

- **搜索按钮"输入文字后依然浅蓝（看上去 disabled）"** —— v2.0.14 引入了 `hasInputText` ref 直接从 DOM input 同步，按钮 class 也用上了，但用户反馈仍然没变蓝。根因有两条同时存在：
  1. Tailwind v3 的 `bg-ios-blue/40` 这个 opacity-modifier 类没被打包到 production CSS（content extractor 没扫到 / purge 误杀），所以"未激活态"压根没有正确背景色；
  2. `hasInputText` 单一依赖 `@input/@keyup/@composition*` 事件回调里读 DOM `input.value`，Android WebView 在 IME composition 阶段读出来是空串，更新滞后。
- 修复：
  - 按钮颜色改用 `:style` 内联 `backgroundColor: '#007AFF'` / `rgba(0, 122, 255, 0.4)`，完全绕开 Tailwind purge，class 链彻底干净；
  - 新增 `isSearchButtonActive = computed(() => hasInputText.value || hasSearchText.value)`，两路反应源任意一个为真就变蓝——v-model（`hasSearchText`）覆盖一般 / 英文输入，DOM 实时同步（`hasInputText`）覆盖 IME composition 滞后场景。

## [2.0.15] - 2026-06-14

### Fixed

- **媒体大卡片 + Playback channel 真正修复**（v2.0.13/v2.0.14 都没修干净）—— 之前两版只改 JS 端（不传 artwork），但 PWA SW 可能还在缓存老 bundle，且 `@jofr/capacitor-media-session` 的 Java 实现自身还有两个独立的 race condition。这次用 [patch-package](https://github.com/ds300/patch-package) 直接给 `@jofr` 的 native 代码打补丁（patch 进 APK，跟 PWA 版本无关）：
  - **`MediaSessionPlugin.urlToBitmap`**：原版会在主线程同步 `HttpURLConnection.connect()` 抓 http(s) artwork，无超时，favicon 一卡就把整个 `setMetadata` 干挂。Patched 直接 `return null` 跳过 http 路径（base64 data URI 仍然支持，因为是纯解码不走网络）。
  - **`MediaSessionService.onCreate`**：新增——立刻创建 `Playback` notification channel，保证用户首次启动 app 时系统通知设置里就能看到这个 channel（不再依赖 `connectAndInitialize` 成功跑完）。
  - **`MediaSessionService.onStartCommand`**：新增 `ensureForegroundStarted()`，**立刻**调 `startForeground()` 贴一张占位 notification。Android 14 给 service 只有 5 秒窗口从 `startForegroundService()` 到 `startForeground()`，原版要等 `bindService` → `onServiceConnected` → `connectAndInitialize` 这条异步链才调用，在慢设备/MIUI 上很容易超时被系统干掉。
  - **`MediaSessionService.connectAndInitialize`**：如果 `ensureForegroundStarted` 已经贴过占位通知，这里改用 `notify()` 把它替换成带 MediaStyle 的真大卡片，不再重复 `startForeground`。
  - **`MediaSessionPlugin.startMediaService`**：给 `startForegroundService` / `bindService` 加 try-catch，`ForegroundServiceStartNotAllowedException` 走 `startService()` 降级，不会再让一个 exception 把整个播放动作弄崩。
- 用 patch-package 的好处：`npm install` 时通过 postinstall 钩子自动 apply，CI 也能用，patch 文件在 `patches/` 目录跟代码一起入库。

## [2.0.14] - 2026-06-14

### Fixed

- **播放卡片大概率仍然不出现 / 系统通知设置里没有 "Playback" channel** —— v2.0.13 只是去掉了双前台 service 的冲突，没解决另一个隐蔽更深的问题：`@jofr/capacitor-media-session` 的 Android 实现里，`setMetadata()` 会在**主线程同步** `HttpURLConnection.connect()` 抓 `station.favicon` 当封面图，**而且没有超时**。`radio-browser.info` 返回的电台 favicon 经常是慢/挂/CORS 拦截/重定向死循环的破图，整个 `setMetadata` 直接抛 `IOException`，被我们 `catch` 后吞掉，但**后面的 `setPlaybackState('playing')` 时序乱掉**，service 来不及在 5 秒窗口内 bind + `startForeground()`，于是 Android 14 把 service 直接干掉——MediaStyle 大卡片不出现，"Playback" 通知 channel 因为 `connectAndInitialize()` 从来没跑过也根本没被创建。
- 修复：`announceNativeMetadata()` 显式传 `artwork: []`，完全跳过 @jofr 那段主线程 HTTP 同步抓图逻辑。代价是下拉通知卡片里没有电台 logo 缩略图，但播放/暂停按钮 + 电台名 + 国家全在。后续如果想要封面图，正确做法是 JS 端先把 image 抓下来用 `URL.createObjectURL(blob)` 转 base64 再传给 `setMetadata`，或者等上游修复，先不做。

- **搜索按钮"输入文字后没变蓝"** —— v2.0.12 的按钮颜色绑定到 `hasSearchText`，它是 `computed` 出来读 `searchQuery.value`。但 Android WebView 上 v-model 在 IME composition 阶段更新会滞后于 DOM `input.value`，导致用户看到自己已经输入文字、按钮也能点了，颜色却仍然是浅蓝色，看上去像 disabled。
- 修复：加了独立的 `hasInputText` ref，直接在 `@input` / `@keyup` / `@compositionupdate` / `@compositionend` 事件里从 `input.value` 实时同步，按钮视觉跟 v-model 解耦。`searchQuery = item; performSearch()` 那个历史项点击也抽成 `selectHistoryItem(item)` 一起更新。

## [2.0.13] - 2026-06-14

### Fixed

- **下拉通知栏里的播放大卡片消失** —— v2.0.6 引入的 `MediaPlaybackService` 跟 `@jofr/capacitor-media-session` 内置的 `MediaSessionService` **互相挤掉对方的媒体通知**：两个 service 都声明 `foregroundServiceType="mediaPlayback"`，Android（尤其 MIUI/HyperOS）的媒体控件面板只会留一条媒体类前台通知，于是只有先注册的那个胜出。v2.0.8 我又把我们这条通知降级成 `PRIORITY_MIN` + `CATEGORY_SERVICE`，结果反而让系统更倾向于把我们这条极简通知当成主媒体通知，把 `@jofr` 的 MediaStyle 大卡片完全藏起来。
- 修复：
  - 删除我们自己写的 `MediaPlaybackService`，让 `@jofr` 那个 service 独占 `mediaPlayback` 前台通道——它的 `MediaStyle` 通知（带电台名 / 封面 / 播放暂停按钮）会重新出现在下拉栏；
  - WakeLock / WifiLock 不需要靠 service 持有，直接放在 `BackgroundAudioPlugin` 里。`BackgroundAudio.start()` 时 acquire、`stop()` 时 release，对外 API 完全不变，`player.ts` 不需要改一行；
  - 锁仅在播放时持有，停止后立刻释放，不会影响系统息屏时机。
- 副作用：v2.0.8 修的"前台一直亮屏"和"息屏几秒后断流"这两条理论上更稳了，因为 `@jofr` 那条 MediaStyle 通知本来就是 `CATEGORY_TRANSPORT`（系统认定的播放通知），不会触发某些 ROM "看到 service 通知就保持亮屏"的逻辑，息屏判定也更标准。

## [2.0.12] - 2026-06-14

### Fixed

- **搜索按钮"显示但点不动"** —— v2.0.10 的搜索按钮用 `:disabled="!hasSearchText"` 控制可点性，在某些 Android WebView 上 `disabled` 属性配合 `cursor-not-allowed` 类名会让按钮的 click 事件被吞，即使 `hasSearchText` 已经变 true 也无法触发。
- 改成永远不带 `disabled`，按钮始终可点；点击时通过 `searchInputRef.value` 把 DOM input 的当前值强制 sync 到 `searchQuery`，再调 `performSearch`，绕开 v-model + IME composition 可能的时序问题。视觉上保留"空输入时按钮变浅"的提示。
- 顺便给两个 button 加上 `type="button"`，防止极端情况下被解析成 submit。

### Improved

- 点击搜索按钮时主动 `inputEl.blur()` 收起虚拟键盘，防止部分国产 ROM 上 IME 浮窗吞掉 click 事件。

## [2.0.11] - 2026-06-14

### Fixed

- **PWA Service Worker 卡在旧 bundle 永不更新** —— 用户反馈 v2.0.10 装上后搜索按钮还是不出现、设置也进不去，但服务器实际已经部署了修复版。根因：
  - 之前的 PWA 配置缺 `skipWaiting` + `clientsClaim`，新 SW 装好后会进入 "waiting" 状态，要等所有客户端关闭才接管，但 Capacitor WebView 生命周期里"app 后台不关闭，前台 resume 不重新注册"，所以 SW 永远不更新；
  - `dist/registerSW.js` 是 vite-plugin-pwa 默认注入的最简注册脚本，`registerType: 'autoUpdate'` 只是表示"不弹窗静默装"，不会自动刷新页面，导致用户即使新 SW 装好了也仍然看老 bundle。
- 修复：
  - workbox 加上 `skipWaiting: true` + `clientsClaim: true` + `cleanupOutdatedCaches: true`；
  - `src/main.ts` 显式用 `registerSW({ immediate: true, onNeedRefresh: () => updateSW(true) })`，新 SW 装好后立刻触发整页刷新；
  - 每 30 分钟主动调一次 `registration.update()`，保证后台跑着的 app 也能及时拿到新代码；
  - 给 `index.html` / JS / CSS 的同源请求加 `NetworkFirst` 策略（5s 超时回退缓存），离线兜底 + 在线总是新版本。
- **⚠️ 一次性手动操作**：从 v2.0.10 及之前升级到 v2.0.11 的用户**必须**先 "系统设置 → 应用 → 全球电台 → 存储 → 清除缓存"（或卸载重装）一次，把旧 SW 踢掉。之后再升级版本就丝滑无感了。

## [2.0.10] - 2026-06-14

### Fixed

- **搜索页：手机端搜索按钮"出不来"** —— 之前搜索按钮带着 `v-if="searchQuery && searchQuery.trim()"`，必须等用户已经在输入框里敲了字才会出现。这在 Android Capacitor WebView 上特别容易翻车：v-model 配合自定义 `@input` 在中文输入法 composition 阶段时序不稳，按钮要么晚出现要么干脆不刷新，用户的本能反应就是"按钮没了，没法搜索"。
- 现在按钮**永远显示**：输入框为空时按钮显示成灰色禁用状态，输入文本后变蓝可点。同时按钮稍微放大（`p-1.5`）方便拇指点击。`hasSearchText` 改用 `computed` 防御异常状态，避免 reactivity 跑偏时按钮闪。

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
