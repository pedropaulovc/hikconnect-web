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

  constructor(private config: HlsConfig) {
    this.playlistPath = join(config.outputDir, 'stream.m3u8')
  }

  start(): void {
    mkdirSync(this.config.outputDir, { recursive: true })

    const segDuration = this.config.segmentDuration ?? 2

    this.process = spawn('ffmpeg', [
      '-err_detect', 'ignore_err', // Tolerate invalid NAL units
      '-f', 'hevc',                // input format: raw H.265 Annex B
      '-i', 'pipe:0',             // stdin input
      '-c:v', 'libx264',           // Re-encode to H.264 for browser compatibility
      '-preset', 'ultrafast',     // Fastest encoding
      '-tune', 'zerolatency',     // Low-latency streaming
      '-vf', 'scale=1280:720',    // Scale down 4K → 720p for real-time
      '-crf', '28',               // Quality
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

  write(data: Buffer): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('FFmpeg not running')
    }
    this.process.stdin.write(data)
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
