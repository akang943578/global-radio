import { Capacitor, registerPlugin, PluginListenerHandle } from '@capacitor/core'
import type { RadioStation } from '@/types/radio'

export interface AudioFocusLostEvent {
  transient: boolean
  canDuck: boolean
}

export interface AudioFocusGainedEvent {
  // intentionally empty — presence of the event is the signal
}

interface BackgroundAudioPlugin {
  start(options: { title?: string; subtitle?: string }): Promise<{ started: boolean }>
  stop(): Promise<{ stopped: boolean }>
  /**
   * v2.0.21: request {@code AUDIOFOCUS_GAIN} on the underlying Android
   * AudioManager so the OS pauses other apps' audio (Spotify / phone /
   * navigation) while we play. No-op on iOS (handled by the OS via
   * Info.plist UIBackgroundModes) and on web (no analogue).
   */
  requestAudioFocus(): Promise<{ granted: boolean; skipped?: boolean }>
  /** Release any audio focus we currently hold. */
  abandonAudioFocus(): Promise<{ abandoned: boolean }>
  /**
   * v2.0.25: kill-switch. When set to false, the plugin stops asking
   * Android for audio focus and stops dispatching audio-focus events to
   * JS — effectively rolling back to v2.0.20 behavior where the radio
   * happily plays on top of other apps' audio (which is also the
   * fallback when the audio-focus feature itself misbehaves on a given
   * OEM, e.g. produces phantom LOSS events at play-time).
   */
  setEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>
  addListener(
    eventName: 'audioFocusLost',
    listener: (event: AudioFocusLostEvent) => void
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'audioFocusGained',
    listener: (event: AudioFocusGainedEvent) => void
  ): Promise<PluginListenerHandle>
}

const BackgroundAudio = registerPlugin<BackgroundAudioPlugin>('BackgroundAudio')

const isNativeAndroid = (): boolean => {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/**
 * Promote the app to a foreground service so the OS won't kill the WebView
 * (and the underlying HTMLAudioElement) once the screen turns off.
 *
 * No-op on web and iOS — iOS handles background audio through the
 * Info.plist UIBackgroundModes entry plus the MediaSession plugin.
 */
export const startBackgroundAudio = async (station: RadioStation): Promise<void> => {
  if (!isNativeAndroid()) return
  try {
    await BackgroundAudio.start({
      title: station.name || 'GlobalRadio',
      subtitle: station.country || station.tags || ''
    })
  } catch (error) {
    console.warn('[backgroundAudio] start failed:', error)
  }
}

export const stopBackgroundAudio = async (): Promise<void> => {
  if (!isNativeAndroid()) return
  try {
    await BackgroundAudio.stop()
  } catch (error) {
    console.warn('[backgroundAudio] stop failed:', error)
  }
}

export const requestAudioFocus = async (): Promise<boolean> => {
  if (!isNativeAndroid()) return true
  try {
    const result = await BackgroundAudio.requestAudioFocus()
    return result?.granted === true
  } catch (error) {
    console.warn('[backgroundAudio] requestAudioFocus failed:', error)
    return false
  }
}

export const abandonAudioFocus = async (): Promise<void> => {
  if (!isNativeAndroid()) return
  try {
    await BackgroundAudio.abandonAudioFocus()
  } catch (error) {
    console.warn('[backgroundAudio] abandonAudioFocus failed:', error)
  }
}

/**
 * v2.0.25: flip the kill-switch. JS calls this at boot (and on every
 * setting toggle) so the native plugin knows whether to engage the
 * full audio-focus flow or stay out of the way. No-op outside Android.
 */
export const setAudioFocusEnabled = async (enabled: boolean): Promise<void> => {
  if (!isNativeAndroid()) return
  try {
    await BackgroundAudio.setEnabled({ enabled })
  } catch (error) {
    console.warn('[backgroundAudio] setEnabled failed:', error)
  }
}

/**
 * Subscribe to native audio-focus events. Returns an unsubscribe function.
 * No-op on non-Android platforms (returns a no-op unsubscribe).
 *
 * v2.0.22: belt-and-braces. We register on BOTH the Capacitor plugin event
 * channel AND a window-level CustomEvent fallback. The native plugin
 * dispatches both, so whichever wires up first / faster wins, and we
 * de-dupe on the JS side via timestamps in the consumer (player store).
 *
 * Why two channels: on POCO F5 / HyperOS 3.0.40 we suspected the
 * Capacitor `addListener` registration occasionally races behind first
 * playback on slow boots. The window event fires immediately from the
 * native bridge eval and doesn't need the JS-side handshake to be
 * complete.
 */
export const addAudioFocusListeners = async (handlers: {
  onLost?: (event: AudioFocusLostEvent) => void
  onGained?: (event: AudioFocusGainedEvent) => void
}): Promise<() => void> => {
  const handles: PluginListenerHandle[] = []
  const cleanup: Array<() => void> = []

  // Always wire window-level fallback (works on any platform that has a
  // DOM) so the bridge.eval-dispatched CustomEvent reaches us.
  if (handlers.onLost && typeof window !== 'undefined') {
    const winHandler = (e: Event) => {
      const detail = (e as CustomEvent<AudioFocusLostEvent>).detail || {
        transient: false,
        canDuck: false
      }
      handlers.onLost!(detail)
    }
    window.addEventListener('audioFocusLost', winHandler as EventListener)
    cleanup.push(() => window.removeEventListener('audioFocusLost', winHandler as EventListener))
  }
  if (handlers.onGained && typeof window !== 'undefined') {
    const winHandler = () => handlers.onGained!({})
    window.addEventListener('audioFocusGained', winHandler)
    cleanup.push(() => window.removeEventListener('audioFocusGained', winHandler))
  }

  // Capacitor plugin event channel — only meaningful on native Android.
  if (isNativeAndroid()) {
    try {
      if (handlers.onLost) {
        handles.push(await BackgroundAudio.addListener('audioFocusLost', handlers.onLost))
      }
      if (handlers.onGained) {
        handles.push(await BackgroundAudio.addListener('audioFocusGained', handlers.onGained))
      }
    } catch (error) {
      console.warn('[backgroundAudio] addAudioFocusListeners (plugin channel) failed:', error)
    }
  }

  return () => {
    for (const h of handles) {
      try {
        void h.remove()
      } catch {
        // ignore
      }
    }
    for (const fn of cleanup) {
      try {
        fn()
      } catch {
        // ignore
      }
    }
  }
}
