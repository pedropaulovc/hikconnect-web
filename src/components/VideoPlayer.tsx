'use client'

import { useRef, useEffect } from 'react'
import styles from './VideoPlayer.module.css'

export function getHlsConfig(mode?: 'live' | 'playback') {
  const base = {
    enableWorker: true,
    manifestLoadingRetryDelay: 2000,
    manifestLoadingMaxRetry: 30,
    levelLoadingRetryDelay: 2000,
    levelLoadingMaxRetry: 30,
    fragLoadingRetryDelay: 2000,
    fragLoadingMaxRetry: 10,
  }
  if (mode === 'playback') {
    return base
  }
  return {
    ...base,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 6,
  }
}

export default function VideoPlayer({ url, mode }: { url: string; mode?: 'live' | 'playback' }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let hls: any = null

    import('hls.js').then(({ default: Hls }) => {
      if (!Hls.isSupported()) {
        video.src = url
        return
      }

      hls = new Hls(getHlsConfig(mode))
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })
      hls.on(Hls.Events.ERROR, (_event: string, data: any) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError()
          return
        }
        // Fatal network error (e.g. manifest 404 before stream ready) — reload after delay
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setTimeout(() => {
            hls.loadSource(url)
            hls.startLoad()
          }, 2000)
        }
      })
    })

    return () => {
      if (hls) hls.destroy()
    }
  }, [url, mode])

  return (
    <div className={styles.container}>
      <video ref={videoRef} className={styles.video} controls autoPlay muted playsInline />
    </div>
  )
}
