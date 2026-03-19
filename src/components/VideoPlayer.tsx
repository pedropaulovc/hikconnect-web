'use client'

import { useRef, useEffect } from 'react'
import styles from './VideoPlayer.module.css'

export function getHlsConfig(mode?: 'live' | 'playback') {
  if (mode === 'playback') {
    return { enableWorker: true }
  }
  return {
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 6,
    enableWorker: true,
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
    })

    return () => {
      if (hls) hls.destroy()
    }
  }, [url, mode])

  return (
    <div className={styles.container}>
      <video ref={videoRef} className={styles.video} muted playsInline />
    </div>
  )
}
