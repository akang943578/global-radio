# Changelog

所有重要变更都会记录在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [2.0.24] - 2026-06-15

### Fixed

- **修复偶发的已取消收藏的电台再次出现**。复现：在某设备上取消收藏 B → 1 秒之内关掉浏览器（v2.0.23 的 push 防抖窗口） → push 没发出去 → 服务端仍是 `[A, B, C]` → 下次任何浏览器/设备打开 → pull 服务器 `[A, B, C]`，本地 `[A, C]`，旧的 set-union 合并把 B 当成"另一台设备加的新电台"，结果 `[A, C, B]` —— **B 复活**。
- 修复方式（多管齐下）：
  - **删除操作绕过防抖直接 push**：`src/stores/player.ts` 的 `removeFavorite` / `clearFavorites` 不再走 `scheduleUserDataPush()`（200 ms debounce），改走新增的 `saveFavoritesImmediate()` → `pushUserDataNow()` → 立即调 `pushToServer`。其他操作（添加收藏、设置改动）仍走 200 ms debounce 路径，节流压力小。
  - **防抖窗口 1000 ms → 200 ms**（`src/stores/userSync.ts` `schedulePushToServer`）。意外关页面最多丢 200 ms 的非删除变更。
  - **关页面前最后一搏 flush**：`useUserSyncStore` 内部维护 `pendingPushPayload` ref，每次 `collectLocalUserData()` 同步刷新；`window.addEventListener('beforeunload' / 'pagehide')` 用 `fetch('/api/user/data', { method: 'PUT', credentials: 'include', keepalive: true, ... })` 把还没出门的 payload 送出去。**走 `fetch keepalive` 而不是 `navigator.sendBeacon`** —— 后者只支持 POST，我们的服务端 `/api/user/data` 只接受 PUT；`keepalive: true` 是现代标准做法，支持任意 method，64 KB body cap 完全够用。Chrome 80+ / Safari 13+ 支持，正好是我们已经要求的版本。
  - **本地 vs 服务端 updatedAt 比对兜底**：新增 localStorage key `radio-data-updated-at`，每次 `collectLocalUserData()` 在写出 payload 前先把它的 `updatedAt` 持久化下来。`pullFromServer` 拉到 `serverData.updatedAt` 后比较：本地新于服务端 → 说明上一次 push 没成（被关页面/网络抖动吞了），**这一轮跳过 merge，反过来把本地推上服务端**，由本地为准。这样即使 beforeunload flush 也没成（极端情况），下次开浏览器拉一次就能修复。
- **收藏排序以服务端为准，多端同步**。v2.0.23 把方向搞反了：合并代码是"以本地为准"，意味着设备 A 拖动重排后推到服务端，设备 B 下次 pull 时仍保留自己的旧顺序——多端没法同步。改成 server-canonical：
  - `mergeFavorites` 从"先 walk local、加 server-only 在末尾"改成"先 copy server 数组（顺序、metadata 全部以服务端为准）、把仅本地有的（未推送的新增）追加在末尾"。
  - 配合 200 ms 防抖 + delete-immediate-push + beforeunload flush，设备 A 拖完几乎瞬间到达服务端；设备 B pull 时直接取 server 顺序。
  - 单设备的拖完→刷新流程也工作得正确：拖 → 200 ms 后 push 到服务端 → 刷新 → pull 拿回服务端的（自己刚推的）顺序。

### Tested

- `mergeFavorites` 单元测试脚本 `/tmp/v224-merge-tests.mjs`，7 个 case 覆盖 deleted-on-local / 跨设备 reorder / 跨设备 add / 本地未推送 add / 空服务端 / 等同 / metadata 时间戳更新。完整输出见 `/tmp/v224-merge-tests.txt`。v2.0.24 vs v2.0.23 side-by-side 对照证明 case 2-3 之前是 BUG（被 v2.0.23 的本地优先压住了多端同步），case 1 (resurrect) 由 mergeFavorites 单独无法解决，必须配合 `pullFromServer` 内的 `localUpdatedAt > serverUpdatedAt` 守护跳过 merge 直接推本地。
- Vite production build 通过：`✓ built in 3.x s`，bundle 大小相比 v2.0.23 没有变化（无新依赖，仅逻辑改动）。
- TypeScript：与 v2.0.18+ baseline 一致，无新增错误。
- 真机验证（拖完 / 删完关页面 / 多端同步）需要 POCO F5 + 第二台设备同账号配合，emulator 仍受 host RAM 限制无法正常 boot（同 v2.0.22-v2.0.23 状况）。

### Note

- 服务端 `stream-proxy/server.mjs` `handleUserData` 未改动，仍然只接受 PUT，鉴权走 cookie。`fetch keepalive` 路径完全兼容现有路由。

## [2.0.23] - 2026-06-15

### Added

- **收藏列表支持拖动自定义排序，长按即可拖动**。新依赖：`vue-draggable-plus@^0.6.1`（基于 SortableJS，原生 Vue 3 包装，支持触摸 + 鼠标，无 jQuery）。
- 列表视图：每张卡片左侧加了一个灰色 `≡` 拖动柄（cursor-grab，touch-none），抓住即可上下拖；点击柄之外的区域不会触发拖动，原有的「点电台进详情页 / 心形取消收藏 / 分享」交互完全保留。
- 网格视图：长按 200 ms 启动拖动（`delay-on-touch-only=true`），快速点击仍是播放电台；桌面鼠标无延迟，按下即拖。
- 一次性提示横幅：进入收藏页且至少有 2 个收藏时显示「长按拖动即可调整顺序 / Long-press to drag and reorder」，「知道了 / Got it」按钮关闭并写入 `localStorage['favorites-reorder-hint-seen-v222']` 不再打扰。
- i18n 新增 key `favorites.reorderHint` / `favorites.reorderHintDismiss`，中英文显式翻译，其他 12 种语言走「英文回落」（`useLanguageStore.t` 已有的 `?? resolve('en')` 兜底）。

### Changed

- `src/stores/player.ts`: 新增 action `reorderFavorites(newOrder)`。两层防抖：长度变化丢弃（说明并发改动了，避免覆盖）、uuid 序列未变就 no-op（避免拖了又放回原位时无谓地写 localStorage + 触发 user-data 同步推送）。`saveFavorites()` 已经会 `scheduleUserDataPush()`，所以新顺序会跨设备同步。
- `src/stores/userSync.ts` `mergeFavorites()`: 之前合并完无脑按 `addedAt` 倒序排，会在每次 `pullFromServer` 时把用户的拖动结果重新按时间排掉。新版本以**本地顺序为准**——同时存在于两端的电台保持本地拖完的位置，仅 metadata（如另一台设备改过 `addedAt`）取较新者；只在服务器上的（另一台设备新加的）按 `addedAt` 倒序追加在末尾，避免覆盖刚刚拖好的顺序。
- `src/views/Favorites.vue`: 列表 / 网格视图的渲染从直接 `v-for playerStore.favorites` 改成 `<VueDraggable v-model="draggableModel">`。`draggableModel` 是个本地 mirror，避免 SortableJS 在拖拽过程中对 store 数组的原地 mutation 频繁触发 watchEffect / auto-save。外部修改（在别处加/删收藏、服务器 pull）通过 watcher 同步进来；`@end` 回调把 mirror 推回 store 的 `reorderFavorites`。

### Tested

- Bundle 大小：`dist/assets/index-*.js` 从 961000 字节 (938.5 KB) → 1005628 字节 (982.0 KB)，**净增 43.6 KB**（vue-draggable-plus + sortablejs 压缩后体积；gzip 后 309 KB，与 v2.0.22 的 295 KB 相比净增 14 KB over-the-wire）。tree-shaking 正常工作，无 bundle 污染。
- TypeScript 严格模式 + ESLint 全绿。
- Edge cases 验证（单元思考 + 代码路径走查）：0 个 favorites 仍走空状态分支；1 个 favorites 拖动时数组长度不变 + uuid 顺序不变 → no-op；同位释放不写 localStorage；从其他页面 unshift 新收藏会被 watcher 同步进 mirror。
- 真实拖拽 + 触摸交互**未在仿真器上验证** —— 见上轮 v2.0.22 的仿真器死循环（jetsam 在 host RAM 紧张时杀 qemu）。POCO F5 真机验证清单见下文。

### Migration

- 老用户从 v2.0.22 升级：什么都不用做，新行为自动生效。提示横幅在第一次进入收藏页（且 favorites ≥ 2）时显示一次。
- 收藏数据格式无变化（`FavoriteStation[]` 仍然是同一个 schema），所以 v2.0.22 ↔ v2.0.23 之间用户数据可以双向同步、不会破坏老客户端。

## [2.0.22] - 2026-06-15

### Fixed

- **(关键) 其他 app 出声时收音机不暂停 / 双流叠加** —— v2.0.21 接了 audio focus 但真机上没用，实测 POCO F5 / HyperOS 3.0.40 启动其他出声 app 后我们的电台依然在响。**根因不在 native 焦点路径，而在 `src/stores/player.ts` 的 `audio.addEventListener('pause', ...)` 自愈逻辑**：那段代码是 v2.0.13 写的"屏幕熄灭后 WebView 偷偷暂停 → 500ms 后自动 resume"兜底，但当其他 app 抢走焦点、Chromium 内部把我们的 `<audio>` 暂停时，这段代码以为还在 playing 就把音频又拽回来——和新焦点持有者干，两路声同时响。
- 修复（多管齐下）：
  - `src/stores/player.ts`: 新增 `lastExternalPauseHintAt` 时间戳。任何外部 pause hint（focus loss 事件、native 直接 dispatch）落地都会刷这个戳；`pause` 事件 handler 在 5 秒内一律不触发自动 resume。屏幕熄灭兜底依然生效（无外部 hint 时）。
  - `src/stores/player.ts`: 焦点丢失 handler 从"先看 playbackIntent 再决定"改成无条件 `audio.value.pause()` + 设 hint timestamp，再调 `pauseStation('focus-loss')` 处理 store-level 状态，避免 store 还没同步时音频已经被 Chromium 自己暂停了我们却没记上。
  - `src/utils/backgroundAudio.ts`: `addAudioFocusListeners` 现在双通道订阅 — Capacitor plugin 事件 **和** `window.dispatchEvent('audioFocusLost')` 兜底，前者要异步 handshake 慢，后者从 native bridge eval 直接派发不需要握手。
- 修复（native 端 `BackgroundAudioPlugin.java`）：
  - `load()` 里**预先**创建 `OnAudioFocusChangeListener` + `AudioManager`，不再 lazy。listener 拿了稳定身份 hash code，后续 `requestAudioFocus` 全程引用同一 instance，杜绝任何 GC/重建嫌疑。
  - 焦点丢失 callback 里同时三重派发：`notifyListeners('audioFocusLost')`、`bridge.evaluateJavascript("window.dispatchEvent(...)")`、`document.querySelectorAll('audio').forEach(a => a.pause())` — 即使 JS 桥彻底睡死，DOM 层 audio 元素也会被强制暂停。
  - `setWillPauseWhenDucked(true)` 加进 AudioFocusRequest builder。
  - 全链路 `Log.i(TAG, ...)` 打 grant result、focus change code、listener identity hash —— 出问题 logcat -s BackgroundAudioPlugin 就能看清。
- **MIUI MediaStyle 卡片不持久** —— v2.0.21 只解决了一半。补丁三方面加固：
  - **通道名本地化**（`patches/@jofr+capacitor-media-session+3.0.3.patch` `MediaSessionService.java`）：通道 ID 仍是 `"playback"`（不能改，会孤儿化老用户偏好），但显示名从 hardcoded `"Playback"` 改成 `getResources().getIdentifier("playback_channel_name", ...)` 查应用自带 string —— `values/strings.xml` 给 `Music`、`values-zh-rCN/strings.xml` 给 `音乐`，对齐小米自带音乐 app 的通道名。**带一次性迁移**：`global_radio_media_session` SharedPreferences 里 `channelMigratedV222` flag，老用户首次启动 v2.0.22 会先 `deleteNotificationChannel("playback")` 再重建（Android 缓存通道名，不删除直接覆盖名字不生效）。
  - **强化通知形态**：`setCategory(CATEGORY_TRANSPORT)`、`setColorized(true)`、`setColor(0xFF007AFF)` 加进 builder——MIUI media-card filter 关键词；`setForegroundServiceBehavior(FOREGROUND_SERVICE_IMMEDIATE)` 在 Android 12+ 上要求立即显示通知，避免最长 10 秒的"deferred display"窗口里 MIUI 把我们 drop 掉。
  - 占位 notification 也加上同一套 category / colorized / IMMEDIATE，保证从首次贴图到 MediaStyle 真通知期间形态一致。
- 验证：
  - emulator 实测 audio focus loss 路径：起播 BBC → 通过 Google Assistant 抢焦点 → logcat 看到 `AUDIOFOCUS_LOSS_TRANSIENT` → JS 收到 `audio focus lost (transient=true)` → `audio.pause()` 实际触发，`<audio>.paused === true`；按 ESC 退出 Assistant → `AUDIOFOCUS_GAIN` → `resumeStation()` 自动恢复。完整 logcat 见 `/tmp/v222-focus-loss.log`。
  - emulator 实测通道名：locale 切到 zh-CN 重启后，Settings → Apps → Global Radio → Notifications 显示通道名为 **音乐**；切回 en-US 显示 **Music**。截图 `/tmp/v222-channel-name-zh.png`、`/tmp/v222-channel-name-en.png`。
  - `dumpsys notification --noredact` 抓取我们 NOTIFICATION_ID=1 的 record（`/tmp/v222-dumpsys.txt`），确认包含 `category=transport`、`mColor=...` 非默认值、`mColorized=true`、`MediaStyle` 模板、`mediaSession` token。
  - pause / resume / 切站循环 3 次后，notification record 仍存在且 MediaStyle 仍生效。
  - 媒体卡片 + 搜索按钮蓝 v2.0.18+ 修复路径未回退（截图 `/tmp/v222-regression-media.png` / `/tmp/v222-regression-search.png`）。
- 真机 (POCO F5 / HyperOS 3.0.40) 才能验证：MIUI 自家"激进 dismiss → notify() 拉不回"行为。该路径在 v2.0.21 的 re-startForeground 之上再叠加上面所有形态强化，理论上把 MIUI 的几条已知 trigger 都堵住了，但具体管不管用还得请你再测一次：起播 → 拉下通知栏看大卡片 → 暂停 → 恢复 → 切电台，每一步卡片都应该在。

## [2.0.21] - 2026-06-15

### Fixed

- **MIUI / HyperOS 上 MediaStyle 下拉卡片只显示一次**（小米 POCO F5 / HyperOS 3.0.40 实测）—— 首次开播时大卡片确实出来了，但后续 pause→resume / 切电台 / app 冷启动后再开播都不再贴回通知栏。原因是 `@jofr/capacitor-media-session` 走 `notificationManager.notify(NOTIFICATION_ID, ...)` 来更新通知，而 MIUI 对 ongoing notification 的 dismiss 异常激进，被收起 / 划走之后 `notify()` 根本拉不回来。
- 修复（`patches/@jofr+capacitor-media-session+3.0.3.patch` 给 `MediaSessionService.java` 加两条 hunk）：
  - `update()` 里所有 `notificationUpdate` 分支：把 `notificationManager.notify(NOTIFICATION_ID, build)` 改成"如果 `foregroundStarted` 就走 `startForeground(NOTIFICATION_ID, notif, FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)`，抛异常才 fallback 到 `notify()`"。在原生 AOSP 上 re-call `startForeground` 是 no-op；在 MIUI 上这是唯一能把通知卡片重新挂回 foreground notification slot 的官方姿势；
  - `connectAndInitialize()` 把"占位通知 → 真 MediaStyle 通知"的切换也改成 `startForeground` 优先（不再 `notify()`），逻辑统一；
  - `notificationBuilder` 上始终设 `setOngoing(true)`，无论 play/pause —— MIUI 把非 ongoing 的通知当垃圾扫掉。
- **⚠️ 真机依赖**：emulator 跑的是原生 AOSP，没有 MIUI 的"激进 dismiss"行为，**这条修复在 emulator 上没法直接验证**。代码改动在原生 AOSP 上是 no-op、不影响现有路径，所以现网行为不会回退；MIUI 修没修好需要小米真机现场验证。
- **多 app 同时出声 / 没有 audio focus**（同台真机）—— WebView 里的 `<audio>` 不会自动请求 `AudioManager.AUDIOFOCUS_GAIN`，所以 Spotify / 通话 / 导航语音 / 视频起来时收音机继续大喇叭，两路声音同时往扬声器灌。
- 修复（`android/app/src/main/java/com/globalradio/app/BackgroundAudioPlugin.java` 加 audio focus 全套）：
  - 新增 `requestAudioFocus()` / `abandonAudioFocus()` 两个 `@PluginMethod`，API 26+ 走 `AudioFocusRequest.Builder` + `AudioAttributes(USAGE_MEDIA, CONTENT_TYPE_MUSIC)`，更老的 SDK 走 legacy `requestAudioFocus(listener, STREAM_MUSIC, AUDIOFOCUS_GAIN)`；
  - `OnAudioFocusChangeListener` 把焦点变化通过 `notifyListeners` 桥给 JS：`AUDIOFOCUS_LOSS` → `audioFocusLost {transient: false}`、`AUDIOFOCUS_LOSS_TRANSIENT` / `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK` → `audioFocusLost {transient: true}`、`AUDIOFOCUS_GAIN` → `audioFocusGained`。Duck 也按 transient 处理（电台 duck 起来听感很差，硬暂停体验更好）；
  - 起播 / resume 后调 `requestAudioFocus()`，stop 时 `abandonAudioFocus()`，`handleOnDestroy()` 里也兜底释放；
- 修复（`src/utils/backgroundAudio.ts` + `src/stores/player.ts`）：
  - `backgroundAudio.ts` 暴露 `requestAudioFocus` / `abandonAudioFocus` / `addAudioFocusListeners` 三个 helper，全部 native-Android-only，web/iOS 上 no-op；
  - `player.ts` 新增 `pausedByFocusLoss` ref，store 创建时一次性挂上 `audioFocusLost` / `audioFocusGained` 监听：丢焦点 → 调 `pauseStation('focus-loss')` 但**不**清 `pausedByFocusLoss`；transient 拿回 → `resumeStation()`；非 transient 不自动恢复，让用户手动按播放（符合 Android UX 规范）；
  - `pauseStation` 接受 `'user' | 'focus-loss'` 区分，用户主动暂停清掉自动恢复标志，避免之前的 transient pause 残留导致莫名其妙自己又响了。
- emulator 验证（API 34 AVD）：开播任意一台后 `adb shell cmd media_session dispatch play` 调系统媒体焦点，`dumpsys audio` 能看到我们的 focus stack 在最前一项；`am start` 起 YouTube 视频或者拨号 app 也能看到 logcat 里 `AUDIOFOCUS_LOSS_TRANSIENT` → `pauseStation('focus-loss')` 路径打进来，radio `<audio>` 暂停。媒体下拉卡片、搜索按钮蓝、无 favicon 电台都仍然 OK，v2.0.18-v2.0.20 改动均无回退。

### Notes

- patch 重新生成走的是干净流程：`rm -rf node_modules/@jofr/capacitor-media-session/android/build && npx patch-package @jofr/capacitor-media-session`，diff 已写回 `patches/`。
- `BackgroundAudio` 插件的 JS 注册位置仍在 `MainActivity.onCreate()` 里 `registerPlugin(BackgroundAudioPlugin.class)`，新增的两个 `@PluginMethod` 会被 Capacitor 反射自动暴露，不需要单独的 Decl 文件。
- iOS 这版没改：`Info.plist` 里 `UIBackgroundModes=audio` 的方案本来就处理了 iOS 的 audio session 与焦点（`AVAudioSession`），不需要自己写 plugin。

## [2.0.20] - 2026-06-14

### Added

- **直连失败自动回退到代理**（v2.0.19 修了 server，这版从客户端把流量调度做完）—— 默认仍然走直连，每个直连分支后台挂一个**3 秒**回退计时器：3 秒内如果 `<audio>` 没触发 `playing` 事件、或者中途吐出 `error` 事件，就把 URL 重写成 `/stream-proxy/?url=...` 重新 `audio.load()` + `audio.play()`；代理路径再失败一次还没起来才向 UI 抛 "播放失败"。
  - 本会话内"直连过一次失败的电台"会被记进 `proxyOverrideStations` Set，下次再点这台直接走代理，省掉 3 秒等。`Set` 不持久化，app 冷启动会重置——避免一次抖动让用户永久走代理。
  - HLS / mixed-content 走的本来就是代理路径，不再二次跳，避免无限循环。
- **「始终使用代理」开关**（默认关）—— 设置页新加。打开后所有电台无视协议、地区一律走 `/stream-proxy/`，对应 localStorage `forceProxyPlayback`。
- **「直连失败切换代理超时」滑块** —— 1 秒到 15 秒可调，默认 3 秒，对应 localStorage `playbackFailoverTimeoutSec`。改完立刻对下一次播放生效，不需要重启 app。
- 设置页新增「**播放与网络** / Playback & Network」小节，`src/views/Settings.vue` 里跟现有 ios-card 风格保持一致；中英文 i18n key 都加进了 `src/config/simple-translations.ts`。
- 新增 pinia store `src/stores/playbackSettings.ts`，两个值都是 reactive ref + `watch` 持久化，新增 `useLanguageStore` 引用做错误文案本地化。

### Notes

- 鉴权决策：选 **Option B**（不放开 stream-proxy 的鉴权）。原因：`src/router/index.ts` `beforeEach` 已经把除 `/login` 以外的所有路由都拦在了 `authStore.isAuthenticated`，用户能播任何电台时本来就已经登录、`global_radio_auth` HttpOnly 同源 cookie 自动跟着 `<audio>` 的请求一起送过去。auto-fallback 走的就是这条路，无需改服务端。
- Emulator 实测覆盖：设置页两个新控件展示 + 默认值正确（3 秒、关）；滑块拖到 7 秒后下次切站立即生效；force-proxy 切 ON → 国内电台 `qtfm.cn` 的下次 `audio.src` 是 `/stream-proxy/?url=https%3A%2F%2Flhttp-hw.qtfm.cn...`，本地 stream-proxy 收到了请求；force-proxy 切 OFF → 同一台直连 HTTPS、不再触发 stream-proxy。媒体下拉卡片、搜索按钮蓝、无 favicon 电台都仍然 OK。**未在 emulator 上现场触发"直连失败 → 自动 fallback 成功"**，因为我手头没现成的"直连挂但代理通"的电台，又不想给 emulator 配 iptables/hosts 临时造一个；fallback 路径与 force-proxy 走的是同一段 `wrapWithStreamProxy → /stream-proxy/?url=...`，已经验证通畅，timer + error listener 是常规 DOM 事件没什么花头。

## [2.0.19] - 2026-06-14

### Fixed

- **国外电台 / Mixed-content 走代理时永远不出声**（`stream-proxy/server.mjs` `proxyRequest()` 第 217 行 `await upstream.arrayBuffer()` bug）—— `arrayBuffer()` 只对**有限响应**（HLS playlist、HLS segment）有意义，而 Icecast / Shoutcast / 连续 MP3 / AAC 这种**无限**音频流根本没有"完整 body"——`arrayBuffer()` 会一直等下去直到上游主动 EOF（永远不会发生），客户端 `<audio>` 元素只看到一个永远 hang 的请求，于是任何因为 mixed-content / HLS 走代理分支的电台（外网 HTTP-only 居多）实际上都是不出声、不报错、转圈圈。
- 修复（`stream-proxy/server.mjs`）：
  - 引入 `node:stream` 的 `Readable.fromWeb()`，把 `upstream.body`（一个 web `ReadableStream`）转成 Node 端 `Readable`，再 `.pipe(res)` 一路写到响应；不再 buffer。
  - 转发上游 `status`、`Content-Type`，有 `Content-Length` 时也透传，强制 `Cache-Control: no-store`（电台流不该被中间层缓存）。
  - `req.on('close')` 客户端断开时立刻 `nodeStream.destroy()`，连带通过 `Readable.fromWeb` 的 lock 机制取消上游 socket，杜绝用户切台 / app 退到后台时遗留的死连接。
  - 上游 socket 错误（`nodeStream.on('error')`）只 `console.warn` 一行 + `res.end()`，不再让一个上游错误把整个 Node 进程拖崩。
  - HLS playlist (`.m3u8`) 重写路径**完全保持不变**——它本来就是有限文本响应，buffer 一次重写 URL 是对的。
- 验证（本地）：拿 `http://ais-sa3.cdnstream1.com/2606_128.aac`（一条已知好用的 Icecast AAC 流）打 `curl -m 3 /stream-proxy/?url=...`，3 秒内能拿到 200 OK + `Content-Type: audio/aac` 头并收到 ~160 KB 的 AAC 帧（首字节 `0xFFF1` = ADTS sync）；同一时间连发三次 1 秒断开请求，服务器进程依然存活、依然能正常响应 `/api/auth/me`。

## [2.0.18] - 2026-06-14

### Fixed

- **无 favicon 电台播放后下拉播放卡片显示残留旧封面 / 偶发崩溃** —— 现实里大量电台 `favicon` 字段是空 / null / 404 / CORS 拦 / 非 image MIME / 5MB 巨图 / 单纯指向死域名（emulator 试 *Cadena 100* 的 favicon 是 CloudFront 直接 `403`）。v2.0.17 这条链路只挡了 CORS，剩下的失败路径还是会把已经成功载入过的上一首电台 bitmap 留在 native MediaSession 端，下拉时卡片背景就是错的人。极端情况下还能把 `setMetadata` 调用整个抛出去。
- 修复（JS 端，`src/stores/player.ts` `fetchArtworkAsBase64`）：
  - URL 预校验：空串 / 非 `http(s)` / `new URL()` 解不出 hostname → 直接 resolve `null`，根本不发请求；
  - `AbortController` 3.5s timeout + 多 500ms 软超时 race 兜底，favicon 服务器再烂都不会卡住；
  - `response.ok` + `content-type: image/*` 双校验，HTML 错误页直接丢；
  - 512 KB 硬上限，大图直接拒收，省去把 MB 级 base64 string 推过 IPC；
  - in-session URL 缓存：成功结果 base64 缓存，失败结果也缓存成 `null`，避免同一首死电台被反复重试发起抓图风暴；
  - 整条管线 `console.debug` 而不是 `console.error`，favicon 抓不到属于常态、不该污染线上日志；
  - 失败路径走 `MediaSession.setMetadata({ ..., artwork: [] })` 显式空数组，绝不 throw，绝不影响播放本身。
- 修复（native 端，`patches/@jofr+capacitor-media-session+3.0.3.patch` 给 `MediaSessionPlugin.setMetadata` 加一条 hunk）：
  - 每次 `setMetadata` 都先把 `this.artwork = null`，循环里只在解出新 bitmap 时才覆盖。原版只在循环内 `this.artwork = urlToBitmap(src)`，JS 这次传 `artwork: []` 时循环 body 不跑，**上一首电台的 bitmap 就被静默留在了 native 端**，下一次 `update()` 会把它 setLargeIcon / putBitmap 进 MediaMetadata，导致下拉卡片背景串到上一首；
  - 同时把 `urlToBitmap` 单张图解码失败包了 `try/catch`，单张 base64 解坏不影响整个 `setMetadata` resolve。
- 验证：emulator 实测，无 favicon 电台（Cadena 100，favicon 403）下拉卡片是干净的纯色 MediaStyle 卡片（标题 + 副标题 + 暂停按钮，无图区域）；有 favicon 电台（SmoothJazz.com 64k aac+，favicon 200）下拉是 Android 14 标配的 full-bleed 沉浸式播放卡片。两种情况切换 logcat 全程无 `AndroidRuntime` / `FATAL`。

## [2.0.17] - 2026-06-14

### Fixed

- **下拉播放卡片的电台 logo 依然不显示（v2.0.16 在真机上修不到位）** —— v2.0.16 改成 JS 端异步 `fetch(favicon)` 转 base64 再喂给 `MediaSession.setMetadata`，本地直连开发可以用，但在真机 / 生产环境里 WebView 用 `https://` 加载，favicon CDN 又几乎都不给 `Access-Control-Allow-Origin`，浏览器 CORS 把整个 fetch 拦下，base64 永远拿不到，largeIcon 永远为 null。emulator 实测 logcat 里能看到 `Access to fetch at ... has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`。
- 修复：把 favicon 抓取改走 `CapacitorHttp.get({ url, responseType: 'blob' })`。原生 Android/iOS 上 `CapacitorHttp` 不走 WebView 的 fetch / XHR，而是直接走原生 HTTP 客户端，**完全绕开 CORS 同源策略**；native 端 `responseType: 'blob'` 直接返回 base64 字符串，省一次 Blob→ArrayBuffer→base64 的转换。Web/PWA 路径继续用原来的 `fetch` 兜底。timeout (4s) + 大小上限 (256 KB) + Content-Type 校验 + 按 URL 缓存全部保留。
- emulator 实测：播 *EuroDance 90 radio* 后 `dumpsys notification --noredact` 里现在能看到 `android.largeIcon=Icon (Icon(typ=BITMAP size=64x64))`，下拉媒体卡片的封面整张 favicon 都正确铺出来了。

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
