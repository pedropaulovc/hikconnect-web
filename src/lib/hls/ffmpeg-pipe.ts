import { spawn, ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type StreamQuality = 'sub' | 'main'

export type HlsConfig = {
  outputDir: string
  segmentDuration?: number
  quality?: StreamQuality
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
    const quality = this.config.quality ?? 'sub'
    this.started = true

    const args = this.buildFfmpegArgs(quality, segDuration)
    this.process = spawn('ffmpeg', args, {
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

  private buildFfmpegArgs(quality: StreamQuality, segDuration: number): string[] {
    const inputArgs = [
      '-probesize', '500000',
      '-analyzeduration', '2000000',
      '-err_detect', 'ignore_err',
      '-f', 'hevc',
      '-framerate', '25',
      '-i', 'pipe:0',
    ]

    // Main stream: passthrough H.265 into fMP4 HLS (no transcode)
    // Sub stream: transcode H.265→H.264 at 360p for lightweight playback
    const videoArgs = quality === 'main'
      ? ['-c:v', 'copy', '-tag:v', 'hvc1']
      : [
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-vf', 'scale=640:360',
          '-crf', '30',
          '-g', '25',
          '-sc_threshold', '0',
        ]

    const segExt = quality === 'main' ? 'm4s' : 'ts'
    const hlsArgs = [
      '-f', 'hls',
      '-hls_time', String(segDuration),
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list',
      ...(quality === 'main' ? ['-hls_segment_type', 'fmp4'] : []),
      '-hls_segment_filename', join(this.config.outputDir, `seg_%03d.${segExt}`),
      this.playlistPath,
    ]

    return [...inputArgs, ...videoArgs, ...hlsArgs]
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
