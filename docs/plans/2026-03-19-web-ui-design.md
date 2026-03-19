# Web UI: Live View & Playback — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the single-page prototype with a page-routed dark-theme UI supporting live camera streaming and recording playback with timeline navigation.

**Architecture:** Next.js App Router pages with CSS modules. Extract shared components (VideoPlayer, NavHeader). Reuse all existing API routes and streaming infrastructure unchanged.

**Tech Stack:** Next.js 16 App Router, React 19, CSS modules, hls.js, existing P2P/HLS backend.

---

## High-Level Spec

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Login | Email/password form → redirect to `/devices` |
| `/devices` | Device List | Card grid of NVRs |
| `/devices/[serial]` | Camera List | Cameras for a device, links to live/playback |
| `/camera/[serial]/[ch]/live` | Live View | Full-width HLS player with start/stop |
| `/camera/[serial]/[ch]/playback` | Playback | Date picker, recording list, timeline bar, player |

Shared components: `VideoPlayer`, `RecordingList`, `TimelineBar`, `NavHeader`.

Styling: CSS modules, dark theme (`#1a1a1a` bg, `#e0e0e0` text, `#000` video bg). No external CSS framework.

---

## Task 1: Root layout with global dark styles

**Files:**
- Modify: `src/app/layout.tsx`
- Create: `src/app/globals.css`

**Step 1: Create global CSS**

Create `src/app/globals.css`:

```css
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #111;
  color: #e0e0e0;
  min-height: 100vh;
}

a {
  color: #6cb4ee;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

button {
  font-family: inherit;
  cursor: pointer;
}

input {
  font-family: inherit;
}
```

**Step 2: Update layout to import globals**

Update `src/app/layout.tsx`:

```tsx
import './globals.css'

export const metadata = { title: 'HikConnect Web' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

**Step 3: Verify dev server renders dark background**

Run: `npm run dev` and check `http://localhost:3000` shows dark background.

**Step 4: Commit**

```bash
git add src/app/globals.css src/app/layout.tsx
git commit -m "feat: add global dark theme CSS"
```

---

## Task 2: NavHeader component

**Files:**
- Create: `src/components/NavHeader.tsx`
- Create: `src/components/NavHeader.module.css`

**Step 1: Create NavHeader component**

`src/components/NavHeader.module.css`:

```css
.header {
  padding: 12px 20px;
  border-bottom: 1px solid #333;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.separator {
  color: #555;
}

.link {
  color: #6cb4ee;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.current {
  color: #e0e0e0;
}
```

`src/components/NavHeader.tsx`:

```tsx
import Link from 'next/link'
import styles from './NavHeader.module.css'

type Crumb = { label: string; href?: string }

export function NavHeader({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className={styles.header}>
      {crumbs.map((crumb, i) => (
        <span key={i}>
          {i > 0 && <span className={styles.separator}> › </span>}
          {crumb.href ? (
            <Link href={crumb.href} className={styles.link}>{crumb.label}</Link>
          ) : (
            <span className={styles.current}>{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
```

**Step 2: Commit**

```bash
git add src/components/NavHeader.tsx src/components/NavHeader.module.css
git commit -m "feat: add NavHeader breadcrumb component"
```

---

## Task 3: VideoPlayer component

**Files:**
- Create: `src/components/VideoPlayer.tsx`
- Create: `src/components/VideoPlayer.module.css`

**Step 1: Extract HLS player from page.tsx into component**

`src/components/VideoPlayer.module.css`:

```css
.container {
  background: #000;
  border-radius: 4px;
  overflow: hidden;
}

.video {
  width: 100%;
  display: block;
}
```

`src/components/VideoPlayer.tsx`:

```tsx
'use client'

import { useEffect, useRef } from 'react'
import styles from './VideoPlayer.module.css'

type PlayerMode = 'live' | 'playback'

export function VideoPlayer({ url, mode = 'live' }: { url: string; mode?: PlayerMode }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let hls: import('hls.js').default | undefined

    import('hls.js').then(({ default: Hls }) => {
      if (!Hls.isSupported()) {
        video.src = url
        return
      }

      const config = mode === 'live'
        ? { liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6, enableWorker: true }
        : { enableWorker: true }

      hls = new Hls(config)
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })
    })

    return () => { hls?.destroy() }
  }, [url, mode])

  return (
    <div className={styles.container}>
      <video
        ref={videoRef}
        className={styles.video}
        controls
        autoPlay
        muted
      />
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/components/VideoPlayer.tsx src/components/VideoPlayer.module.css
git commit -m "feat: extract VideoPlayer component with hls.js"
```

---

## Task 4: Login page (`/`)

**Files:**
- Rewrite: `src/app/page.tsx`
- Create: `src/app/page.module.css`

**Step 1: Create login page**

`src/app/page.module.css`:

```css
.container {
  max-width: 360px;
  margin: 120px auto;
  padding: 0 20px;
}

.title {
  font-size: 24px;
  margin-bottom: 24px;
}

.field {
  margin-bottom: 12px;
}

.input {
  width: 100%;
  padding: 10px;
  font-size: 15px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 4px;
  color: #e0e0e0;
}

.input::placeholder {
  color: #666;
}

.button {
  width: 100%;
  padding: 10px;
  font-size: 15px;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 4px;
}

.button:disabled {
  opacity: 0.5;
}

.error {
  color: #f87171;
  margin-top: 12px;
  font-size: 14px;
}
```

`src/app/page.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import styles from './page.module.css'

export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const login = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const form = new FormData(e.currentTarget)
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        account: form.get('account'),
        password: form.get('password'),
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) return setError(data.error)
    router.push('/devices')
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>HikConnect Web</h1>
      <form onSubmit={login}>
        <div className={styles.field}>
          <input name="account" placeholder="Email / Username" required className={styles.input} />
        </div>
        <div className={styles.field}>
          <input name="password" type="password" placeholder="Password" required className={styles.input} />
        </div>
        <button type="submit" disabled={loading} className={styles.button}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </form>
    </div>
  )
}
```

**Step 2: Verify login form renders and submits**

Run: `npm run dev`, navigate to `/`, submit credentials, verify redirect to `/devices`.

**Step 3: Commit**

```bash
git add src/app/page.tsx src/app/page.module.css
git commit -m "feat: login page with routing"
```

---

## Task 5: Devices page (`/devices`)

**Files:**
- Create: `src/app/devices/page.tsx`
- Create: `src/app/devices/page.module.css`

**Step 1: Create devices page**

`src/app/devices/page.module.css`:

```css
.container {
  padding: 20px;
  max-width: 960px;
  margin: 0 auto;
}

.title {
  font-size: 20px;
  margin-bottom: 16px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.card {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 16px;
  transition: border-color 0.15s;
}

.card:hover {
  border-color: #555;
}

.deviceName {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.serial {
  color: #888;
  font-size: 13px;
  margin-bottom: 12px;
}

.statusDot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

.online {
  background: #22c55e;
}

.offline {
  background: #888;
}

.error {
  color: #f87171;
  font-size: 14px;
}
```

`src/app/devices/page.tsx`:

```tsx
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { NavHeader } from '@/components/NavHeader'
import styles from './page.module.css'

type Device = {
  deviceSerial: string
  deviceName: string
  channelNumber: number
  status: number
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/devices')
      .then(r => r.json())
      .then(data => {
        if (data.error) return setError(data.error)
        setDevices(data.devices ?? [])
      })
      .catch(e => setError(e.message))
  }, [])

  return (
    <>
      <NavHeader crumbs={[{ label: 'Devices' }]} />
      <div className={styles.container}>
        <h1 className={styles.title}>Devices</h1>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.grid}>
          {devices.map(d => (
            <Link key={d.deviceSerial} href={`/devices/${d.deviceSerial}`}>
              <div className={styles.card}>
                <div className={styles.deviceName}>{d.deviceName}</div>
                <div className={styles.serial}>{d.deviceSerial}</div>
                <span className={`${styles.statusDot} ${d.status === 1 ? styles.online : styles.offline}`} />
                {d.status === 1 ? 'Online' : 'Offline'}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}
```

**Step 2: Commit**

```bash
git add src/app/devices/page.tsx src/app/devices/page.module.css
git commit -m "feat: devices list page"
```

---

## Task 6: Camera list page (`/devices/[serial]`)

**Files:**
- Create: `src/app/devices/[serial]/page.tsx`
- Create: `src/app/devices/[serial]/page.module.css`

**Step 1: Create camera list page**

`src/app/devices/[serial]/page.module.css`:

```css
.container {
  padding: 20px;
  max-width: 960px;
  margin: 0 auto;
}

.title {
  font-size: 20px;
  margin-bottom: 16px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.card {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 16px;
}

.channelName {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.channelNo {
  color: #888;
  font-size: 13px;
  margin-bottom: 12px;
}

.actions {
  display: flex;
  gap: 8px;
}

.actionLink {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
}

.liveLink {
  background: #2563eb;
  color: white;
}

.playbackLink {
  background: #333;
  color: #e0e0e0;
}

.error {
  color: #f87171;
  font-size: 14px;
}
```

`src/app/devices/[serial]/page.tsx`:

```tsx
'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { NavHeader } from '@/components/NavHeader'
import styles from './page.module.css'

type Camera = {
  deviceSerial: string
  channelNo: number
  channelName: string
  status: number
}

export default function CamerasPage({ params }: { params: Promise<{ serial: string }> }) {
  const { serial } = use(params)
  const [cameras, setCameras] = useState<Camera[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/devices/${serial}/cameras`)
      .then(r => r.json())
      .then(data => {
        if (data.error) return setError(data.error)
        setCameras(data.cameras ?? [])
      })
      .catch(e => setError(e.message))
  }, [serial])

  return (
    <>
      <NavHeader crumbs={[
        { label: 'Devices', href: '/devices' },
        { label: serial },
      ]} />
      <div className={styles.container}>
        <h1 className={styles.title}>Cameras — {serial}</h1>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.grid}>
          {cameras.map(c => (
            <div key={c.channelNo} className={styles.card}>
              <div className={styles.channelName}>{c.channelName}</div>
              <div className={styles.channelNo}>Channel {c.channelNo}</div>
              <div className={styles.actions}>
                <Link href={`/camera/${serial}/${c.channelNo}/live`} className={`${styles.actionLink} ${styles.liveLink}`}>
                  Live View
                </Link>
                <Link href={`/camera/${serial}/${c.channelNo}/playback`} className={`${styles.actionLink} ${styles.playbackLink}`}>
                  Playback
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
```

**Step 2: Commit**

```bash
git add "src/app/devices/[serial]/page.tsx" "src/app/devices/[serial]/page.module.css"
git commit -m "feat: camera list page with live/playback links"
```

---

## Task 7: Live view page (`/camera/[serial]/[ch]/live`)

**Files:**
- Create: `src/app/camera/[serial]/[ch]/live/page.tsx`
- Create: `src/app/camera/[serial]/[ch]/live/page.module.css`

**Step 1: Create live view page**

`src/app/camera/[serial]/[ch]/live/page.module.css`:

```css
.container {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.playerWrap {
  margin-bottom: 16px;
}

.placeholder {
  background: #1a1a1a;
  border-radius: 4px;
  aspect-ratio: 16/9;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  font-size: 14px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.startBtn {
  padding: 8px 20px;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
}

.startBtn:disabled {
  opacity: 0.5;
}

.stopBtn {
  padding: 8px 20px;
  background: #dc2626;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
}

.error {
  color: #f87171;
  font-size: 14px;
}

.status {
  color: #888;
  font-size: 13px;
}
```

`src/app/camera/[serial]/[ch]/live/page.tsx`:

```tsx
'use client'

import { useState, use } from 'react'
import { NavHeader } from '@/components/NavHeader'
import { VideoPlayer } from '@/components/VideoPlayer'
import styles from './page.module.css'

type StreamState = 'idle' | 'starting' | 'streaming' | 'stopping'

export default function LiveViewPage({ params }: { params: Promise<{ serial: string; ch: string }> }) {
  const { serial, ch } = use(params)
  const [state, setState] = useState<StreamState>('idle')
  const [playlistUrl, setPlaylistUrl] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [error, setError] = useState('')

  const startStream = async () => {
    setState('starting')
    setError('')
    const code = prompt('Enter device verification code (6 chars):')
    if (!code) { setState('idle'); return }

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

  const stopStream = async () => {
    setState('stopping')
    await fetch('/api/stream/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
      headers: { 'Content-Type': 'application/json' },
    })
    setPlaylistUrl('')
    setSessionId('')
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
        <div className={styles.playerWrap}>
          {state === 'streaming' && playlistUrl ? (
            <VideoPlayer url={playlistUrl} mode="live" />
          ) : (
            <div className={styles.placeholder}>
              {state === 'starting' ? 'Connecting...' : 'No stream'}
            </div>
          )}
        </div>
        <div className={styles.controls}>
          {state === 'streaming' ? (
            <button onClick={stopStream} className={styles.stopBtn} disabled={state === 'stopping' as unknown as boolean}>
              Stop
            </button>
          ) : (
            <button onClick={startStream} className={styles.startBtn} disabled={state === 'starting'}>
              {state === 'starting' ? 'Starting...' : 'Start Live View'}
            </button>
          )}
          {error && <span className={styles.error}>{error}</span>}
        </div>
      </div>
    </>
  )
}
```

**Step 2: Verify live stream works end-to-end**

Run: `npm run dev`, navigate to `/camera/{serial}/{ch}/live`, click Start, enter verification code, verify HLS video plays.

**Step 3: Commit**

```bash
git add "src/app/camera/[serial]/[ch]/live/page.tsx" "src/app/camera/[serial]/[ch]/live/page.module.css"
git commit -m "feat: live view page with P2P streaming"
```

---

## Task 8: Playback page (`/camera/[serial]/[ch]/playback`)

This is the most complex page. It has three sub-components: date picker, recording list, timeline bar, and the video player.

**Files:**
- Create: `src/app/camera/[serial]/[ch]/playback/page.tsx`
- Create: `src/app/camera/[serial]/[ch]/playback/page.module.css`
- Create: `src/components/TimelineBar.tsx`
- Create: `src/components/TimelineBar.module.css`

**Step 1: Create TimelineBar component**

The TimelineBar shows a 24-hour horizontal bar with colored segments for each recording. Click a position to select a time.

`src/components/TimelineBar.module.css`:

```css
.container {
  margin: 16px 0;
}

.bar {
  position: relative;
  height: 32px;
  background: #1a1a1a;
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
}

.segment {
  position: absolute;
  top: 0;
  height: 100%;
  background: #2563eb;
  opacity: 0.7;
}

.segment:hover {
  opacity: 1;
}

.marker {
  position: absolute;
  top: 0;
  width: 2px;
  height: 100%;
  background: #f87171;
  pointer-events: none;
}

.hours {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #666;
  margin-top: 4px;
  padding: 0 2px;
}
```

`src/components/TimelineBar.tsx`:

```tsx
'use client'

import { useRef } from 'react'
import styles from './TimelineBar.module.css'

type Recording = { begin: string; end: string }

type Props = {
  date: string // YYYY-MM-DD
  recordings: Recording[]
  currentTime?: string // ISO string
  onSelectTime: (startTime: string, stopTime: string) => void
}

const HOURS = Array.from({ length: 9 }, (_, i) => i * 3) // 0, 3, 6, ..., 24

function timeToPercent(iso: string, dayStart: number): number {
  const ms = new Date(iso).getTime() - dayStart
  return Math.max(0, Math.min(100, (ms / (24 * 60 * 60 * 1000)) * 100))
}

export function TimelineBar({ date, recordings, currentTime, onSelectTime }: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const dayStart = new Date(`${date}T00:00:00`).getTime()

  const handleClick = (e: React.MouseEvent) => {
    const bar = barRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    const clickMs = dayStart + pct * 24 * 60 * 60 * 1000
    const clickTime = new Date(clickMs)

    // Find the recording that contains this time
    const hit = recordings.find(r => {
      const begin = new Date(r.begin).getTime()
      const end = new Date(r.end).getTime()
      return clickMs >= begin && clickMs <= end
    })

    if (hit) {
      onSelectTime(hit.begin, hit.end)
      return
    }

    // If no hit, find nearest recording
    let nearest = recordings[0]
    let minDist = Infinity
    for (const r of recordings) {
      const mid = (new Date(r.begin).getTime() + new Date(r.end).getTime()) / 2
      const dist = Math.abs(clickMs - mid)
      if (dist < minDist) {
        minDist = dist
        nearest = r
      }
    }
    if (nearest) {
      onSelectTime(nearest.begin, nearest.end)
    }
  }

  const markerPct = currentTime ? timeToPercent(currentTime, dayStart) : undefined

  return (
    <div className={styles.container}>
      <div className={styles.bar} ref={barRef} onClick={handleClick}>
        {recordings.map((r, i) => {
          const left = timeToPercent(r.begin, dayStart)
          const right = timeToPercent(r.end, dayStart)
          return (
            <div
              key={i}
              className={styles.segment}
              style={{ left: `${left}%`, width: `${right - left}%` }}
            />
          )
        })}
        {markerPct !== undefined && (
          <div className={styles.marker} style={{ left: `${markerPct}%` }} />
        )}
      </div>
      <div className={styles.hours}>
        {HOURS.map(h => <span key={h}>{String(h).padStart(2, '0')}:00</span>)}
      </div>
    </div>
  )
}
```

**Step 2: Create playback page**

`src/app/camera/[serial]/[ch]/playback/page.module.css`:

```css
.container {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.topBar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.dateInput {
  padding: 8px 12px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 14px;
}

.loadBtn {
  padding: 8px 16px;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
}

.loadBtn:disabled {
  opacity: 0.5;
}

.playerWrap {
  margin-bottom: 16px;
}

.placeholder {
  background: #1a1a1a;
  border-radius: 4px;
  aspect-ratio: 16/9;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  font-size: 14px;
}

.recordingList {
  margin-top: 16px;
}

.recordingListTitle {
  font-size: 14px;
  color: #888;
  margin-bottom: 8px;
}

.recordingItem {
  padding: 8px 12px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 4px;
  margin-bottom: 4px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.recordingItem:hover {
  border-color: #555;
}

.recordingItemActive {
  border-color: #2563eb;
}

.playBtn {
  padding: 4px 12px;
  background: #333;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.error {
  color: #f87171;
  font-size: 14px;
  margin-top: 8px;
}

.stopBtn {
  padding: 8px 20px;
  background: #dc2626;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
}

.status {
  color: #888;
  font-size: 13px;
}
```

`src/app/camera/[serial]/[ch]/playback/page.tsx`:

```tsx
'use client'

import { useState, use } from 'react'
import { NavHeader } from '@/components/NavHeader'
import { VideoPlayer } from '@/components/VideoPlayer'
import { TimelineBar } from '@/components/TimelineBar'
import styles from './page.module.css'

type Recording = { begin: string; end: string; type: string }
type StreamState = 'idle' | 'loading-recordings' | 'starting' | 'playing' | 'stopping'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function PlaybackPage({ params }: { params: Promise<{ serial: string; ch: string }> }) {
  const { serial, ch } = use(params)
  const [date, setDate] = useState(todayStr())
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [state, setState] = useState<StreamState>('idle')
  const [playlistUrl, setPlaylistUrl] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [activeRecording, setActiveRecording] = useState<Recording | null>(null)
  const [error, setError] = useState('')

  const loadRecordings = async () => {
    setState('loading-recordings')
    setError('')
    const startTime = `${date}T00:00:00Z`
    const stopTime = `${date}T23:59:59Z`
    const res = await fetch(`/api/devices/${serial}/${ch}/recordings?startTime=${startTime}&stopTime=${stopTime}`)
    const data = await res.json()
    setState('idle')
    if (!res.ok) return setError(data.error)
    setRecordings(data.files ?? [])
  }

  const playRecording = async (startTime: string, stopTime: string) => {
    // Stop any existing stream first
    if (sessionId) {
      await fetch('/api/stream/stop', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
        headers: { 'Content-Type': 'application/json' },
      })
    }

    setState('starting')
    setError('')
    const rec = recordings.find(r => r.begin === startTime && r.end === stopTime)
    setActiveRecording(rec ?? null)

    const res = await fetch('/api/stream/playback', {
      method: 'POST',
      body: JSON.stringify({
        deviceSerial: serial,
        channel: Number(ch),
        startTime,
        stopTime,
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
    setState('playing')
  }

  const stopPlayback = async () => {
    setState('stopping')
    await fetch('/api/stream/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
      headers: { 'Content-Type': 'application/json' },
    })
    setPlaylistUrl('')
    setSessionId('')
    setActiveRecording(null)
    setState('idle')
  }

  const handleTimelineSelect = (startTime: string, stopTime: string) => {
    playRecording(startTime, stopTime)
  }

  return (
    <>
      <NavHeader crumbs={[
        { label: 'Devices', href: '/devices' },
        { label: serial, href: `/devices/${serial}` },
        { label: `Ch ${ch} — Playback` },
      ]} />
      <div className={styles.container}>
        <div className={styles.topBar}>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className={styles.dateInput}
          />
          <button
            onClick={loadRecordings}
            disabled={state === 'loading-recordings'}
            className={styles.loadBtn}
          >
            {state === 'loading-recordings' ? 'Loading...' : 'Load Recordings'}
          </button>
          {state === 'playing' && (
            <button onClick={stopPlayback} className={styles.stopBtn}>Stop</button>
          )}
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.playerWrap}>
          {state === 'playing' && playlistUrl ? (
            <VideoPlayer url={playlistUrl} mode="playback" />
          ) : (
            <div className={styles.placeholder}>
              {state === 'starting' ? 'Starting playback...' : 'Select a recording to play'}
            </div>
          )}
        </div>

        {recordings.length > 0 && (
          <>
            <TimelineBar
              date={date}
              recordings={recordings}
              currentTime={activeRecording?.begin}
              onSelectTime={handleTimelineSelect}
            />

            <div className={styles.recordingList}>
              <div className={styles.recordingListTitle}>
                {recordings.length} recording{recordings.length !== 1 ? 's' : ''}
              </div>
              {recordings.map((r, i) => (
                <div
                  key={i}
                  className={`${styles.recordingItem} ${activeRecording === r ? styles.recordingItemActive : ''}`}
                >
                  <span>{formatTime(r.begin)} — {formatTime(r.end)}</span>
                  <button
                    className={styles.playBtn}
                    onClick={() => playRecording(r.begin, r.end)}
                    disabled={state === 'starting'}
                  >
                    Play
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}
```

**Step 3: Verify playback flow end-to-end**

Run: `npm run dev`, navigate to `/camera/{serial}/{ch}/playback`, pick a date, click Load Recordings, verify timeline bar renders segments, click a recording, verify HLS playback starts.

**Step 4: Commit**

```bash
git add src/components/TimelineBar.tsx src/components/TimelineBar.module.css \
  "src/app/camera/[serial]/[ch]/playback/page.tsx" \
  "src/app/camera/[serial]/[ch]/playback/page.module.css"
git commit -m "feat: playback page with timeline bar and recording list"
```

---

## Task 9: Typecheck and build verification

**Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No errors (ignore `scripts/test-e2e-stream.ts` as noted in CLAUDE.md).

**Step 2: Run build**

Run: `npm run build`
Expected: Build succeeds.

**Step 3: Run tests**

Run: `npm test -- --run`
Expected: All existing tests pass (no tests broken by UI changes since we only added pages/components).

**Step 4: Fix any issues found**

If typecheck or build fails, fix the issues and re-run.

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve typecheck/build issues"
```
