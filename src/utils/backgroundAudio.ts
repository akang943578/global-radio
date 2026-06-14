import { Capacitor, registerPlugin } from '@capacitor/core'
import type { RadioStation } from '@/types/radio'

interface BackgroundAudioPlugin {
  start(options: { title?: string; subtitle?: string }): Promise<{ started: boolean }>
  stop(): Promise<{ stopped: boolean }>
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
