import { spawn, ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type HlsConfig = {
  outputDir: string
  segmentDuration?: number
}

export class FfmpegHlsPipe {
  private process: ChildProcess | null = null
  private playlistPath: string
  private preBuffer: Buffer[] = []
  private preBufferSize = 0
  private started = false

  constructor(private config: HlsConfig) {
    this.playlistPath = join(config.outputDir, 'stream.m3u8')
  }

  start(): void {
    mkdirSync(this.config.outputDir, { recursive: true })
    // Don't start FFmpeg yet — wait for enough buffered data
  }

  write(data: Buffer): void {
    if (!this.started) {
      // Buffer data until we have enough for FFmpeg to find keyframe
      this.preBuffer.push(data)
      this.preBufferSize += data.length
      // Start FFmpeg after accumulating ~200KB (enough for VPS/SPS/PPS + I-frame)
      if (this.preBufferSize >= 200_000) {
        this.startFfmpeg()
        // Flush pre-buffer
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
    const segDuration = this.config.segmentDuration ?? 2
    this.started = true

    this.process = spawn('ffmpeg', [
      '-probesize', '500000',      // Analyze more data before giving up
      '-analyzeduration', '2000000', // Analyze up to 2 seconds
      '-err_detect', 'ignore_err', // Tolerate invalid NAL units
      '-f', 'hevc',                // input format: raw H.265 Annex B
      '-framerate', '25',          // Hint the framerate
      '-i', 'pipe:0',             // stdin input
      '-c:v', 'libx264',           // Re-encode to H.264 for browser compatibility
      '-preset', 'ultrafast',     // Fastest encoding
      '-tune', 'zerolatency',     // Low-latency streaming
      '-vf', 'scale=640:360',      // Scale down 4K → 360p for real-time
      '-crf', '30',               // Quality
      '-g', '25',                  // Keyframe every second
      '-sc_threshold', '0',        // Disable scene change detection
      '-f', 'hls',
      '-hls_time', String(segDuration),
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', join(this.config.outputDir, 'seg_%03d.ts'),
      this.playlistPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.on('error', (err) => {
      console.error('FFmpeg error:', err)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      // FFmpeg logs to stderr
      const line = data.toString().trim()
      if (line) console.log('[ffmpeg]', line)
    })
  }

  stop(): void {
    this.process?.stdin?.end()
    this.process?.kill('SIGTERM')
    this.process = null
  }

  getPlaylistPath(): string {
    return this.playlistPath
  }
}
