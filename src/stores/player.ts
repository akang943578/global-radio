import { defineStore } from 'pinia'
import { ref, computed, nextTick } from 'vue'
import Hls from 'hls.js'
import type { RadioStation, PlayerState, FavoriteStation } from '@/types/radio'
import { useHistoryStore } from './history'
import { mediaSessionManager } from '@/utils/mediaSession'
import { deviceOptimization } from '@/utils/deviceOptimization'
import { isHlsStream, resolveStreamUrl, supportsNativeHls } from '@/utils/streamUrl'
import { Capacitor } from '@capacitor/core'
import { MediaSession } from '@jofr/capacitor-media-session'
import { startBackgroundAudio, stopBackgroundAudio } from '@/utils/backgroundAudio'

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
  // 缓存按 URL 命中，电台切回去 / 重连时秒读不再抓一次。
  const artworkBase64Cache = new Map<string, string>()
  let inFlightArtwork: { url: string; promise: Promise<string | null> } | null = null

  const ARTWORK_FETCH_TIMEOUT_MS = 4000
  const ARTWORK_MAX_BYTES = 256 * 1024 // 256 KB 上限，太大没必要也增加 IPC 压力

  const fetchArtworkAsBase64 = async (url: string): Promise<string | null> => {
    if (!url || typeof url !== 'string') return null
    if (!/^https?:\/\//i.test(url)) return null

    const cached = artworkBase64Cache.get(url)
    if (cached !== undefined) return cached

    if (inFlightArtwork && inFlightArtwork.url === url) {
      return inFlightArtwork.promise
    }

    const promise = (async (): Promise<string | null> => {
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
        if (contentType && !contentType.startsWith('image/')) {
          return null
        }

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
      } catch (err) {
        console.warn('[mediaSession] artwork fetch failed:', err)
        return null
      } finally {
        clearTimeout(timeoutId)
      }
    })()

    inFlightArtwork = { url, promise }
    try {
      const dataUri = await promise
      artworkBase64Cache.set(url, dataUri || '')
      return dataUri
    } finally {
      if (inFlightArtwork && inFlightArtwork.url === url) {
        inFlightArtwork = null
      }
    }
  }

  const announceNativeMetadata = async (station: RadioStation) => {
    if (!Capacitor.isNativePlatform()) return

    const baseMetadata = {
      title: station.name || 'GlobalRadio',
      artist: station.country || 'GlobalRadio',
      album: station.tags || 'Radio'
    }

    // 第一帧：不带 artwork 立刻把大卡片贴出来，绝对不阻塞 startForeground 5s 窗口
    try {
      await MediaSession.setMetadata({ ...baseMetadata, artwork: [] })
    } catch (error) {
      console.warn('[mediaSession] setMetadata (no artwork) failed:', error)
    }

    // 第二帧：异步抓取 favicon -> base64 data URI，回来再 setMetadata 一次。
    // 走 cache，电台切回去秒读。失败了就保持没图状态，不影响卡片本身。
    const faviconUrl = station.favicon
    if (!faviconUrl) return

    const announceStation = station
    fetchArtworkAsBase64(faviconUrl)
      .then(async (dataUri) => {
        if (!dataUri) return
        // 用户已经切到别的电台了就不要覆盖当前 metadata
        if (currentStation.value?.stationuuid !== announceStation.stationuuid) return
        try {
          await MediaSession.setMetadata({
            ...baseMetadata,
            artwork: [{ src: dataUri, sizes: '512x512', type: dataUri.slice(5, dataUri.indexOf(';')) || 'image/png' }]
          })
        } catch (err) {
          console.warn('[mediaSession] setMetadata (with artwork) failed:', err)
        }
      })
      .catch((err) => {
        console.warn('[mediaSession] artwork pipeline failed:', err)
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
              target.paused
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
      
      // 如果正在播放其他电台，先停止
      if (currentStation.value && currentStation.value.stationuuid !== station.stationuuid) {
        audio.value!.pause()
        destroyHls()
        await nextTick()
      }
      
      // 设置新的电台
      currentStation.value = station
      addToHistory(station)

      const streamUrl = resolveStreamUrl(station)
      applyAudioOutputSettings()

      if (isHlsStream(station, streamUrl)) {
        await playWithHls(streamUrl)
      } else {
        await playDirectStream(streamUrl)
      }
      
      console.log(`成功播放电台: ${station.name}`)

      playbackIntent.value = 'playing'
      pauseRecoveryAttempts = 0
      mediaSessionManager.updateMetadata(station)
      mediaSessionManager.updatePlaybackState(true)
      await announceNativeMetadata(station)
      await announceNativePlaybackState('playing')
      await startBackgroundAudio(station)
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
  const pauseStation = async () => {
    playbackIntent.value = 'paused'
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
        await audio.value.play()
        mediaSessionManager.updatePlaybackState(true)
        await announceNativePlaybackState('playing')
        await startBackgroundAudio(currentStation.value)
      } catch (err) {
        console.error('恢复播放失败')
        console.error('恢复播放错误:', err)
      }
    }
  }

  // 停止播放
  const stopStation = async () => {
    playbackIntent.value = 'stopped'
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
