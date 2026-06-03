import { spawn, ChildProcess, execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type StreamQuality = 'sub' | 'main'

/**
 * Input container fed to FFmpeg. 'hevc' = raw H.265 elementary stream (live
 * preview, after HikRtpExtractor reassembles NALs). 'mpeg' = MPEG Program Stream
 * (playback — the NVR serves recordings as a PS container). The demuxer must
 * match the source or FFmpeg never finds a keyframe and emits no segments.
 */
export type InputFormat = 'hevc' | 'mpeg'

export type HlsConfig = {
  outputDir: string
  segmentDuration?: number
  quality?: StreamQuality
  inputFormat?: InputFormat
}

/**
 * Transcode backend. 'nvenc' = full-resolution GPU pipeline (NVDEC decode +
 * NVENC encode, zero-copy on the GPU) — serves the native source (main 4K,
 * sub 640×480). 'libx264' = CPU fallback that downscales (realtime 4K H.264 on
 * CPU is infeasible). Detected once and cached: requires both hevc_cuvid
 * (decode) and h264_nvenc (encode) in the local ffmpeg.
 */
export type EncoderMode = 'nvenc' | 'libx264'
let cachedEncoder: EncoderMode | null = null
function detectEncoder(): EncoderMode {
  if (cachedEncoder) return cachedEncoder
  try {
    const enc = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
    const dec = execFileSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' })
    cachedEncoder = enc.includes('h264_nvenc') && dec.includes('hevc_cuvid') ? 'nvenc' : 'libx264'
  } catch {
    cachedEncoder = 'libx264'
  }
  console.log(`[ffmpeg] transcode backend: ${cachedEncoder}`)
  return cachedEncoder
}

/**
 * Build the FFmpeg argv for the HLS transcode. Pure function (no I/O) so the
 * two backends can be regression-tested. All streams transcode H.265→H.264
 * because browsers don't support H.265 in HLS.
 */
export function buildHlsFfmpegArgs(
  encoder: EncoderMode,
  quality: StreamQuality,
  segDuration: number,
  outputDir: string,
  playlistPath: string,
  inputFormat: InputFormat = 'hevc',
): string[] {
  // Input demuxer. The raw 'hevc' elementary stream has no container timestamps,
  // so we impose a synthetic framerate; MPEG-PS carries its own PTS — don't.
  const inputArgs = inputFormat === 'mpeg'
    ? ['-f', 'mpeg', '-i', 'pipe:0']
    : ['-f', 'hevc', '-framerate', '25', '-i', 'pipe:0']

  const hlsArgs = [
    '-f', 'hls',
    '-hls_time', String(segDuration),
    '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', join(outputDir, 'seg_%03d.ts'),
    playlistPath,
  ]

  if (encoder === 'nvenc') {
    // Full-resolution GPU pipeline: NVDEC decodes the H.265 and NVENC encodes
    // H.264, frames staying in GPU memory the whole way (no -vf, zero-copy).
    // No downscale — serves the native source (main 3840×2160, sub 640×480).
    return [
      '-probesize', '500000',
      '-analyzeduration', '2000000',
      '-err_detect', 'ignore_err',
      '-hwaccel', 'cuda',
      '-hwaccel_output_format', 'cuda',
      '-c:v', 'hevc_cuvid',
      ...inputArgs,
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',      // balanced quality/speed; a 3090 does 4K realtime easily
      '-tune', 'll',        // low-latency for live HLS
      '-rc', 'vbr',
      '-cq', quality === 'main' ? '23' : '26',
      '-bf', '0',           // no B-frames → lower latency
      '-g', '25',
      ...hlsArgs,
    ]
  }

  // CPU fallback (no NVIDIA GPU): libx264 + downscale — realtime 4K H.264 on
  // CPU is infeasible, so main 4K→720p, sub→360p.
  const scale = quality === 'main' ? '1280:720' : '640:360'
  const crf = quality === 'main' ? '28' : '30'
  return [
    '-probesize', '500000',
    '-analyzeduration', '2000000',
    '-err_detect', 'ignore_err',
    ...inputArgs,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-vf', `scale=${scale}`,
    '-crf', crf,
    '-g', '25',
    '-sc_threshold', '0',
    '-x264-params', 'sliced-threads=0:threads=4',  // prevent slice boundary artifacts
    ...hlsArgs,
  ]
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

    // If FFmpeg exits, in-flight writes to its stdin surface as an async EPIPE
    // 'error' event — swallow it so an unhandled error can't crash the server.
    this.process.stdin?.on('error', (err) => {
      console.error('[ffmpeg] stdin error (FFmpeg likely exited):', err.message)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      // FFmpeg logs to stderr
      const line = data.toString().trim()
      if (line) console.log('[ffmpeg]', line)
    })
  }

  private buildFfmpegArgs(quality: StreamQuality, segDuration: number): string[] {
    return buildHlsFfmpegArgs(
      detectEncoder(),
      quality,
      segDuration,
      this.config.outputDir,
      this.playlistPath,
      this.config.inputFormat ?? 'hevc',
    )
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
