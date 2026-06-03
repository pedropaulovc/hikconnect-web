/**
 * Unit D adversarial: POST /api/export/start failure-cleanup path.
 *
 * Isolated in its own file because it mocks the P2P/streaming + client-bootstrap
 * module boundaries (the sibling export-routes.test.ts deliberately runs mock-free
 * against the real registry). Here we let validation pass and reach the try block,
 * then make the P2P session's start() REJECT. The route MUST return 500 AND leave
 * no orphaned 'running' job in the registry (the catch block must exportJobs.delete).
 *
 * Non-vacuous: we assert the job is briefly registered (so the test exercises the
 * register→fail→cleanup sequence, not an early 400 that never touched the registry).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Capture each LiveStream the route constructs; its start() rejects.
const liveStreams: Array<{ start: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }> = []

vi.mock('@/lib/p2p/live-stream', () => ({
  LiveStream: vi.fn(function (this: Record<string, unknown>) {
    const inst = {
      on: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
      start: vi.fn(() => Promise.reject(new Error('p2p hole-punch failed'))),
    }
    liveStreams.push(inst)
    return inst
  }),
}))

vi.mock('@/lib/hls/ffmpeg-mp4-pipe', () => ({
  FfmpegMp4Pipe: vi.fn(function (this: Record<string, unknown>, cfg: { outputPath: string }) {
    return {
      getOutputPath: () => cfg.outputPath,
      progressSeconds: 0,
      start: vi.fn(),
      write: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    }
  }),
}))

vi.mock('@/lib/hikconnect/getClient', () => ({
  getAuthenticatedClient: vi.fn(() => ({
    getP2PConfig: vi.fn(async () => ({
      secretKey: 'x'.repeat(40),
      keyVersion: 101,
      connection: { netIp: '1.2.3.4', wanIp: '1.2.3.4', netStreamPort: 6000 },
    })),
    getP2PSecret: vi.fn(async () => ({
      key: Buffer.alloc(32),
      saltIndex: 0,
      saltVer: 1,
      servers: [{ ip: '9.9.9.9', port: 6000 }],
    })),
    getSession: vi.fn(() => ({ sessionId: 'jwt.session.token' })),
  })),
}))

vi.mock('@/lib/hikconnect/client', () => ({ extractUserId: vi.fn(() => 'user-1') }))
vi.mock('@/lib/p2p/client-id', () => ({ randomClientId: vi.fn(() => 12345) }))

import { exportJobs } from '../jobs'

beforeEach(() => {
  liveStreams.length = 0
  exportJobs.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  exportJobs.clear()
  vi.restoreAllMocks()
})

function postStart(body: unknown): Request {
  return new Request('http://localhost/api/export/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID = {
  deviceSerial: 'DS-FAIL',
  channel: 1,
  startTime: '2026-06-03T14:00:00',
  stopTime: '2026-06-03T14:00:20',
}

describe('POST /api/export/start — failure cleanup', () => {
  it('returns 500 and leaves NO orphaned running job when stream.start() rejects', async () => {
    const { POST } = await import('../start/route')
    const res = await POST(postStart(VALID))

    // We actually reached the streaming layer (validation passed, job was built).
    expect(liveStreams.length).toBe(1)
    expect(liveStreams[0].start).toHaveBeenCalledTimes(1)

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('p2p hole-punch failed') // the rejection message is surfaced

    // The catch block must have deleted the job — no leftover, and specifically
    // none still in 'running'.
    expect(exportJobs.size).toBe(0)
    const running = [...exportJobs.values()].filter(j => j.state === 'running')
    expect(running.length).toBe(0)
  })

  it('does not register the job permanently for the failed export id', async () => {
    const { POST } = await import('../start/route')
    const res = await POST(postStart(VALID))
    expect(res.status).toBe(500)
    // Exact id is timestamped, but whatever it was, nothing must remain.
    expect([...exportJobs.keys()]).toEqual([])
  })
})
