import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VideoSink } from './video-sink'

/**
 * FFmpeg argv to remux the playback MPEG-PS stream (stdin) into an MP4 file.
 * Stream-copy: no re-encode, keeps the native HEVC (main 4K / sub 640×480).
 *
 * Export is always playback (busType=2), so the input is the MPEG-PS container
 * the NVR serves recordings as (`-f mpeg`) — NOT the live raw-HEVC elementary
 * stream. MPEG-PS carries its own PTS, so there is no synthetic `-framerate`
 * (which would corrupt the duration). Matches scripts/test-playback-ps.ts.
 */
export function buildMp4FfmpegArgs(outputPath: string): string[] {
  return [
    '-probesize', '500000',
    '-analyzeduration', '2000000',
    '-err_detect', 'ignore_err',
    '-f', 'mpeg',
    '-i', 'pipe:0',
    '-c:v', 'copy',
    '-an',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ]
}

const TIME_RE = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/

/**
 * Extract the current output position (seconds) from an ffmpeg stderr line.
 * Returns null when the line has no `time=HH:MM:SS.ss` field — including
 * ffmpeg's startup `time=N/A` before any frame is written.
 */
export function parseFfmpegProgressSeconds(line: string): number | null {
  const m = TIME_RE.exec(line)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

export type Mp4Config = {
  outputPath: string
}

/** Buffer this much before spawning ffmpeg, so it can find an MPEG-PS keyframe. */
const PRE_BUFFER_BYTES = 200_000
/** Hard cap on the graceful stop() wait before we SIGTERM a hung ffmpeg. */
const STOP_TIMEOUT_MS = 5_000

/**
 * FfmpegMp4Pipe — a VideoSink that remuxes the playback MPEG-PS stream into a
 * single MP4 file via stream-copy. Mirrors FfmpegHlsPipe: pre-buffers ~200 KB
 * before spawning ffmpeg, swallows stdin EPIPE, and tracks output progress from
 * ffmpeg's stderr. `stop()` resolves only once ffmpeg has exited so the
 * `+faststart` moov atom is fully written.
 */
export class FfmpegMp4Pipe implements VideoSink {
  private process: ChildProcess | null = null
  private preBuffer: Buffer[] = []
  private preBufferSize = 0
  private started = false
  private _progress = 0

  constructor(private config: Mp4Config) {}

  start(): void {
    mkdirSync(dirname(this.config.outputPath), { recursive: true })
    // Don't spawn ffmpeg yet — wait for enough buffered data to find a keyframe.
  }

  write(data: Buffer): void {
    if (!this.started) {
      this.preBuffer.push(data)
      this.preBufferSize += data.length
      if (this.preBufferSize >= PRE_BUFFER_BYTES) {
        this.startFfmpeg()
        for (const buf of this.preBuffer) {
          this.process?.stdin?.write(buf)
        }
        this.preBuffer = []
      }
      return
    }
    if (!this.process?.stdin?.writable) return
    this.process.stdin.write(data)
  }

  private startFfmpeg(): void {
    this.started = true
    const args = buildMp4FfmpegArgs(this.config.outputPath)
    this.process = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.on('error', (err) => {
      console.error('[ffmpeg-mp4] error:', err)
    })

    // FFmpeg exiting mid-write surfaces as an async EPIPE on stdin — swallow it
    // so it can't crash the server.
    this.process.stdin?.on('error', (err) => {
      console.error('[ffmpeg-mp4] stdin error (FFmpeg likely exited):', err.message)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (!line) return
      console.log('[ffmpeg-mp4]', line)
      const s = parseFfmpegProgressSeconds(line)
      if (s !== null) this._progress = s
    })
  }

  /** Output position ffmpeg has written so far, in seconds (0 before it starts). */
  get progressSeconds(): number {
    return this._progress
  }

  getOutputPath(): string {
    return this.config.outputPath
  }

  /**
   * Close stdin and wait for ffmpeg to exit, so the `+faststart` moov atom is
   * written before we report the file ready. Resolves immediately if ffmpeg was
   * never spawned (range produced no data). SIGTERMs a hung process after a
   * short timeout so it can't block the caller forever.
   */
  async stop(): Promise<void> {
    const proc = this.process
    if (!proc) return

    proc.stdin?.end()

    const timer = setTimeout(() => proc.kill('SIGTERM'), STOP_TIMEOUT_MS)
    try {
      await once(proc, 'close')
    } finally {
      clearTimeout(timer)
      this.process = null
    }
  }
}
