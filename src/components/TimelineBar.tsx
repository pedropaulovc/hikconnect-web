'use client'

import styles from './TimelineBar.module.css'

export type Recording = { begin: string; end: string }

const MS_PER_DAY = 24 * 60 * 60 * 1000

export function timeToPercent(iso: string, dayStart: number): number {
  return (new Date(iso).getTime() - dayStart) / MS_PER_DAY * 100
}

export function findRecordingAtPercent(
  pct: number,
  recordings: Recording[],
  dayStart: number,
): Recording | undefined {
  if (recordings.length === 0) return undefined

  const clickMs = dayStart + (pct / 100) * MS_PER_DAY

  // Check if click falls inside a recording
  for (const rec of recordings) {
    const begin = new Date(rec.begin).getTime()
    const end = new Date(rec.end).getTime()
    if (clickMs >= begin && clickMs <= end) return rec
  }

  // Find nearest by midpoint distance
  let nearest = recordings[0]
  let minDist = Infinity
  for (const rec of recordings) {
    const mid = (new Date(rec.begin).getTime() + new Date(rec.end).getTime()) / 2
    const dist = Math.abs(clickMs - mid)
    if (dist < minDist) {
      minDist = dist
      nearest = rec
    }
  }
  return nearest
}

const HOUR_LABELS = [0, 3, 6, 9, 12, 15, 18, 21, 24]

type TimelineBarProps = {
  date: string
  recordings: Recording[]
  currentTime?: string
  onSelectTime: (recording: Recording) => void
}

export default function TimelineBar({ date, recordings, currentTime, onSelectTime }: TimelineBarProps) {
  const dayStart = new Date(`${date}T00:00:00Z`).getTime()

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = ((e.clientX - rect.left) / rect.width) * 100
    const rec = findRecordingAtPercent(pct, recordings, dayStart)
    if (rec) onSelectTime(rec)
  }

  return (
    <div className={styles.container}>
      <div className={styles.bar} onClick={handleClick}>
        {recordings.map((rec, i) => {
          const left = timeToPercent(rec.begin, dayStart)
          const right = timeToPercent(rec.end, dayStart)
          return (
            <div
              key={i}
              className={styles.segment}
              style={{ left: `${Math.max(0, left)}%`, width: `${Math.min(100, right) - Math.max(0, left)}%` }}
            />
          )
        })}
        {currentTime && (
          <div
            className={styles.marker}
            style={{ left: `${timeToPercent(currentTime, dayStart)}%` }}
          />
        )}
      </div>
      <div className={styles.labels}>
        {HOUR_LABELS.map(h => (
          <span key={h} className={styles.label} style={{ left: `${(h / 24) * 100}%` }}>
            {h}
          </span>
        ))}
      </div>
    </div>
  )
}
