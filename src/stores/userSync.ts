import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { FavoriteStation, HistoryItem } from '@/types/radio'
import { EMPTY_USER_DATA, type UserData, type UserSettings } from '@/types/userData'
import { fetchUserData, saveUserData } from '@/services/userDataApi'
import { debounce } from '@/utils/debounce'
import { registerUserDataPushHandler } from '@/services/userDataSyncTrigger'
import { useAuthStore } from '@/stores/auth'
import { usePlayerStore } from '@/stores/player'
import { useHistoryStore } from '@/stores/history'
import { useThemeStore } from '@/stores/theme'
import { useLanguageStore } from '@/stores/language'

const LOCAL_USER_KEY = 'global-radio-local-user'
const LOCAL_UPDATED_AT_KEY = 'radio-data-updated-at'

function getLocalUserMarker(): string | null {
  return localStorage.getItem(LOCAL_USER_KEY)
}

function setLocalUserMarker(username: string | null) {
  if (username) {
    localStorage.setItem(LOCAL_USER_KEY, username)
  } else {
    localStorage.removeItem(LOCAL_USER_KEY)
  }
}

function getLocalUpdatedAt(): string | null {
  return localStorage.getItem(LOCAL_UPDATED_AT_KEY)
}

function setLocalUpdatedAt(value: string | null) {
  if (value) {
    localStorage.setItem(LOCAL_UPDATED_AT_KEY, value)
  } else {
    localStorage.removeItem(LOCAL_UPDATED_AT_KEY)
  }
}

// v2.0.24: server-canonical merge. Walking server first means:
//   * Order on the server defines order for the device that just pulled —
//     so if device A drags-reorders + pushes, device B pulls and gets the
//     same order. (v2.0.23's local-canonical version had it backwards:
//     each device kept its own order on pull.)
//   * Deletions stick: if the user removes B on device A, after a successful
//     push the server has [A, C]. Device A pulls → result is [A, C], not
//     [A, C, B-resurrected].
// Local-only entries (present on local but not on server) are appended at
// the end. They represent unsynced local additions (push hasn't acked yet)
// — emptying them would lose a fresh add. The companion
// `localUpdatedAt > serverUpdatedAt` short-circuit in `pullFromServer`
// also handles this case for the "removed locally, push lost on tab close"
// scenario, by pushing local instead of merging.
function mergeFavorites(server: FavoriteStation[], local: FavoriteStation[]): FavoriteStation[] {
  const serverUuids = new Set(server.map(f => f.stationuuid))
  const result: FavoriteStation[] = server.map(f => ({ ...f }))
  for (const item of local) {
    if (!serverUuids.has(item.stationuuid)) {
      result.push(item)
    }
  }
  return result
}

function mergeHistory(server: HistoryItem[], local: HistoryItem[]): HistoryItem[] {
  return [...server, ...local]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 1000)
}

function mergeSearchHistory(server: string[], local: string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const item of [...local, ...server]) {
    const normalized = item.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    merged.push(normalized)
    if (merged.length >= 10) break
  }

  return merged
}

function readSearchHistoryFromStorage(): string[] {
  try {
    const saved = localStorage.getItem('radio-search-history')
    if (!saved) return []
    const parsed = JSON.parse(saved)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

function writeSearchHistoryToStorage(items: string[]) {
  localStorage.setItem('radio-search-history', JSON.stringify(items))
}

export const useUserSyncStore = defineStore('userSync', () => {
  const syncedForUser = ref<string | null>(null)
  const syncing = ref(false)

  // v2.0.24: holds the most recent payload that wants to go to the server.
  // Updated synchronously by every collect call. Used by the
  // `beforeunload` flush so we don't lose a debounced push when the user
  // closes the tab. Also gives `pushToServer` a way to send an exact known
  // snapshot.
  let pendingPushPayload: UserData | null = null

  function collectLocalUserData(): UserData {
    const playerStore = usePlayerStore()
    const historyStore = useHistoryStore()
    const themeStore = useThemeStore()
    const languageStore = useLanguageStore()

    const payload: UserData = {
      ...EMPTY_USER_DATA,
      updatedAt: new Date().toISOString(),
      favorites: [...playerStore.favorites],
      history: [...historyStore.history],
      searchHistory: readSearchHistoryFromStorage(),
      settings: {
        volume: playerStore.volume,
        muted: playerStore.isMuted,
        themeMode: themeStore.mode,
        language: languageStore.currentLanguage
      }
    }

    // v2.0.24: persist updatedAt locally BEFORE any push attempt so the
    // pull-side conflict resolver can see "I have local changes that
    // never made it to server" if our push gets dropped (e.g. tab closed
    // mid-debounce, network glitch). See pullFromServer below.
    setLocalUpdatedAt(payload.updatedAt)

    pendingPushPayload = payload
    return payload
  }

  function applySettings(settings: UserSettings) {
    const playerStore = usePlayerStore()
    const themeStore = useThemeStore()
    const languageStore = useLanguageStore()

    if (typeof settings.volume === 'number') {
      playerStore.setVolume(settings.volume)
    }

    if (typeof settings.muted === 'boolean' && settings.muted !== playerStore.isMuted) {
      playerStore.toggleMute()
    }

    if (settings.themeMode === 'light' || settings.themeMode === 'dark') {
      themeStore.setMode(settings.themeMode)
    }

    if (typeof settings.language === 'string' && settings.language) {
      languageStore.setLanguage(settings.language as typeof languageStore.currentLanguage)
    }
  }

  function applyUserData(data: UserData) {
    const playerStore = usePlayerStore()
    const historyStore = useHistoryStore()

    playerStore.favorites = [...data.favorites]
    localStorage.setItem('radio-favorites', JSON.stringify(playerStore.favorites))

    historyStore.history = [...data.history]
    localStorage.setItem('radio-history', JSON.stringify(historyStore.history))

    writeSearchHistoryToStorage(data.searchHistory)
    applySettings(data.settings)
  }

  function mergeUserData(serverData: UserData, localData: UserData): UserData {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      favorites: mergeFavorites(serverData.favorites, localData.favorites),
      history: mergeHistory(serverData.history, localData.history),
      searchHistory: mergeSearchHistory(serverData.searchHistory, localData.searchHistory),
      settings: {
        ...localData.settings,
        ...serverData.settings
      }
    }
  }

  async function pushToServer(): Promise<void> {
    const authStore = useAuthStore()
    if (!authStore.user) return

    const payload = collectLocalUserData()
    await saveUserData(payload)
    // Successful push — local & server now agree. Clear the pending
    // payload so beforeunload doesn't re-flush the same one.
    pendingPushPayload = null
  }

  // v2.0.24: 1000ms → 200ms. Made the trailing-edge debounce window much
  // tighter so accidental tab closes lose at most ~200ms of changes
  // instead of nearly a second. Combined with the beforeunload flush
  // below and the immediate-on-delete path, deletions are robust.
  const schedulePushToServer = debounce(() => {
    pushToServer().catch((error) => {
      console.error('同步用户数据到服务器失败:', error)
    })
  }, 200)

  async function pullFromServer(force = false): Promise<void> {
    const authStore = useAuthStore()
    if (!authStore.user) return

    if (!force && syncedForUser.value === authStore.user.username) {
      return
    }

    syncing.value = true

    try {
      const serverData = await fetchUserData()
      const currentUser = authStore.user.username
      const localUser = getLocalUserMarker()

      // v2.0.24: if local has un-synced changes that are newer than the
      // server's last write (because a previous push got dropped — closed
      // tab, network hiccup, race), treat local as authoritative for this
      // round. Push the local snapshot up to server, skip merge. This
      // catches the "removed favorite resurrects on next browser open"
      // scenario: localUpdatedAt was set by collectLocalUserData() at the
      // moment of removal, but `saveUserData` never landed; on next pull
      // the server-canonical merge would re-introduce the deleted entry,
      // unless we detect this and push our newer local view first.
      const localUpdatedAt = localUser === currentUser ? getLocalUpdatedAt() : null
      const serverUpdatedAt = serverData.updatedAt
      if (
        localUpdatedAt &&
        serverUpdatedAt &&
        new Date(localUpdatedAt).getTime() > new Date(serverUpdatedAt).getTime()
      ) {
        console.info(
          `[sync] local newer than server (${localUpdatedAt} > ${serverUpdatedAt}) — pushing local instead of merging`
        )
        await pushToServer()
        syncedForUser.value = currentUser
        setLocalUserMarker(currentUser)
        return
      }

      const localData = localUser === currentUser
        ? collectLocalUserData()
        : { ...EMPTY_USER_DATA }
      const merged = mergeUserData(serverData, localData)

      applyUserData(merged)
      await saveUserData(merged)
      pendingPushPayload = null
      syncedForUser.value = currentUser
      setLocalUserMarker(currentUser)
    } catch (error) {
      console.error('从服务器加载用户数据失败:', error)
    } finally {
      syncing.value = false
    }
  }

  // v2.0.24: flush any pending debounced push when the tab closes. We
  // use `fetch(..., { keepalive: true })` rather than navigator.sendBeacon
  // because (a) our server's /api/user/data only accepts PUT, and
  // sendBeacon is POST-only; (b) keepalive is the modern recommendation
  // and supports any method, with a 64 KB body cap that's well above our
  // typical user-data payload.
  function flushPendingPush() {
    if (!pendingPushPayload) return
    const authStore = useAuthStore()
    if (!authStore.user) {
      pendingPushPayload = null
      return
    }
    try {
      fetch('/api/user/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        keepalive: true,
        body: JSON.stringify(pendingPushPayload)
      })
        .catch((err) => {
          console.warn('[sync] beforeunload flush rejected:', err)
        })
    } catch (err) {
      console.warn('[sync] beforeunload flush threw:', err)
    } finally {
      pendingPushPayload = null
    }
  }

  function clearLocalUserData() {
    const playerStore = usePlayerStore()
    const historyStore = useHistoryStore()

    playerStore.favorites = []
    historyStore.history = []
    localStorage.removeItem('radio-favorites')
    localStorage.removeItem('radio-history')
    localStorage.removeItem('radio-search-history')
    setLocalUserMarker(null)
    setLocalUpdatedAt(null)
    pendingPushPayload = null
  }

  function resetSyncState() {
    syncedForUser.value = null
  }

  function onLogout() {
    clearLocalUserData()
    resetSyncState()
  }

  // v2.0.24: register both the debounced and immediate-fire handlers.
  // Immediate is wired up to a fire-and-forget pushToServer for use by
  // destructive operations (removeFavorite / clearFavorites — see
  // player.ts) where a debounce window risks losing the deletion.
  registerUserDataPushHandler(
    schedulePushToServer,
    () => {
      pushToServer().catch((error) => {
        console.error('立即同步用户数据失败:', error)
      })
    }
  )

  // v2.0.24: install the beforeunload flush exactly once per page load.
  // pagehide is the iOS Safari-friendly alternative; we register both.
  if (typeof window !== 'undefined') {
    const flush = () => flushPendingPush()
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
  }

  return {
    syncedForUser,
    syncing,
    collectLocalUserData,
    pullFromServer,
    pushToServer,
    schedulePushToServer,
    resetSyncState,
    onLogout
  }
})
