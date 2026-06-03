/**
 * Unit B complementary tests (implementer-owned, TDD): cover the pre-buffer
 * gating and stop() lifecycle without spawning a real ffmpeg. The tester's
 * ffmpeg-mp4-pipe.test.ts covers the pure functions and the VideoSink surface;
 * these pin the buffering boundary and idempotent teardown.
 *
 * `spawn` is mocked at the module boundary (ESM named exports can't be spied),
 * so the pipe never launches a real ffmpeg.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

import { FfmpegMp4Pipe, parseFfmpegProgressSeconds } from '../ffmpeg-mp4-pipe'

beforeEach(() => {
  spawnMock.mockReset()
})

describe('FfmpegMp4Pipe pre-buffer gating', () => {
  it('does not spawn ffmpeg while buffered data is below the 200KB threshold', () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: '/tmp/export/under-threshold.mp4' })
    pipe.start()

    // Several sub-threshold chunks (~150KB total) stay buffered, no spawn yet.
    for (let i = 0; i < 3; i++) pipe.write(Buffer.alloc(50_000))

    expect(spawnMock).not.toHaveBeenCalled()
    expect(pipe.progressSeconds).toBe(0)
  })
})

describe('FfmpegMp4Pipe stop() without a running ffmpeg', () => {
  it('resolves immediately when ffmpeg was never spawned', async () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: '/tmp/export/no-spawn.mp4' })
    pipe.start()
    pipe.write(Buffer.alloc(1_000)) // buffered only

    await expect(pipe.stop()).resolves.toBeUndefined()
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('parseFfmpegProgressSeconds edge cases', () => {
  it('treats time= with no fractional part', () => {
    expect(parseFfmpegProgressSeconds('time=00:00:05')).toBeCloseTo(5, 2)
  })

  it('ignores a leading bitrate that looks colon-delimited', () => {
    expect(parseFfmpegProgressSeconds('bitrate=12:34 time=00:00:42.00')).toBeCloseTo(42, 2)
  })
})
