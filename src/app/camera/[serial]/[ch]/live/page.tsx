'use client'

import { use, useState } from 'react'
import NavHeader from '@/components/NavHeader'
import VideoPlayer from '@/components/VideoPlayer'
import type { LiveState } from '@/app/camera/stream-states'
import styles from './page.module.css'

export default function LiveViewPage({ params }: { params: Promise<{ serial: string; ch: string }> }) {
  const { serial, ch } = use(params)
  const [state, setState] = useState<LiveState>('idle')
  const [sessionId, setSessionId] = useState('')
  const [playlistUrl, setPlaylistUrl] = useState('')
  const [error, setError] = useState('')

  const start = async () => {
    const code = prompt('Enter device verification code (6 chars):')
    if (!code) return

    setState('starting')
    setError('')
    const res = await fetch('/api/stream/start', {
      method: 'POST',
      body: JSON.stringify({
        deviceSerial: serial,
        channel: Number(ch),
        streamType: 1,
        verificationCode: code,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error)
      setState('idle')
      return
    }
    setSessionId(data.sessionId)
    setPlaylistUrl(data.playlistUrl)
    setState('streaming')
  }

  const stop = async () => {
    setState('stopping')
    await fetch('/api/stream/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
      headers: { 'Content-Type': 'application/json' },
    })
    setSessionId('')
    setPlaylistUrl('')
    setState('idle')
  }

  return (
    <>
      <NavHeader crumbs={[
        { label: 'Devices', href: '/devices' },
        { label: serial, href: `/devices/${serial}` },
        { label: `Ch ${ch} — Live` },
      ]} />
      <div className={styles.container}>
        <div className={styles.videoArea}>
          {state === 'streaming' && playlistUrl ? (
            <VideoPlayer url={playlistUrl} mode="live" />
          ) : (
            <div className={styles.placeholder}>
              {state === 'starting' ? 'Starting stream...' : state === 'stopping' ? 'Stopping...' : 'No stream'}
            </div>
          )}
        </div>
        <div className={styles.controls}>
          {state === 'streaming' ? (
            <button onClick={stop} className={styles.stopButton}>Stop</button>
          ) : (
            <button onClick={start} disabled={state !== 'idle'} className={styles.startButton}>
              {state === 'starting' ? 'Starting...' : 'Start Live View'}
            </button>
          )}
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </>
  )
}
