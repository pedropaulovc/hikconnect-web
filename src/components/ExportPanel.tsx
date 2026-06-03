'use client'

import { useEffect, useState } from 'react'
import { serverToDatetimeLocal, datetimeLocalToPlayback } from './export-ui-helpers'
import styles from './ExportPanel.module.css'

type ExportPanelState = 'idle' | 'starting' | 'exporting' | 'done' | 'error'

type Props = {
  serial: string
  channel: number
  /** Device wall-clock start/stop of the selected recording (server format). */
  defaultStart: string
  defaultStop: string
}

export default function ExportPanel({ serial, channel, defaultStart, defaultStop }: Props) {
  const [state, setState] = useState<ExportPanelState>('idle')
  const [start, setStart] = useState(() => serverToDatetimeLocal(defaultStart))
  const [stop, setStop] = useState(() => serverToDatetimeLocal(defaultStop))
  const [exportId, setExportId] = useState('')
  const [percent, setPercent] = useState(0)
  const [filename, setFilename] = useState('')
  const [error, setError] = useState('')

  // Re-seed the inputs when the selected recording changes (unless mid-export).
  // Adjusting state during render off a tracked prop is React's recommended way
  // to reset state on a prop change — no effect, no cascading-render — and the
  // guard keeps the user's edited range while an export is starting/running.
  const [seededFrom, setSeededFrom] = useState({ start: defaultStart, stop: defaultStop })
  if (
    (seededFrom.start !== defaultStart || seededFrom.stop !== defaultStop) &&
    state !== 'starting' && state !== 'exporting'
  ) {
    setSeededFrom({ start: defaultStart, stop: defaultStop })
    setStart(serverToDatetimeLocal(defaultStart))
    setStop(serverToDatetimeLocal(defaultStop))
  }

  // Poll job status once per second while the export is running.
  useEffect(() => {
    if (state !== 'exporting' || !exportId) return
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/export/${exportId}/status`)
        const data = await res.json()
        setPercent(data.percent ?? 0)
        if (data.filename) setFilename(data.filename)
        if (data.state === 'done') setState('done')
        if (data.state === 'error') {
          setError(data.error ?? 'Export failed')
          setState('error')
        }
      } catch {
        setError('Lost contact with the export job')
        setState('error')
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [state, exportId])

  const startExport = async () => {
    setState('starting')
    setError('')
    setPercent(0)
    try {
      const res = await fetch('/api/export/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceSerial: serial,
          channel,
          startTime: datetimeLocalToPlayback(start),
          stopTime: datetimeLocalToPlayback(stop),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to start export')
        setState('error')
        return
      }
      setExportId(data.exportId)
      setState('exporting')
    } catch {
      setError('Failed to start export')
      setState('error')
    }
  }

  const busy = state === 'starting' || state === 'exporting'

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>Export MP4</h3>
      <div className={styles.range}>
        <input
          type="datetime-local"
          step="1"
          value={start}
          onChange={e => setStart(e.target.value)}
          disabled={busy}
          className={styles.input}
        />
        <span>→</span>
        <input
          type="datetime-local"
          step="1"
          value={stop}
          onChange={e => setStop(e.target.value)}
          disabled={busy}
          className={styles.input}
        />
        <button onClick={startExport} disabled={busy || !start || !stop || start >= stop} className={styles.button}>
          {state === 'starting' ? 'Starting…' : state === 'exporting' ? 'Exporting…' : 'Export MP4'}
        </button>
      </div>

      {(state === 'exporting' || state === 'done') && (
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${state === 'done' ? 100 : percent}%` }} />
        </div>
      )}

      {state === 'exporting' && <p className={styles.status}>{percent}%</p>}

      {state === 'done' && (
        <a href={`/api/export/${exportId}/download`} download={filename} className={styles.download}>
          Download {filename}
        </a>
      )}

      {state === 'error' && <p className={styles.error}>{error}</p>}
    </div>
  )
}
