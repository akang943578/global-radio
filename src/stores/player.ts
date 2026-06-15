import { defineStore } from 'pinia'
import { ref, computed, nextTick } from 'vue'
import Hls from 'hls.js'
import type { RadioStation, PlayerState, FavoriteStation } from '@/types/radio'
import { useHistoryStore } from './history'
import { useLanguageStore } from './language'
import { usePlaybackSettingsStore } from './playbackSettings'
import { mediaSessionManager } from '@/utils/mediaSession'
import { deviceOptimization } from '@/utils/deviceOptimization'
import {
  isHlsStream,
  resolveStreamUrl,
  supportsNativeHls,
  upgradeToHttpsIfNeeded,
  wrapWithStreamProxy,
  isProxiedStreamUrl
} from '@/utils/streamUrl'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { MediaSession } from '@jofr/capacitor-media-session'
import {
  startBackgroundAudio,
  stopBackgroundAudio,
  requestAudioFocus,
  abandonAudioFocus,
  addAudioFocusListeners
} from '@/utils/backgroundAudio'

export const usePlayerStore = defineStore('player', () => {
  // 状态
  const audio = ref<HTMLAudioElement | null>(null)
  const currentStation = ref<RadioStation | null>(null)
  const isPlaying = ref(false)
  const isLoading = ref(false)
  const volume = ref(0.8)
  const isMuted = ref(false)
  const error = ref<string | null>(null)
  const favorites = ref<FavoriteStation[]>([])
  const playFailureCallback = ref<((station: RadioStation) => void) | null>(null)
  const sleepTimer = ref<number | null>(null)
  const sleepTimerEnd = ref<number>(0)
  const sleepTimerInterval = ref<NodeJS.Timeout | null>(null)
  const originalVolume = ref(0.8)
  const isDucked = ref(false)
  const hlsInstance = ref<Hls | null>(null)

  // Tracks the user's intent (vs the actual audio element state), so we
  // can distinguish a user-triggered pause from the WebView/system silently
  // suspending the audio element when the screen locks.
  const playbackIntent = ref<'playing' | 'paused' | 'stopped'>('stopped')
  let pauseRecoveryAttempts = 0
  let pauseRecoveryResetTimer: ReturnType<typeof setTimeout> | null = null

  // Stations that needed the proxy at least once during this session. Reset on
  // app cold start so a transient network blip doesn't permanently route the
  // user through the (more expensive) proxy. Keyed by stationuuid.
  const proxyOverrideStations = ref<Set<string>>(new Set())

  // Holds a cancel callback for the auto-fallback machinery so we can tear it
  // down when the user switches stations / pauses / stops before the timer
  // fires.
  let cancelAutoFallback: (() => void) | null = null

  // Audio-focus bookkeeping (v2.0.21). The native plugin requests
  // AUDIOFOCUS_GAIN around playback so other apps don't mix on top of us.
  // When the system briefly takes focus away (incoming call, navigation
  // prompt, Spotify starting), it tells us via the audioFocusLost event
  // with `transient: true`. We pause and remember it was the OS — so on
  // the matching audioFocusGained we auto-resume. A non-transient loss
  // means a permanent eviction (user opened another music app) — we pause
  // and stay paused, the user has to come back and press play.
  const pausedByFocusLoss = ref(false)

  // v2.0.22: timestamp of the most recent OS-driven pause hint (focus loss
  // from native plugin OR a `pause` event on the audio element that fired
  // *without* user/store action). The audio element's `pause` listener
  // uses this to decide whether to attempt auto-resume — see initAudio().
  // The bug fixed by this: when another app grabs focus, Chromium's
  // internal media handling pauses our `<audio>` element directly. The
  // existing 500ms auto-resume thought "playbackIntent is still 'playing',
  // resume me!" and yanked the audio back, fighting the focus owner. Net
  // effect: both apps audible. We now suppress auto-resume for 5s after
  // any focus-loss signal.
  let lastExternalPauseHintAt = 0
  const EXTERNAL_PAUSE_GUARD_MS = 5000

  const noteRecoveryAttempt = () => {
    pauseRecoveryAttempts++
    if (pauseRecoveryResetTimer) clearTimeout(pauseRecoveryResetTimer)
    pauseRecoveryResetTimer = setTimeout(() => {
      pauseRecoveryAttempts = 0
    }, 15000)
  }

  const destroyHls = () => {
    if (hlsInstance.value) {
      hlsInstance.value.destroy()
      hlsInstance.value = null
    }
  }

  // 把电台 favicon 提前在 JS 端抓成 base64 data URI，再喂给 MediaSession。
  // 走 data URI 的原因：我们 patch 过的 @jofr/capacitor-media-session 把
  // 主线程同步 HttpURLConnection 那条 http(s) 抓图路径关掉了（urlToBitmap
  // 直接返回 null），只保留 base64 解码路径——纯 in-process 不走网络，
  // 不会阻塞 startForeground 5 秒窗口。
  // 缓存按 URL 命中，电台切回去 / 重连时秒读不再抓一次（只缓存成功结果）。
  const artworkBase64Cache = new Map<string, string | null>()
  const inFlightArtwork = new Map<string, Promise<string | null>>()

  const ARTWORK_FETCH_TIMEOUT_MS = 3500
  const ARTWORK_MAX_BYTES = 512 * 1024 // 512 KB hard cap

  const isUsableFaviconUrl = (raw: unknown): raw is string => {
    if (!raw || typeof raw !== 'string') return false
    const trimmed = raw.trim()
    if (!trimmed) return false
    if (!/^https?:\/\//i.test(trimmed)) return false
    try {
      const u = new URL(trimmed)
      if (!u.hostname) return false
    } catch {
      return false
    }
    return true
  }

  const fetchArtworkAsBase64 = async (rawUrl: string): Promise<string | null> => {
    if (!isUsableFaviconUrl(rawUrl)) return null
    const url = rawUrl.trim()

    if (artworkBase64Cache.has(url)) {
      // 命中缓存（命中值可能是 null = 之前抓失败了，本会话不再重试，避免抓图风暴）
      return artworkBase64Cache.get(url) ?? null
    }

    const existing = inFlightArtwork.get(url)
    if (existing) return existing

    const promise = (async (): Promise<string | null> => {
      try {
        // 原生 Android/iOS 上走 CapacitorHttp 绕开 WebView CORS（电台 favicon
        // 服务器基本不会给我们的 origin 配 Access-Control-Allow-Origin），
        // responseType=blob 时 native 端直接给我们 base64 字符串
        if (Capacitor.isNativePlatform()) {
          const response = await Promise.race([
            CapacitorHttp.get({
              url,
              responseType: 'blob',
              connectTimeout: ARTWORK_FETCH_TIMEOUT_MS,
              readTimeout: ARTWORK_FETCH_TIMEOUT_MS
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('artwork timeout')), ARTWORK_FETCH_TIMEOUT_MS + 500)
            )
          ])

          if (!response || response.status < 200 || response.status >= 300) return null

          const headers = response.headers || {}
          const contentTypeRaw =
            headers['Content-Type'] || headers['content-type'] || ''
          const contentType = typeof contentTypeRaw === 'string' ? contentTypeRaw.toLowerCase() : ''
          if (contentType && !contentType.startsWith('image/')) return null

          const mime = contentType.startsWith('image/')
            ? contentType.split(';')[0].trim()
            : 'image/png'

          // native 返回值是 base64 string
          const base64 = typeof response.data === 'string' ? response.data : null
          if (!base64) return null
          // 粗略大小判断：base64 字符数 * 0.75 ≈ 字节数
          if (base64.length * 0.75 > ARTWORK_MAX_BYTES) return null

          return `data:${mime};base64,${base64}`
        }

        // Web/PWA 路径：常规 fetch
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), ARTWORK_FETCH_TIMEOUT_MS)
        try {
          const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'follow'
          })
          if (!response.ok) return null
          const contentType = response.headers.get('content-type') || ''
          if (contentType && !contentType.startsWith('image/')) return null
          const blob = await response.blob()
          if (blob.size === 0 || blob.size > ARTWORK_MAX_BYTES) return null
          const mime = contentType.startsWith('image/') ? contentType.split(';')[0].trim() : (blob.type || 'image/png')
          const buf = await blob.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let binary = ''
          const chunk = 0x8000
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
          }
          const base64 = btoa(binary)
          return `data:${mime};base64,${base64}`
        } finally {
          clearTimeout(timeoutId)
        }
      } catch (err) {
        // 故意 debug 而不是 warn / error —— 拉不到电台 favicon 是常态
        // （404 / CORS / 域名挂了 / favicon 字段是垃圾 URL），不该污染控制台
        console.debug('[mediaSession] artwork fetch failed:', err)
        return null
      }
    })()

    inFlightArtwork.set(url, promise)
    try {
      const dataUri = await promise
      artworkBase64Cache.set(url, dataUri)
      return dataUri
    } catch {
      // 防御性：上面的 IIFE 已经吞掉了 throw，这里基本走不到
      artworkBase64Cache.set(url, null)
      return null
    } finally {
      inFlightArtwork.delete(url)
    }
  }

  const announceNativeMetadata = async (station: RadioStation) => {
    if (!Capacitor.isNativePlatform()) return

    const baseMetadata = {
      title: station.name || 'GlobalRadio',
      artist: station.country || 'GlobalRadio',
      album: station.tags || 'Radio'
    }

    // 第一帧：不带 artwork（显式空数组）立刻把大卡片贴出来，绝对不阻塞 startForeground 5s 窗口。
    // 显式 artwork: [] 很重要 —— patched 的 native plugin 会读 length，
    // 这一帧也顺便把上一首电台残留在 native 端的 bitmap 清掉
    try {
      await MediaSession.setMetadata({ ...baseMetadata, artwork: [] })
    } catch (error) {
      console.debug('[mediaSession] setMetadata (no artwork) failed:', error)
    }

    // 第二帧：异步抓取 favicon -> base64 data URI，回来再 setMetadata 一次。
    // 如果 favicon 字段缺失 / 非 http(s) / 抓失败 / CORS / 超时 / 太大 /
    // 非 image MIME，整个第二帧静默跳过，第一帧设的"无图卡片"就是最终样子，
    // 绝不影响播放本身。
    const faviconUrl = station.favicon
    if (!isUsableFaviconUrl(faviconUrl)) return

    const announceStation = station
    fetchArtworkAsBase64(faviconUrl)
      .then(async (dataUri) => {
        if (!dataUri) return
        // 用户已经切到别的电台了就不要覆盖当前 metadata
        if (currentStation.value?.stationuuid !== announceStation.stationuuid) return
        const mimeMatch = dataUri.slice(5, dataUri.indexOf(';'))
        try {
          await MediaSession.setMetadata({
            ...baseMetadata,
            artwork: [{ src: dataUri, sizes: '512x512', type: mimeMatch || 'image/png' }]
          })
        } catch (err) {
          console.debug('[mediaSession] setMetadata (with artwork) failed:', err)
        }
      })
      .catch((err) => {
        console.debug('[mediaSession] artwork pipeline failed:', err)
      })
  }

  const announceNativePlaybackState = async (state: 'playing' | 'paused' | 'none') => {
    if (!Capacitor.isNativePlatform()) return
    try {
      await MediaSession.setPlaybackState({ playbackState: state })
    } catch (error) {
      console.warn('[mediaSession] setPlaybackState failed:', error)
    }
  }

  const applyAudioOutputSettings = () => {
    if (!audio.value) return
    audio.value.volume = isDucked.value ? volume.value * 0.3 : volume.value
    audio.value.muted = isMuted.value
  }

  const createHlsInstance = (): Hls => {
    return new Hls({
      enableWorker: true,
      lowLatencyMode: true
    })
  }

  const playWithHls = async (streamUrl: string): Promise<void> => {
    if (!audio.value) {
      throw new Error('音频元素未初始化')
    }

    destroyHls()

    if (Hls.isSupported()) {
      const hls = createHlsInstance()
      hlsInstance.value = hls
      hls.attachMedia(audio.value)
      hls.loadSource(streamUrl)

      await new Promise<void>((resolve, reject) => {
        const onParsed = () => {
          cleanup()
          resolve()
        }
        const onError = (_event: string, data: { fatal?: boolean }) => {
          if (!data.fatal) return
          cleanup()
          reject(new Error('HLS 流加载失败'))
        }
        const cleanup = () => {
          hls.off(Hls.Events.MANIFEST_PARSED, onParsed)
          hls.off(Hls.Events.ERROR, onError)
        }

        hls.on(Hls.Events.MANIFEST_PARSED, onParsed)
        hls.on(Hls.Events.ERROR, onError)
      })
    } else if (supportsNativeHls(audio.value)) {
      audio.value.src = streamUrl
      audio.value.load()
    } else {
      throw new Error('当前浏览器不支持 HLS 播放')
    }

    await audio.value.play()
  }

  const playDirectStream = async (streamUrl: string): Promise<void> => {
    if (!audio.value) {
      throw new Error('音频元素未初始化')
    }

    destroyHls()
    audio.value.src = streamUrl
    audio.value.load()
    await audio.value.play()
  }

  // Pick the actual URL to hand to the audio element. Adds the per-session
  // proxy override and the user-toggled "force proxy" setting on top of the
  // baseline `resolveStreamUrl` rules (HLS / mixed-content already proxied).
  const buildPlaybackUrl = (
    station: RadioStation
  ): { streamUrl: string; originalUrl: string; forcedThroughProxy: boolean } => {
    const settings = usePlaybackSettingsStore()
    const rawUrl = (station.url_resolved || station.url || '').trim()
    const originalUrl = upgradeToHttpsIfNeeded(rawUrl)

    let streamUrl = resolveStreamUrl(station)
    let forcedThroughProxy = false

    // If the user has flipped "always use proxy" or this station already
    // failed direct earlier in this session, route through proxy regardless of
    // the default rules, except when it's already proxied (HLS / mixed
    // content).
    const needsForcedProxy =
      settings.forceProxy || proxyOverrideStations.value.has(station.stationuuid)

    if (needsForcedProxy && !isProxiedStreamUrl(streamUrl)) {
      streamUrl = wrapWithStreamProxy(originalUrl)
      forcedThroughProxy = true
    }

    return { streamUrl, originalUrl, forcedThroughProxy }
  }

  // Tear down any pending fallback timer + listeners. Safe to call repeatedly.
  const clearAutoFallback = () => {
    if (cancelAutoFallback) {
      const fn = cancelAutoFallback
      cancelAutoFallback = null
      try {
        fn()
      } catch (err) {
        console.debug('[playback] cancelAutoFallback threw:', err)
      }
    }
  }

  // After we kick off direct playback, watch the audio element. If it fails
  // (`error`) or never gets to `playing` within the user-configured threshold,
  // rebuild the URL through the server proxy and retry. If THAT also fails
  // within another threshold window, surface a hard error to the UI.
  const scheduleAutoFallback = (
    station: RadioStation,
    originalUrl: string,
    thresholdMs: number
  ) => {
    clearAutoFallback()
    if (!audio.value) return

    const targetAudio = audio.value
    let triggered = false

    const trigger = (reason: string) => {
      if (triggered) return
      triggered = true
      clearAutoFallback()
      console.warn(
        `[playback] auto-fallback for "${station.name}" (${station.stationuuid}): ${reason}`
      )
      void runProxyFallback(station, originalUrl, thresholdMs)
    }

    const onPlaying = () => {
      // First successful frame — we're good. Cancel everything.
      clearAutoFallback()
    }
    const onError = () => {
      trigger('audio element fired error')
    }

    targetAudio.addEventListener('playing', onPlaying, { once: true })
    targetAudio.addEventListener('error', onError, { once: true })

    const timer = setTimeout(() => {
      if (targetAudio.readyState >= 3) {
        // Audio is actually playing-ready (HAVE_FUTURE_DATA). Keep it.
        clearAutoFallback()
        return
      }
      trigger(`no 'playing' event within ${thresholdMs}ms`)
    }, thresholdMs)

    cancelAutoFallback = () => {
      clearTimeout(timer)
      targetAudio.removeEventListener('playing', onPlaying)
      targetAudio.removeEventListener('error', onError)
    }
  }

  // Second-stage retry: this is the last chance — if proxy also doesn't reach
  // 'playing' within the threshold, give up and surface "Playback failed".
  const runProxyFallback = async (
    station: RadioStation,
    originalUrl: string,
    thresholdMs: number
  ) => {
    if (currentStation.value?.stationuuid !== station.stationuuid) {
      // User already moved on — abandon the fallback silently.
      return
    }
    if (!audio.value) return

    proxyOverrideStations.value.add(station.stationuuid)

    const proxiedUrl = wrapWithStreamProxy(originalUrl)
    console.log(`[playback] retrying via proxy: ${proxiedUrl}`)

    destroyHls()
    audio.value.src = proxiedUrl
    audio.value.load()

    const targetAudio = audio.value
    let resolved = false
    let secondTimer: ReturnType<typeof setTimeout> | null = null

    const giveUp = (reason: string) => {
      if (resolved) return
      resolved = true
      if (secondTimer) {
        clearTimeout(secondTimer)
        secondTimer = null
      }
      targetAudio.removeEventListener('playing', onPlaying)
      targetAudio.removeEventListener('error', onError)
      console.warn(`[playback] proxy fallback also failed for "${station.name}": ${reason}`)
      error.value = useLanguageStringForError()
      isPlaying.value = false
      isLoading.value = false
    }

    const onPlaying = () => {
      if (resolved) return
      resolved = true
      if (secondTimer) {
        clearTimeout(secondTimer)
        secondTimer = null
      }
      targetAudio.removeEventListener('error', onError)
      console.log(`[playback] proxy fallback succeeded for "${station.name}"`)
    }

    const onError = () => {
      giveUp('audio element fired error on proxied src')
    }

    targetAudio.addEventListener('playing', onPlaying, { once: true })
    targetAudio.addEventListener('error', onError, { once: true })

    secondTimer = setTimeout(() => {
      if (targetAudio.readyState >= 3) {
        // Already buffered enough, treat as success.
        if (!resolved) {
          resolved = true
          targetAudio.removeEventListener('playing', onPlaying)
          targetAudio.removeEventListener('error', onError)
        }
        return
      }
      giveUp(`no 'playing' event on proxied src within ${thresholdMs}ms`)
    }, thresholdMs)

    try {
      await targetAudio.play()
    } catch (playErr) {
      console.error('[playback] proxy fallback play() rejected:', playErr)
      giveUp(`proxy play() rejected: ${playErr instanceof Error ? playErr.message : String(playErr)}`)
    }
  }

  const useLanguageStringForError = (): string => {
    try {
      const t = useLanguageStore().t
      const localized = t('player.error')
      if (typeof localized === 'string' && localized !== 'player.error') {
        return localized
      }
    } catch {
      // language store not ready yet — fall through to default
    }
    return '播放失败，请稍后重试'
  }

  // 计算属性
  const playerState = computed<PlayerState>(() => ({
    isPlaying: isPlaying.value,
    currentStation: currentStation.value,
    volume: volume.value,
    isMuted: isMuted.value,
    isLoading: isLoading.value,
    error: error.value
  }))

  const isFavorite = computed(() => {
    if (!currentStation.value) return false
    return favorites.value.some(fav => fav.stationuuid === currentStation.value!.stationuuid)
  })

  const sleepTimerRemaining = computed(() => sleepTimer.value || 0)
  const hasSleepTimer = computed(() => sleepTimer.value !== null && sleepTimer.value > 0)

  // 初始化音频元素
  const initAudio = () => {
    if (!audio.value) {
      audio.value = new Audio()
      audio.value.preload = 'none'
      
      // 设置音频属性以优化播放
      audio.value.volume = volume.value
      audio.value.muted = isMuted.value
      
      // 优化移动设备播放
      if (deviceOptimization.isMobile()) {
        audio.value.setAttribute('playsinline', 'true')
        audio.value.setAttribute('webkit-playsinline', 'true')
      }
      
      // 音频事件监听
      audio.value.addEventListener('loadstart', () => {
        isLoading.value = true
      })
      
      audio.value.addEventListener('canplay', () => {
        isLoading.value = false
      })
      
      audio.value.addEventListener('play', () => {
        isPlaying.value = true
        isLoading.value = false
        error.value = null
        deviceOptimization.optimizeAudioElement(audio.value!)
      })
      
      audio.value.addEventListener('pause', () => {
        isPlaying.value = false

        // v2.0.22: only attempt the screen-off-self-heal resume if there
        // hasn't been a recent focus-loss hint. Without this guard, when
        // another media app grabs focus the WebView/Chromium pauses our
        // <audio>, and our 500ms auto-resume would fight it — the radio
        // would just unpause itself and play simultaneously with the
        // other app. The `lastExternalPauseHintAt` timestamp is updated
        // by the audio-focus listener (and could be extended to other
        // OS-pause causes in the future).
        const sinceExternalPause = Date.now() - lastExternalPauseHintAt
        if (sinceExternalPause < EXTERNAL_PAUSE_GUARD_MS) {
          console.info(
            `[player] pause event suppressed auto-resume (focus-loss ${sinceExternalPause}ms ago)`
          )
          return
        }

        // Self-heal: if the user wants playback but the WebView quietly
        // paused us (typical Android pattern when the screen turns off
        // and the OS briefly suspends the media element before our
        // foreground service takes effect), attempt to resume. Capped at
        // 3 attempts per 15 s so a genuinely-broken stream doesn't loop.
        if (
          playbackIntent.value === 'playing' &&
          currentStation.value &&
          audio.value &&
          !audio.value.ended &&
          pauseRecoveryAttempts < 3
        ) {
          noteRecoveryAttempt()
          const target = audio.value
          setTimeout(() => {
            if (
              playbackIntent.value === 'playing' &&
              target === audio.value &&
              target.paused &&
              Date.now() - lastExternalPauseHintAt >= EXTERNAL_PAUSE_GUARD_MS
            ) {
              target.play().catch((err) => {
                console.warn('[playback] auto-resume failed:', err)
              })
            }
          }, 500)
        }
      })
      
      audio.value.addEventListener('ended', () => {
        isPlaying.value = false
        // 媒体控制已移除
      })
      
      audio.value.addEventListener('error', (e) => {
        console.error('音频播放错误:', e)
        isPlaying.value = false
        isLoading.value = false
        // 媒体控制已移除
      })
      
      audio.value.addEventListener('stalled', () => {
        console.log('音频加载停滞，尝试重新加载...')
        if (audio.value && currentStation.value) {
          audio.value.load()
        }
      })
      
      audio.value.addEventListener('waiting', () => {
        isLoading.value = true
      })
      
      audio.value.addEventListener('playing', () => {
        isLoading.value = false
      })
    }
  }

  // 设置媒体会话事件监听器
  const setupMediaSessionHandlers = async () => {
    // 移除PC端前后台切换音量变化功能
    // 仅保留原生应用的媒体会话处理
    
    // 如果是Capacitor平台，设置媒体会话插件
    if (Capacitor.isNativePlatform()) {
      try {
        // 设置媒体会话动作处理器
        await MediaSession.setActionHandler({ action: 'play' }, () => {
          if (currentStation.value) {
            resumeStation()
          }
        })
        
        await MediaSession.setActionHandler({ action: 'pause' }, () => {
          pauseStation()
        })
        
        await MediaSession.setActionHandler({ action: 'stop' }, () => {
          stopStation()
        })
        
        console.log('媒体会话处理器已设置')
      } catch (error) {
        console.error('设置媒体会话处理器失败:', error)
      }
    }
    
    // Web平台的媒体会话事件
    window.addEventListener('mediaSession:play', () => {
      if (currentStation.value) {
        resumeStation()
      }
    })

    window.addEventListener('mediaSession:pause', () => {
      pauseStation()
    })

    window.addEventListener('mediaSession:stop', () => {
      stopStation()
    })
  }

  // 添加到播放历史 - 需要在playStation之前定义
  const addToHistory = (station: RadioStation) => {
    const historyStore = useHistoryStore()
    historyStore.addToHistory(station)
  }

  // 播放电台
  const playStation = async (station: RadioStation, retryCount = 0): Promise<void> => {
    const maxRetries = 2
    
    try {
      console.log(`尝试播放电台: ${station.name} (重试次数: ${retryCount})`)
      
      if (!audio.value) {
        initAudio()
      }
      
      // 清除之前的错误
      error.value = null
      isLoading.value = true

      // 切站时把上一站还没触发的 fallback 计时器拆掉
      clearAutoFallback()

      // 如果正在播放其他电台，先停止
      if (currentStation.value && currentStation.value.stationuuid !== station.stationuuid) {
        audio.value!.pause()
        destroyHls()
        await nextTick()
      }
      
      // 设置新的电台
      currentStation.value = station
      addToHistory(station)

      const { streamUrl, originalUrl, forcedThroughProxy } = buildPlaybackUrl(station)
      const startedOnProxy = isProxiedStreamUrl(streamUrl)
      applyAudioOutputSettings()

      if (isHlsStream(station, streamUrl)) {
        await playWithHls(streamUrl)
      } else {
        await playDirectStream(streamUrl)
      }
      
      console.log(`成功播放电台: ${station.name}`)

      playbackIntent.value = 'playing'
      pauseRecoveryAttempts = 0
      // Any successful play() = user explicitly wants audio. Reset the
      // focus-loss flag so a stale transient pause from before doesn't
      // accidentally trigger an auto-resume cycle.
      pausedByFocusLoss.value = false
      mediaSessionManager.updateMetadata(station)
      mediaSessionManager.updatePlaybackState(true)
      await announceNativeMetadata(station)
      await announceNativePlaybackState('playing')
      await startBackgroundAudio(station)
      // Ask Android for audio focus so Spotify / phone calls / nav prompts
      // get exclusive use of the speaker (and we get told to pause via the
      // listener registered below). granted=false on weird OEMs is logged
      // and we proceed anyway — denying focus doesn't mean denying audio.
      const granted = await requestAudioFocus()
      if (!granted) {
        console.warn('[playback] audio focus not granted; other apps may mix on top')
      }

      // 只在「直连」分支挂自动回退；走代理的（HLS / mixed-content / 用户强制
      // 代理 / 本会话曾经回退过的电台）已经是兜底路径，再失败就是真的挂了，
      // 走原有 retry / error 即可，不需要二次跳。
      if (!startedOnProxy && !forcedThroughProxy && originalUrl) {
        const settings = usePlaybackSettingsStore()
        const thresholdMs = settings.failoverTimeoutSec * 1000
        scheduleAutoFallback(station, originalUrl, thresholdMs)
      }
    } catch (playError) {
      console.error(`播放重试 (重试 ${retryCount}/${maxRetries}):`, playError)
      
      if (retryCount < maxRetries) {
        // 重试播放
        console.log(`${retryCount + 1}秒后重试播放...`)
        await new Promise(resolve => setTimeout(resolve, (retryCount + 1) * 1000))
        return await playStation(station, retryCount + 1)
      } else {
        // 达到最大重试次数
        error.value = '播放失败，请稍后重试'
        isPlaying.value = false
        isLoading.value = false
        throw new Error(error.value)
      }
    }
  }

  // 暂停播放
  const pauseStation = async (cause: 'user' | 'focus-loss' = 'user') => {
    playbackIntent.value = 'paused'
    if (cause === 'user') {
      // User-initiated pause — discard any pending auto-resume so we
      // don't surprise them by suddenly playing again when focus comes
      // back from an unrelated transient loss earlier in the session.
      pausedByFocusLoss.value = false
    }
    clearAutoFallback()
    if (audio.value) {
      audio.value.pause()
    }
    mediaSessionManager.updatePlaybackState(false)
    await announceNativePlaybackState('paused')
  }

  // 恢复播放
  const resumeStation = async () => {
    if (audio.value && currentStation.value) {
      try {
        playbackIntent.value = 'playing'
        pauseRecoveryAttempts = 0
        // Manual resume → no longer "paused by focus loss"; clear the
        // flag so the OS giving us focus back later doesn't double-fire.
        pausedByFocusLoss.value = false
        await audio.value.play()
        mediaSessionManager.updatePlaybackState(true)
        await announceNativePlaybackState('playing')
        await startBackgroundAudio(currentStation.value)
        // Re-acquire focus on every resume so the OS knows we're back in
        // the audio mix; without this Android may still consider us
        // background-paused and route media keys elsewhere.
        const granted = await requestAudioFocus()
        if (!granted) {
          console.warn('[playback] audio focus not granted on resume')
        }
      } catch (err) {
        console.error('恢复播放失败')
        console.error('恢复播放错误:', err)
      }
    }
  }

  // 停止播放
  const stopStation = async () => {
    playbackIntent.value = 'stopped'
    pausedByFocusLoss.value = false
    clearAutoFallback()
    destroyHls()
    if (audio.value) {
      audio.value.pause()
      audio.value.removeAttribute('src')
      audio.value.load()
      audio.value.currentTime = 0
    }
    isPlaying.value = false
    currentStation.value = null
    mediaSessionManager.clear()
    await announceNativePlaybackState('none')
    await stopBackgroundAudio()
    await abandonAudioFocus()
  }

  // 设置音量
  const setVolume = (newVolume: number) => {
    volume.value = Math.max(0, Math.min(1, newVolume))
    originalVolume.value = volume.value
    
    if (audio.value) {
      audio.value.volume = isDucked.value ? volume.value * 0.3 : volume.value
    }
    
    // 保存到本地存储
    localStorage.setItem('radio-volume', volume.value.toString())
    import('@/services/userDataSyncTrigger').then(({ scheduleUserDataPush }) => {
      scheduleUserDataPush()
    })
  }

  // 切换静音
  const toggleMute = () => {
    isMuted.value = !isMuted.value
    if (audio.value) {
      audio.value.muted = isMuted.value
    }
    
    // 保存到本地存储
    localStorage.setItem('radio-muted', isMuted.value.toString())
    import('@/services/userDataSyncTrigger').then(({ scheduleUserDataPush }) => {
      scheduleUserDataPush()
    })
  }

  // 添加到收藏夹
  const addToFavorites = (station: RadioStation) => {
    const favorite: FavoriteStation = {
      stationuuid: station.stationuuid,
      name: station.name,
      url: station.url,
      favicon: station.favicon,
      country: station.country,
      addedAt: new Date().toISOString()
    }
    
    if (!favorites.value.some(fav => fav.stationuuid === station.stationuuid)) {
      favorites.value.unshift(favorite)
      saveFavorites()
    }
  }

  // 从收藏夹移除
  const removeFromFavorites = (stationUuid: string) => {
    const index = favorites.value.findIndex(fav => fav.stationuuid === stationUuid)
    if (index > -1) {
      favorites.value.splice(index, 1)
      saveFavorites()
    }
  }

  // 移除收藏（别名方法）
  const removeFavorite = (stationUuid: string) => {
    removeFromFavorites(stationUuid)
  }

  // 清空收藏夹
  const clearFavorites = () => {
    favorites.value = []
    saveFavorites()
  }

  // 检查特定电台是否被收藏
  const isStationFavorite = (stationUuid: string) => {
    return favorites.value.some(fav => fav.stationuuid === stationUuid)
  }

  // 切换收藏状态
  const toggleFavorite = (station: RadioStation) => {
    if (isStationFavorite(station.stationuuid)) {
      removeFromFavorites(station.stationuuid)
    } else {
      addToFavorites(station)
    }
  }

  // 保存收藏夹到本地存储
  const saveFavorites = () => {
    localStorage.setItem('radio-favorites', JSON.stringify(favorites.value))
    import('@/services/userDataSyncTrigger').then(({ scheduleUserDataPush }) => {
      scheduleUserDataPush()
    })
  }

  // 从本地存储加载收藏夹
  const loadFavorites = () => {
    try {
      const saved = localStorage.getItem('radio-favorites')
      if (saved) {
        favorites.value = JSON.parse(saved)
      }
    } catch (err) {
      console.error('加载收藏夹失败:', err)
    }
  }

  // 清除错误
  const clearError = () => {
    error.value = null
  }

  // 设置播放失败回调
  const setPlayFailureCallback = (callback: ((station: RadioStation) => void) | null) => {
    playFailureCallback.value = callback
  }

  // 设置睡眠定时器
  const setSleepTimer = (minutes: number) => {
    sleepTimer.value = minutes
    
    if (sleepTimerInterval.value) {
      clearInterval(sleepTimerInterval.value)
    }
    
    sleepTimerInterval.value = setInterval(() => {
      if (sleepTimer.value && sleepTimer.value > 0) {
        sleepTimer.value--
        
        if (sleepTimer.value === 0) {
          clearSleepTimer()
          stopStation()
        }
      }
    }, 60000) // 每分钟减1
  }

  // 清除睡眠定时器
  const clearSleepTimer = () => {
    sleepTimer.value = null
    
    if (sleepTimerInterval.value) {
      clearInterval(sleepTimerInterval.value)
      sleepTimerInterval.value = null
    }
  }

  // 从本地存储恢复状态
  const restoreFromStorage = () => {
    try {
      const savedVolume = localStorage.getItem('radio-volume')
      if (savedVolume) {
        volume.value = parseFloat(savedVolume)
        originalVolume.value = volume.value
      }
      
      const savedMuted = localStorage.getItem('radio-muted')
      if (savedMuted) {
        isMuted.value = savedMuted === 'true'
      }
      
      const savedFavorites = localStorage.getItem('radio-favorites')
      if (savedFavorites) {
        favorites.value = JSON.parse(savedFavorites)
      }
    } catch (error) {
      console.error('从本地存储恢复状态失败:', error)
    }
  }

  // Wire native audio-focus events from the BackgroundAudio plugin (v2.0.21).
  // Android delivers AUDIOFOCUS_LOSS / GAIN through a system listener; the
  // plugin bridges those into Capacitor events. We translate them into the
  // standard radio UX:
  //   - permanent loss → pause and stay paused (Spotify/podcast etc.)
  //   - transient loss → pause; resume on the next gain (call/nav prompt)
  // No-op on web/iOS (the helper returns immediately on non-Android).
  // v2.0.22: dedupe LOST events from both the Capacitor plugin channel
  // AND the window-level CustomEvent (native plugin fires both). Within a
  // short window, treat a second event as a duplicate.
  let lastFocusEventAt = 0
  let lastFocusEventName: 'lost' | 'gained' | null = null
  const FOCUS_DEDUP_MS = 200

  const handleFocusLost = (event: { transient: boolean; canDuck: boolean }) => {
    const now = Date.now()
    if (lastFocusEventName === 'lost' && now - lastFocusEventAt < FOCUS_DEDUP_MS) {
      return
    }
    lastFocusEventAt = now
    lastFocusEventName = 'lost'

    // Mark recent OS-pause so the audio element's own `pause` event
    // handler doesn't try to auto-resume us into a fight with the new
    // focus owner. Independent of whether we were technically "playing"
    // in our store — the native side may know better.
    lastExternalPauseHintAt = now

    console.info(
      `[player] audio focus lost (transient=${event.transient}, canDuck=${event.canDuck})`
    )

    if (!audio.value) return
    pausedByFocusLoss.value = !!event.transient

    // Hard pause — defensively even if our state thinks we're already
    // paused, because the WebView audio element may still be playing
    // (especially if we got here via the window-event fallback and the
    // store-level pause hasn't run yet).
    try {
      audio.value.pause()
    } catch (err) {
      console.warn('[player] audio.pause() in focus-loss threw:', err)
    }

    if (playbackIntent.value === 'playing') {
      // We pass cause: 'focus-loss' so pauseStation does NOT clobber the
      // pausedByFocusLoss flag we just set. If the loss is non-transient
      // we leave pausedByFocusLoss=false and the user must press play.
      void pauseStation('focus-loss')
    } else {
      // Already paused at the store level; just keep media-session in sync.
      void announceNativePlaybackState('paused')
    }
  }

  const handleFocusGained = () => {
    const now = Date.now()
    if (lastFocusEventName === 'gained' && now - lastFocusEventAt < FOCUS_DEDUP_MS) {
      return
    }
    lastFocusEventAt = now
    lastFocusEventName = 'gained'

    console.info(
      `[player] audio focus gained (pausedByFocusLoss=${pausedByFocusLoss.value})`
    )

    // Only auto-resume if the OS-driven transient pause is still pending
    // and the user hasn't moved on to a different station / pressed stop.
    if (
      pausedByFocusLoss.value &&
      currentStation.value &&
      playbackIntent.value === 'paused'
    ) {
      pausedByFocusLoss.value = false
      void resumeStation()
    }
  }

  void addAudioFocusListeners({
    onLost: handleFocusLost,
    onGained: handleFocusGained
  }).catch((err) => {
    console.warn('[playback] addAudioFocusListeners failed:', err)
  })

  // 初始化
  loadFavorites()
  setupMediaSessionHandlers()
  
  // 移动设备优化提示
  if (deviceOptimization.isMobile()) {
    deviceOptimization.suggestBatteryOptimization()
  }

  return {
    // 状态
    audio,
    currentStation,
    isPlaying,
    isLoading,
    volume,
    isMuted,
    error,
    favorites,
    sleepTimer,
    sleepTimerEnd,
    
    // 计算属性
    playerState,
    isFavorite,
    sleepTimerRemaining,
    hasSleepTimer,
    
    // 方法
    playStation,
    pauseStation,
    resumeStation,
    stopStation,
    setVolume,
    toggleMute,
    addToFavorites,
    removeFromFavorites,
    removeFavorite,
    toggleFavorite,
    isStationFavorite,
    clearFavorites,
    clearError,
    setPlayFailureCallback,
    setSleepTimer,
    clearSleepTimer,
    addToHistory,
    restoreFromStorage,
  }
})
