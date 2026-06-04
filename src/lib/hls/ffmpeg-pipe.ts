import { spawn, ChildProcess, execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { log } from '../telemetry/log'
import { join } from 'node:path'
import type { VideoSink } from './video-sink'

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
 * CPU is infeasible). 'passthrough' = stream-copy the source HEVC into fMP4 HLS,
 * no decode/encode at all — near-zero CPU, but the browser must support HEVC
 * (Safari natively; Chrome only with a hardware HEVC decoder). Detected once
 * and cached: requires both hevc_cuvid (decode) and h264_nvenc (encode).
 */
export type EncoderMode = 'nvenc' | 'libx264' | 'passthrough'

const ENCODER_MODES: readonly EncoderMode[] = ['nvenc', 'libx264', 'passthrough']

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
  log.info(`[ffmpeg] transcode backend: ${cachedEncoder}`)
  return cachedEncoder
}

/**
 * The backend to use: an explicit `HLS_ENCODER` env override (set to
 * `passthrough` in the GPU-less cloud deployment) wins; otherwise auto-detect.
 * An unknown override value is ignored so a typo can't silently break streaming.
 */
export function resolveEncoder(): EncoderMode {
  const override = process.env.HLS_ENCODER as EncoderMode | undefined
  if (override && ENCODER_MODES.includes(override)) return override
  return detectEncoder()
}

/**
 * Build the FFmpeg argv for the HLS output. Pure function (no I/O) so every
 * backend can be regression-tested. 'nvenc'/'libx264' transcode H.265→H.264
 * (broadest browser support); 'passthrough' stream-copies the source HEVC into
 * fMP4 HLS for HEVC-capable browsers (near-zero CPU, no GPU).
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

  if (encoder === 'passthrough') {
    // Stream-copy the source HEVC straight into HLS — no decode, no encode,
    // no scale (native main 4K / sub 640×480). HEVC needs fMP4 segments tagged
    // 'hvc1' (MPEG-TS HLS can't carry HEVC for browsers); ffmpeg cuts segments
    // on source keyframes, so -hls_time is a target, not exact.
    return [
      '-probesize', '500000',
      '-analyzeduration', '2000000',
      '-err_detect', 'ignore_err',
      ...inputArgs,
      '-c:v', 'copy',
      '-tag:v', 'hvc1',
      // The raw `-f hevc` demuxer leaves VPS/SPS/PPS only in-band — codec
      // extradata stays empty, so a plain stream-copy writes an EMPTY hvcC box
      // and HLS.js/MSE has no decoder-config record to start the HEVC decoder.
      // hevc_metadata re-parses the parameter sets into extradata so the mov
      // muxer emits a populated hvcC. Without it the 4K stream never plays.
      '-bsf:v', 'hevc_metadata',
      '-f', 'hls',
      '-hls_time', String(segDuration),
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(outputDir, 'seg_%03d.m4s'),
      playlistPath,
    ]
  }

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

export class FfmpegHlsPipe implements VideoSink {
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
      log.error(`FFmpeg error: ${err.message}`)
    })

    // If FFmpeg exits, in-flight writes to its stdin surface as an async EPIPE
    // 'error' event — swallow it so an unhandled error can't crash the server.
    this.process.stdin?.on('error', (err) => {
      log.error(`[ffmpeg] stdin error (FFmpeg likely exited): ${err.message}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      // FFmpeg logs to stderr
      const line = data.toString().trim()
      if (line) log.info(`[ffmpeg] ${line}`)
    })
  }

  private buildFfmpegArgs(quality: StreamQuality, segDuration: number): string[] {
    return buildHlsFfmpegArgs(
      resolveEncoder(),
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
