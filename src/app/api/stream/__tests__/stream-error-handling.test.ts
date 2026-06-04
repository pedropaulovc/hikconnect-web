/**
 * Regression: the live + playback stream routes must attach an 'error' listener
 * to LiveStream. A Node EventEmitter 'error' with no listener is rethrown
 * uncaught and would crash the worker when a P2P/stream failure lands AFTER
 * start() has resolved. These tests drive the REAL route handlers with a fake
 * LiveStream and assert that emitting 'error' post-start does not throw and that
 * the stream is torn down + the session entry removed.
 *
 * Non-vacuous: if the route's `stream.on('error', …)` is removed, the
 * `emit('error', …)` below throws and the `.not.toThrow()` assertion fails.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ streams: [] as Array<{ stopped: number; emit: (e: string, ...a: unknown[]) => boolean }> }))

vi.mock('@/lib/p2p/live-stream', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeLiveStream extends EventEmitter {
    stopped = 0
    async start() { return '/playlist.m3u8' }
    async stop() {
      this.stopped++
      this.emit('stateChange', { from: 'streaming', to: 'stopped' })
    }
  }
  return {
    LiveStream: function () {
      const s = new FakeLiveStream()
      hoisted.streams.push(s as unknown as { stopped: number; emit: (e: string, ...a: unknown[]) => boolean })
      return s
    },
  }
})

vi.mock('@/lib/hikconnect/getClient', () => ({
  getAuthenticatedClient: () => ({
    getP2PConfig: async () => ({
      connection: { netIp: '1.2.3.4', wanIp: '1.2.3.4', netStreamPort: 5550 },
      secretKey: 'k'.repeat(40),
      keyVersion: 1,
    }),
    getP2PSecret: async () => ({
      servers: [{ ip: '5.6.7.8', port: 6000 }],
      key: Buffer.alloc(32),
      saltIndex: 0,
      saltVer: 0,
    }),
    getSession: () => ({ sessionId: 'fake.jwt.token' }),
  }),
}))

vi.mock('@/lib/hikconnect/client', () => ({ extractUserId: () => 'user-1' }))

const { POST: startPOST } = await import('../start/route')
const { POST: playbackPOST } = await import('../playback/route')
const { sessions, deviceLastStop } = await import('../sessions')

beforeEach(() => {
  hoisted.streams.length = 0
  sessions.clear()
  deviceLastStop.clear()
})

function jsonReq(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('live stream route — LiveStream error handling', () => {
  it('handles a post-start stream error without throwing, and tears down the session', async () => {
    const res = await startPOST(jsonReq('http://t/api/stream/start', { deviceSerial: 'DS1', channel: 1, quality: 'sub' }))
    expect(res.status).toBe(200)
    const { sessionId } = await res.json()
    expect(sessions.has(sessionId)).toBe(true)
    expect(hoisted.streams).toHaveLength(1)
    const stream = hoisted.streams[0]

    // A P2P failure after start() — must NOT throw uncaught (listener present).
    expect(() => stream.emit('error', new Error('p2p died'))).not.toThrow()
    // The handler stops the stream (releases P2P + ffmpeg) and the resulting
    // stateChange→stopped drops the session entry.
    expect(stream.stopped).toBe(1)
    expect(sessions.has(sessionId)).toBe(false)
  })
})

describe('playback stream route — LiveStream error handling', () => {
  it('handles a post-start stream error without throwing, and tears down the session', async () => {
    const res = await playbackPOST(jsonReq('http://t/api/stream/playback', {
      deviceSerial: 'DS1', channel: 1, startTime: '2026-06-03T14:00:00', stopTime: '2026-06-03T14:00:30',
    }))
    expect(res.status).toBe(200)
    const { sessionId } = await res.json()
    expect(sessions.has(sessionId)).toBe(true)
    const stream = hoisted.streams[0]

    expect(() => stream.emit('error', new Error('p2p died'))).not.toThrow()
    expect(stream.stopped).toBe(1)
    expect(sessions.has(sessionId)).toBe(false)
  })
})
