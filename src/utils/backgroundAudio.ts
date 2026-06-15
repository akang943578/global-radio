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
  requestAudioFocus(): Promise<{ granted: boolean }>
  /** Release any audio focus we currently hold. */
  abandonAudioFocus(): Promise<{ abandoned: boolean }>
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
 * Subscribe to native audio-focus events. Returns an unsubscribe function.
 * No-op on non-Android platforms (returns a no-op unsubscribe).
 */
export const addAudioFocusListeners = async (handlers: {
  onLost?: (event: AudioFocusLostEvent) => void
  onGained?: (event: AudioFocusGainedEvent) => void
}): Promise<() => void> => {
  if (!isNativeAndroid()) return () => undefined
  const handles: PluginListenerHandle[] = []
  try {
    if (handlers.onLost) {
      handles.push(await BackgroundAudio.addListener('audioFocusLost', handlers.onLost))
    }
    if (handlers.onGained) {
      handles.push(await BackgroundAudio.addListener('audioFocusGained', handlers.onGained))
    }
  } catch (error) {
    console.warn('[backgroundAudio] addAudioFocusListeners failed:', error)
  }
  return () => {
    for (const h of handles) {
      try {
        void h.remove()
      } catch {
        // ignore
      }
    }
  }
}
