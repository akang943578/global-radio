import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { setAudioFocusEnabled } from '@/utils/backgroundAudio'

const STORAGE_KEY_TIMEOUT = 'playbackFailoverTimeoutSec'
const STORAGE_KEY_FORCE_PROXY = 'forceProxyPlayback'
const STORAGE_KEY_SMART_FOCUS = 'smartAudioFocusEnabled'

const DEFAULT_TIMEOUT_SEC = 3
const MIN_TIMEOUT_SEC = 1
const MAX_TIMEOUT_SEC = 15

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_SEC
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.round(value)))
}

function loadTimeoutFromStorage(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TIMEOUT)
    if (raw === null) return DEFAULT_TIMEOUT_SEC
    return clampTimeout(parseFloat(raw))
  } catch {
    return DEFAULT_TIMEOUT_SEC
  }
}

function loadForceProxyFromStorage(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_FORCE_PROXY) === 'true'
  } catch {
    return false
  }
}

// v2.0.25: Default to ON. The whole point of the feature is to yield audio
// to other apps. If the user hits the "phantom LOSS" bug we shipped in
// v2.0.22-v2.0.24, they can flip this off and audio plays no matter what.
function loadSmartFocusFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SMART_FOCUS)
    // null → default true (feature on for new installs)
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

export const usePlaybackSettingsStore = defineStore('playbackSettings', () => {
  const failoverTimeoutSec = ref<number>(loadTimeoutFromStorage())
  const forceProxy = ref<boolean>(loadForceProxyFromStorage())
  const smartAudioFocus = ref<boolean>(loadSmartFocusFromStorage())

  // Push the initial value down to the native plugin immediately. Safe to
  // fire-and-forget; no-op on web/iOS. The plugin defaults to enabled
  // internally too, but being explicit keeps native + JS in sync.
  void setAudioFocusEnabled(smartAudioFocus.value)

  // Persist whenever values change so the next playback (and the next app
  // launch) sees the new values without a reload.
  watch(failoverTimeoutSec, (value) => {
    const safe = clampTimeout(value)
    if (safe !== value) {
      failoverTimeoutSec.value = safe
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY_TIMEOUT, String(safe))
    } catch {
      // ignore storage failures (private mode, quota exceeded)
    }
  })

  watch(forceProxy, (value) => {
    try {
      localStorage.setItem(STORAGE_KEY_FORCE_PROXY, value ? 'true' : 'false')
    } catch {
      // ignore
    }
  })

  watch(smartAudioFocus, (value) => {
    try {
      localStorage.setItem(STORAGE_KEY_SMART_FOCUS, value ? 'true' : 'false')
    } catch {
      // ignore
    }
    // Bridge to native immediately so the change takes effect on the
    // *next* play (no app restart needed).
    void setAudioFocusEnabled(value)
  })

  function setFailoverTimeoutSec(value: number) {
    failoverTimeoutSec.value = clampTimeout(value)
  }

  function setForceProxy(value: boolean) {
    forceProxy.value = !!value
  }

  function toggleForceProxy() {
    forceProxy.value = !forceProxy.value
  }

  function setSmartAudioFocus(value: boolean) {
    smartAudioFocus.value = !!value
  }

  function toggleSmartAudioFocus() {
    smartAudioFocus.value = !smartAudioFocus.value
  }

  return {
    failoverTimeoutSec,
    forceProxy,
    smartAudioFocus,
    setFailoverTimeoutSec,
    setForceProxy,
    toggleForceProxy,
    setSmartAudioFocus,
    toggleSmartAudioFocus,
    DEFAULT_TIMEOUT_SEC,
    MIN_TIMEOUT_SEC,
    MAX_TIMEOUT_SEC
  }
})
