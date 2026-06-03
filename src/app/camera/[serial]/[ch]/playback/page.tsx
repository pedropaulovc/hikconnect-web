'use client'

import { use, useState } from 'react'
import NavHeader from '@/components/NavHeader'
import VideoPlayer from '@/components/VideoPlayer'
import TimelineBar from '@/components/TimelineBar'
import type { Recording } from '@/components/TimelineBar'
import type { PlaybackState, AlarmPanelState } from '@/app/camera/stream-states'
import { buildRecordingsUrl, buildAlarmsUrl } from '@/app/devices/helpers'
import { datetimeLocalToServer, defaultAlarmRange, eventToPlaybackWindow } from '@/app/camera/alarm-helpers'
import type { AlarmEvent } from '@/lib/hikconnect/types'
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
  const [hasLoaded, setHasLoaded] = useState(false)
  const [range, setRange] = useState(() => defaultAlarmRange(new Date()))
  const [events, setEvents] = useState<AlarmEvent[]>([])
  const [alarmState, setAlarmState] = useState<AlarmPanelState>('idle')
  const [nextOffset, setNextOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  const loadRecordings = async () => {
    if (!date) return
    setState('loading-recordings')
    setError('')
    setHasLoaded(false)
    try {
      const res = await fetch(buildRecordingsUrl(serial, Number(ch), date))
      const data = await res.json()
      setRecordings(data.files ?? [])
      setHasLoaded(true)
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

  const loadEvents = async (offset: number, append: boolean) => {
    setAlarmState('loading')
    try {
      const url = buildAlarmsUrl(
        serial, Number(ch),
        datetimeLocalToServer(range.from), datetimeLocalToServer(range.to),
        offset,
      )
      const res = await fetch(url)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setEvents(prev => append ? [...prev, ...data.events] : data.events)
      setNextOffset(data.nextOffset)
      setHasMore(data.hasMore)
      setAlarmState('loaded')
    } catch {
      setAlarmState('error')
    }
  }

  const playEvent = (event: AlarmEvent) => {
    const window = eventToPlaybackWindow(event)
    playRecording({ begin: window.begin, end: window.end })
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

        {hasLoaded && recordings.length === 0 && (
          <p className={styles.noRecordings}>No recordings found for {date}</p>
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

        <div className={styles.eventsPanel}>
          <h3 className={styles.eventsTitle}>Events</h3>
          <div className={styles.eventsRange}>
            <input type="datetime-local" value={range.from}
              onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className={styles.dateInput} />
            <span>→</span>
            <input type="datetime-local" value={range.to}
              onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className={styles.dateInput} />
            <button onClick={() => loadEvents(0, false)} disabled={alarmState === 'loading'} className={styles.loadButton}>
              {alarmState === 'loading' ? 'Loading...' : 'Load Events'}
            </button>
          </div>

          {alarmState === 'error' && <p className={styles.error}>Failed to load events</p>}
          {alarmState === 'loaded' && events.length === 0 && <p className={styles.noRecordings}>No events in range</p>}

          <div className={styles.eventsList}>
            {events.map(ev => (
              <div key={ev.alarmId} className={styles.eventItem} onClick={() => playEvent(ev)}>
                {ev.isEncrypt === 0 && ev.picUrl
                  ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={ev.picUrl} alt={ev.alarmMessage} className={styles.eventThumb} loading="lazy" />
                  )
                  : <div className={styles.eventThumbPlaceholder} />}
                <div className={styles.eventMeta}>
                  <span className={styles.eventName}>
                    {ev.isCheck === 0 && <span className={styles.unreadDot} />}
                    {ev.alarmMessage}
                  </span>
                  <span className={styles.eventTime}>{ev.alarmStartTimeStr}</span>
                </div>
              </div>
            ))}
          </div>

          {hasMore && (
            <button onClick={() => loadEvents(nextOffset, true)} disabled={alarmState === 'loading'} className={styles.loadButton}>
              {alarmState === 'loading' ? 'Loading...' : 'Load More'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
