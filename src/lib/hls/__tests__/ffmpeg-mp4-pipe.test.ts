/**
 * Unit B (export-footage plan, Tasks 2-4): FfmpegMp4Pipe.
 *
 *  - buildMp4FfmpegArgs(outputPath): pure stream-copy argv (no transcode).
 *  - parseFfmpegProgressSeconds(line): ffmpeg `time=HH:MM:SS.ss` → seconds | null.
 *  - FfmpegMp4Pipe: a VideoSink that remuxes the playback MPEG-PS stream into MP4.
 *
 * Export is ALWAYS playback (busType=2), so the input demuxer is MPEG-PS (`-f mpeg`),
 * matching scripts/test-playback-ps.ts — NOT the live raw-HEVC path. MPEG-PS carries
 * its own PTS, so there is no synthetic `-framerate`.
 *
 * Pure-fn tests assert EXACT argv positions (ffmpeg is order-sensitive). The
 * class tests exercise construction/buffering without spawning real ffmpeg.
 */
import { describe, it, expect } from 'vitest'
import {
  buildMp4FfmpegArgs,
  parseFfmpegProgressSeconds,
  FfmpegMp4Pipe,
} from '../ffmpeg-mp4-pipe'
import type { VideoSink } from '../video-sink'

const OUT = '/tmp/export/cam1.mp4'

describe('buildMp4FfmpegArgs', () => {
  it('stream-copies the video (no re-encode)', () => {
    const args = buildMp4FfmpegArgs(OUT)
    // -c:v must be followed by exactly "copy" — assert the pairing, not a loose
    // substring (an output path could legitimately contain "copy").
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
  })

  it('never invokes a software or GPU transcoder', () => {
    const args = buildMp4FfmpegArgs(OUT)
    expect(args).not.toContain('libx264')
    expect(args).not.toContain('h264_nvenc')
    expect(args).not.toContain('hevc_cuvid')
    // No scaling/filtergraph — stream-copy keeps the native HEVC resolution.
    expect(args).not.toContain('-vf')
    expect(args.join(' ')).not.toMatch(/scale=/)
  })

  it('reads the playback MPEG-PS container from stdin', () => {
    const args = buildMp4FfmpegArgs(OUT)
    // Input demuxer is MPEG-PS (playback container), fed from pipe:0.
    expect(args[args.indexOf('-f') + 1]).toBe('mpeg')
    const iIdx = args.indexOf('-i')
    expect(args[iIdx + 1]).toBe('pipe:0')
  })

  it('does NOT impose a synthetic framerate (MPEG-PS carries its own PTS)', () => {
    // Unlike the live raw-HEVC path, the PS container has timestamps — a
    // forced framerate (either -framerate on input or -r on output) would
    // corrupt the output duration.
    const args = buildMp4FfmpegArgs(OUT)
    expect(args).not.toContain('-framerate')
    expect(args).not.toContain('-r')
  })

  it('copies the video and transcodes audio to AAC (G.711 is not MP4-portable)', () => {
    const args = buildMp4FfmpegArgs(OUT)
    // Video is stream-copied (keep native HEVC); audio is re-encoded to AAC
    // because the NVR records G.711 (pcm_alaw), which a player cannot decode
    // from an MP4. Must NOT drop audio.
    expect(args).not.toContain('-an')
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac')
  })

  it('writes a faststart MP4 to the output path', () => {
    const args = buildMp4FfmpegArgs(OUT)
    // +faststart relocates the moov atom to the front for progressive download.
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart')
    // Output path is the final argv token.
    expect(args[args.length - 1]).toBe(OUT)
  })

  it('orders input options before the output encoder options', () => {
    const args = buildMp4FfmpegArgs(OUT)
    // ffmpeg requires -i (input) to come before output-side options like -c:v.
    expect(args.indexOf('-i')).toBeGreaterThan(-1)
    expect(args.indexOf('-i')).toBeLessThan(args.indexOf('-c:v'))
    // And the output path comes after everything else.
    expect(args.indexOf('-i')).toBeLessThan(args.length - 1)
  })

  it('honors the exact output path it is given', () => {
    const other = '/var/tmp/exports/ex-9/cam2_2026-06-03_140000.mp4'
    expect(buildMp4FfmpegArgs(other)[buildMp4FfmpegArgs(other).length - 1]).toBe(other)
  })
})

describe('parseFfmpegProgressSeconds', () => {
  it('parses time= from a real ffmpeg progress line', () => {
    const line = 'frame= 250 fps=25 q=-1.0 size=2048kB time=00:01:23.50 bitrate=1234kbits/s'
    expect(parseFfmpegProgressSeconds(line)).toBeCloseTo(83.5, 2)
  })

  it('parses hours correctly', () => {
    expect(parseFfmpegProgressSeconds('time=01:00:00.00')).toBeCloseTo(3600, 2)
  })

  it('parses a combined H:M:S.ss value', () => {
    // 2*3600 + 3*60 + 4.25 = 7384.25
    expect(parseFfmpegProgressSeconds('time=02:03:04.25')).toBeCloseTo(7384.25, 2)
  })

  it('returns null when there is no time= field', () => {
    expect(parseFfmpegProgressSeconds('Press [q] to stop, [?] for help')).toBeNull()
  })

  it('returns null for ffmpeg\'s time=N/A (startup, before any output)', () => {
    expect(parseFfmpegProgressSeconds('frame=0 fps=0 q=0.0 size=0kB time=N/A bitrate=N/A')).toBeNull()
  })

  it('uses the time= field, not a stray number elsewhere on the line', () => {
    // bitrate has digits + colons-like noise; only the time= token must be read.
    const line = 'size=512kB time=00:00:10.00 bitrate=99:99 dup=5 drop=0'
    expect(parseFfmpegProgressSeconds(line)).toBeCloseTo(10, 2)
  })

  it('rejects a malformed time with single-digit fields (requires HH:MM:SS shape)', () => {
    // ffmpeg always zero-pads MM and SS. A loose \d+:\d+:\d+ regex would wrongly
    // accept this; the parser must demand the 2-digit minute/second shape.
    expect(parseFfmpegProgressSeconds('time=1:2:3')).toBeNull()
  })
})

describe('FfmpegMp4Pipe', () => {
  it('exposes the output path it was constructed with', () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: OUT })
    expect(pipe.getOutputPath()).toBe(OUT)
  })

  it('implements the VideoSink shape (start/write/stop)', () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: OUT })
    const sink: VideoSink = pipe // must be assignable
    expect(typeof sink.start).toBe('function')
    expect(typeof sink.write).toBe('function')
    expect(typeof sink.stop).toBe('function')
  })

  it('starts progress at 0 and buffers writes without spawning ffmpeg or throwing', () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: '/tmp/export/buffer-test.mp4' })
    pipe.start()
    // A small write is buffered (ffmpeg starts only after the pre-buffer fills),
    // so it must not throw and progress stays at 0 with no output yet.
    expect(() => pipe.write(Buffer.from('test'))).not.toThrow()
    expect(pipe.progressSeconds).toBe(0)
  })

  it('stop() returns a thenable so callers can await the moov-atom flush', () => {
    const pipe = new FfmpegMp4Pipe({ outputPath: '/tmp/export/stop-test.mp4' })
    pipe.start()
    const ret = pipe.stop()
    // Per the design, stop() awaits ffmpeg exit (so +faststart writes the moov).
    // With no ffmpeg spawned yet it must still resolve, not hang or throw.
    expect(typeof (ret as Promise<void>)?.then).toBe('function')
    return expect(ret).resolves.toBeUndefined()
  })

  it('stop() resolves promptly when ffmpeg was never spawned (empty range)', async () => {
    // An empty/zero-byte range never fills the pre-buffer, so no ffmpeg runs.
    // The watchdog will still call stop(); it must NOT hang waiting on a
    // nonexistent process 'close' event. Guard with a real timeout race.
    const pipe = new FfmpegMp4Pipe({ outputPath: '/tmp/export/empty-range.mp4' })
    pipe.start()
    const timedOut = Symbol('timeout')
    const result = await Promise.race([
      pipe.stop().then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r(timedOut), 1000)),
    ])
    expect(result).toBe('resolved')
  })
})
