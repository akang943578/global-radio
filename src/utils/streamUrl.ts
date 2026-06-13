import type { RadioStation } from '@/types/radio'

export function upgradeToHttpsIfNeeded(url: string): string {
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    url.startsWith('http://')
  ) {
    return `https://${url.slice(7)}`
  }
  return url
}

export function resolveStreamUrl(station: RadioStation): string {
  const raw = (station.url_resolved || station.url || '').trim()
  return upgradeToHttpsIfNeeded(raw)
}

export function isHlsStream(station: RadioStation, url: string): boolean {
  if (station.hls === 1) {
    return true
  }

  const lower = url.toLowerCase()
  return lower.includes('.m3u8') || lower.includes('.isml')
}

export function supportsNativeHls(audio: HTMLAudioElement): boolean {
  return audio.canPlayType('application/vnd.apple.mpegurl') !== '' ||
    audio.canPlayType('application/x-mpegURL') !== ''
}
