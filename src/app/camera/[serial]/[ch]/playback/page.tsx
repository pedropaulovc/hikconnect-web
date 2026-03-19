'use client'

import { use, useState } from 'react'
import NavHeader from '@/components/NavHeader'
import VideoPlayer from '@/components/VideoPlayer'
import TimelineBar from '@/components/TimelineBar'
import type { Recording } from '@/components/TimelineBar'
import type { PlaybackState } from '@/app/camera/stream-states'
import { buildRecordingsUrl } from '@/app/devices/helpers'
import styles from './page.module.css'

export default function PlaybackPage({ params }: { params: Promise<{ serial: string; ch: string }> }) {
  const { serial, ch } = use(params)
  const [state, setState] = useState<PlaybackState>('idle')
  const [date, setDate] = useState('')
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [sessionId, setSessionId] = useState('')
  const [playlistUrl, setPlaylistUrl] = useState('')
  const [activeRecording, setActiveRecording] = useState<Recording | null>(null)
  const [error, setError] = useState('')

  const loadRecordings = async () => {
    if (!date) return
    setState('loading-recordings')
    setError('')
    try {
      const res = await fetch(buildRecordingsUrl(serial, Number(ch), date))
      const data = await res.json()
      setRecordings(data.recordings ?? [])
      setState('idle')
    } catch {
      setError('Failed to load recordings')
      setState('idle')
    }
  }

  const stopStream = async () => {
    if (!sessionId) return
    setState('stopping')
    await fetch('/api/stream/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
      headers: { 'Content-Type': 'application/json' },
    })
    setSessionId('')
    setPlaylistUrl('')
    setActiveRecording(null)
    setState('idle')
  }

  const playRecording = async (rec: Recording) => {
    if (sessionId) await stopStream()

    setState('starting')
    setError('')
    setActiveRecording(rec)
    const res = await fetch('/api/stream/playback', {
      method: 'POST',
      body: JSON.stringify({
        deviceSerial: serial,
        channel: Number(ch),
        startTime: rec.begin,
        stopTime: rec.end,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error)
      setState('idle')
      setActiveRecording(null)
      return
    }
    setSessionId(data.sessionId)
    setPlaylistUrl(data.playlistUrl)
    setState('playing')
  }

  return (
    <>
      <NavHeader crumbs={[
        { label: 'Devices', href: '/devices' },
        { label: serial, href: `/devices/${serial}` },
        { label: `Ch ${ch} — Playback` },
      ]} />
      <div className={styles.container}>
        <div className={styles.dateRow}>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className={styles.dateInput}
          />
          <button
            onClick={loadRecordings}
            disabled={!date || state === 'loading-recordings'}
            className={styles.loadButton}
          >
            {state === 'loading-recordings' ? 'Loading...' : 'Load Recordings'}
          </button>
        </div>

        <div className={styles.videoArea}>
          {state === 'playing' && playlistUrl ? (
            <VideoPlayer url={playlistUrl} mode="playback" />
          ) : (
            <div className={styles.placeholder}>
              {state === 'starting' ? 'Starting playback...' : state === 'stopping' ? 'Stopping...' : 'Select a recording'}
            </div>
          )}
        </div>

        {state === 'playing' && (
          <button onClick={stopStream} className={styles.stopButton}>Stop Playback</button>
        )}

        {recordings.length > 0 && date && (
          <>
            <TimelineBar
              date={date}
              recordings={recordings}
              currentTime={activeRecording?.begin}
              onSelectTime={playRecording}
            />
            <div className={styles.recordingsList}>
              {recordings.map((rec, i) => (
                <div
                  key={i}
                  className={`${styles.recordingItem} ${activeRecording === rec ? styles.activeItem : ''}`}
                  onClick={() => playRecording(rec)}
                >
                  <span>{new Date(rec.begin).toLocaleTimeString()} — {new Date(rec.end).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {error && <p className={styles.error}>{error}</p>}
      </div>
    </>
  )
}
