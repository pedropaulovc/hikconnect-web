'use client'

import { useState, useEffect } from 'react'

type Device = {
  deviceSerial: string
  deviceName: string
  channelNumber: number
  status: number
}

type Camera = {
  deviceSerial: string
  channelNo: number
  channelName: string
  status: number
}

export default function Home() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [cameras, setCameras] = useState<Camera[]>([])
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
    setLoggedIn(true)
    loadDevices()
  }

  const loadDevices = async () => {
    const res = await fetch('/api/devices')
    const data = await res.json()
    if (!res.ok) return setError(data.error)
    setDevices(data.devices ?? [])
  }

  const loadCameras = async (serial: string) => {
    const res = await fetch(`/api/devices/${serial}/cameras`)
    const data = await res.json()
    if (!res.ok) return setError(data.error)
    setCameras(data.cameras ?? [])
  }

  useEffect(() => {
    if (devices.length > 0) {
      loadCameras(devices[0].deviceSerial)
    }
  }, [devices])

  if (!loggedIn) {
    return (
      <div style={{ maxWidth: 400, margin: '80px auto', fontFamily: 'system-ui' }}>
        <h1>HikConnect Web</h1>
        <form onSubmit={login}>
          <div style={{ marginBottom: 12 }}>
            <input name="account" placeholder="Email / Username" required
              style={{ width: '100%', padding: 8, fontSize: 16 }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <input name="password" type="password" placeholder="Password" required
              style={{ width: '100%', padding: 8, fontSize: 16 }} />
          </div>
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: 10, fontSize: 16, cursor: 'pointer' }}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
          {error && <p style={{ color: 'red' }}>{error}</p>}
        </form>
      </div>
    )
  }

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui' }}>
      <h1>Devices</h1>
      {devices.map(d => (
        <div key={d.deviceSerial} style={{ marginBottom: 20 }}>
          <h2>{d.deviceName} ({d.deviceSerial})</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {cameras
              .filter(c => c.deviceSerial === d.deviceSerial)
              .map(c => (
                <CameraCard key={`${c.deviceSerial}-${c.channelNo}`} camera={c} />
              ))}
          </div>
        </div>
      ))}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  )
}

function CameraCard({ camera }: { camera: Camera }) {
  const [streaming, setStreaming] = useState(false)
  const [playlistUrl, setPlaylistUrl] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const startStream = async () => {
    setLoading(true)
    setError('')
    const code = prompt('Enter device verification code (6 chars):')
    if (!code) { setLoading(false); return }

    const res = await fetch('/api/stream/start', {
      method: 'POST',
      body: JSON.stringify({
        deviceSerial: camera.deviceSerial,
        channel: camera.channelNo,
        streamType: 1,
        verificationCode: code,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) return setError(data.error)

    setSessionId(data.sessionId)
    setPlaylistUrl(data.playlistUrl)
    setStreaming(true)
  }

  const stopStream = async () => {
    await fetch('/api/stream/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
      headers: { 'Content-Type': 'application/json' },
    })
    setStreaming(false)
    setPlaylistUrl('')
  }

  return (
    <div style={{ border: '1px solid #ccc', borderRadius: 8, overflow: 'hidden' }}>
      {streaming && playlistUrl ? (
        <HlsPlayer url={playlistUrl} />
      ) : (
        <div style={{ height: 200, background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>
          No stream
        </div>
      )}
      <div style={{ padding: 12 }}>
        <strong>{camera.channelName}</strong>
        <span style={{ color: '#888', marginLeft: 8 }}>Ch {camera.channelNo}</span>
        <div style={{ marginTop: 8 }}>
          {streaming ? (
            <button onClick={stopStream} style={{ padding: '6px 16px', cursor: 'pointer' }}>Stop</button>
          ) : (
            <button onClick={startStream} disabled={loading} style={{ padding: '6px 16px', cursor: 'pointer' }}>
              {loading ? 'Starting...' : 'Live View'}
            </button>
          )}
          {error && <span style={{ color: 'red', marginLeft: 8, fontSize: 12 }}>{error}</span>}
        </div>
      </div>
    </div>
  )
}

function HlsPlayer({ url }: { url: string }) {
  useEffect(() => {
    const video = document.getElementById('hls-player') as HTMLVideoElement
    if (!video) return

    // Dynamic import of hls.js
    import('hls.js').then(({ default: Hls }) => {
      if (!Hls.isSupported()) {
        video.src = url
        return
      }

      const hls = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        enableWorker: true,
      })

      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })

      return () => hls.destroy()
    })
  }, [url])

  return (
    <video
      id="hls-player"
      style={{ width: '100%', height: 200, background: '#000' }}
      controls
      autoPlay
      muted
    />
  )
}
