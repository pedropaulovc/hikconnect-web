/**
 * Unit D (export-footage plan, Tasks 6-8): export API routes.
 *
 * Drives the REAL exported route handlers (POST/GET) with real Request objects;
 * asserts status codes, JSON bodies, and headers against the authoritative
 * response contracts. No live NVR, no real ffmpeg:
 *  - POST /start: only the validation (400) branches are unit-tested. The happy
 *    path stands up real P2P/FFmpeg and is covered by Unit F's integration
 *    script, per the coordinator.
 *  - status/download: the public seam is the real exportJobs registry — we seed
 *    a fake job (and a real temp file for download) directly into it, exactly
 *    as the running export would, then call the real handler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportJobs, type ExportJob } from '../jobs'

const TEMP_ROOT = join(tmpdir(), 'export-route-test')
const createdDirs = new Set<string>()

beforeEach(() => {
  exportJobs.clear()
})

afterEach(() => {
  exportJobs.clear()
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
  createdDirs.clear()
})

/** Seed a job in the real registry, backed by a real on-disk MP4 fixture. */
function seedJob(over: Partial<ExportJob> = {}): { id: string; outputPath: string; size: number } {
  const id = over.id ?? `ex-DS-1-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const dir = join(TEMP_ROOT, id)
  mkdirSync(dir, { recursive: true })
  createdDirs.add(dir)
  const outputPath = join(dir, 'cam1.mp4')
  const bytes = Buffer.from('MP4-FIXTURE-PAYLOAD-bytes-1234567890')
  writeFileSync(outputPath, bytes)
  // Only `progressSeconds` is read by the status route; stub the rest of pipe.
  const pipe = { progressSeconds: 0 } as unknown as ExportJob['pipe']
  const job: ExportJob = {
    id,
    state: 'running',
    stream: {} as ExportJob['stream'],
    pipe,
    outputPath,
    filename: 'cam1_2026-06-03_140000.mp4',
    requestedDurationSec: 300,
    ...over,
  }
  exportJobs.set(id, job)
  return { id, outputPath, size: bytes.length }
}

function reqParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

// --- POST /api/export/start : validation branches only ---

function postStart(body: unknown): Request {
  return new Request('http://localhost/api/export/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const FULL = {
  deviceSerial: 'DS-123',
  channel: 1,
  startTime: '2026-06-03T14:00:00',
  stopTime: '2026-06-03T14:00:20',
}

describe('POST /api/export/start — validation', () => {
  it('400 when deviceSerial is missing', async () => {
    const { POST } = await import('../start/route')
    const res = await POST(postStart({ startTime: FULL.startTime, stopTime: FULL.stopTime }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(typeof json.error).toBe('string')
    // A rejected request must not register a job.
    expect(exportJobs.size).toBe(0)
  })

  it('400 when startTime is missing', async () => {
    const { POST } = await import('../start/route')
    const res = await POST(postStart({ deviceSerial: 'DS-123', stopTime: FULL.stopTime }))
    expect(res.status).toBe(400)
    expect(exportJobs.size).toBe(0)
  })

  it('400 when stopTime is missing', async () => {
    const { POST } = await import('../start/route')
    const res = await POST(postStart({ deviceSerial: 'DS-123', startTime: FULL.startTime }))
    expect(res.status).toBe(400)
    expect(exportJobs.size).toBe(0)
  })

  it('400 when the body is empty', async () => {
    const { POST } = await import('../start/route')
    const res = await POST(postStart({}))
    expect(res.status).toBe(400)
    expect(exportJobs.size).toBe(0)
  })
})

// --- GET /api/export/[id]/status ---

describe('GET /api/export/[id]/status', () => {
  it('404 with {error:"not found"} for an unknown id', async () => {
    const { GET } = await import('../[id]/status/route')
    const res = await GET(new Request('http://localhost/api/export/nope/status'), reqParams('nope'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('reports running progress as the exact floored percent of the requested duration', async () => {
    const { id, size } = seedJob({ requestedDurationSec: 300 })
    ;(exportJobs.get(id)!.pipe as { progressSeconds: number }).progressSeconds = 150 // 50%

    const { GET } = await import('../[id]/status/route')
    const res = await GET(new Request(`http://localhost/api/export/${id}/status`), reqParams(id))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.state).toBe('running')
    expect(json.percent).toBe(50)
    expect(json.durationSec).toBe(300)
    expect(json.filename).toBe('cam1_2026-06-03_140000.mp4')
    expect(json.sizeBytes).toBe(size)
  })

  it('floors fractional progress (199/300 → 66, not 67 or 100)', async () => {
    const { id } = seedJob({ requestedDurationSec: 300 })
    ;(exportJobs.get(id)!.pipe as { progressSeconds: number }).progressSeconds = 199

    const { GET } = await import('../[id]/status/route')
    const res = await GET(new Request(`http://localhost/api/export/${id}/status`), reqParams(id))
    expect((await res.json()).percent).toBe(66)
  })

  it('reports 100% when the job is done, regardless of pipe progress', async () => {
    const { id } = seedJob({ state: 'done', requestedDurationSec: 300 })
    // progressSeconds intentionally left at 0 — done must still be 100.
    const { GET } = await import('../[id]/status/route')
    const res = await GET(new Request(`http://localhost/api/export/${id}/status`), reqParams(id))
    const json = await res.json()
    expect(json.state).toBe('done')
    expect(json.percent).toBe(100)
  })

  it('surfaces the error message for a failed job', async () => {
    const { id } = seedJob({ state: 'error', error: 'no footage for this range' })
    const { GET } = await import('../[id]/status/route')
    const res = await GET(new Request(`http://localhost/api/export/${id}/status`), reqParams(id))
    const json = await res.json()
    expect(json.state).toBe('error')
    expect(json.error).toBe('no footage for this range')
  })

  it('reports sizeBytes 0 when the output file does not exist yet', async () => {
    // A running job whose ffmpeg has not created the file. statSync throws → 0.
    const id = `ex-missing-${Date.now()}`
    exportJobs.set(id, {
      id,
      state: 'running',
      stream: {} as ExportJob['stream'],
      pipe: { progressSeconds: 0 } as unknown as ExportJob['pipe'],
      outputPath: join(TEMP_ROOT, 'does-not-exist', 'x.mp4'),
      filename: 'cam1_x.mp4',
      requestedDurationSec: 300,
    })
    const { GET } = await import('../[id]/status/route')
    const res = await GET(new Request(`http://localhost/api/export/${id}/status`), reqParams(id))
    expect(res.status).toBe(200)
    expect((await res.json()).sizeBytes).toBe(0)
  })
})

// --- GET /api/export/[id]/download ---

describe('GET /api/export/[id]/download', () => {
  it('404 for an unknown id', async () => {
    const { GET } = await import('../[id]/download/route')
    const res = await GET(new Request('http://localhost/api/export/nope/download'), reqParams('nope'))
    expect(res.status).toBe(404)
  })

  it('409 when the job exists but is not done (still running)', async () => {
    const { id } = seedJob({ state: 'running' })
    const { GET } = await import('../[id]/download/route')
    const res = await GET(new Request(`http://localhost/api/export/${id}/download`), reqParams(id))
    expect(res.status).toBe(409)
  })

  it('409 when the job errored (never serve a partial/failed file)', async () => {
    const { id } = seedJob({ state: 'error', error: 'boom' })
    const { GET } = await import('../[id]/download/route')
    const res = await GET(new Request(`http://localhost/api/export/${id}/download`), reqParams(id))
    expect(res.status).toBe(409)
  })

  it('serves the finished MP4 as an attachment with correct headers and exact bytes', async () => {
    const { id, outputPath } = seedJob({ state: 'done' })
    const size = statSync(outputPath).size

    const { GET } = await import('../[id]/download/route')
    const res = await GET(new Request(`http://localhost/api/export/${id}/download`), reqParams(id))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('content-disposition'))
      .toBe('attachment; filename="cam1_2026-06-03_140000.mp4"')
    expect(res.headers.get('content-length')).toBe(String(size))

    // Body must be the actual file bytes.
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.length).toBe(size)
    expect(body).toEqual(Buffer.from('MP4-FIXTURE-PAYLOAD-bytes-1234567890'))
  })
})
