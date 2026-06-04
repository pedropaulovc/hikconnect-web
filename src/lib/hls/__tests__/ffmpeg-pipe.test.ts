import { describe, it, expect, afterEach } from 'vitest'
import { FfmpegHlsPipe, buildHlsFfmpegArgs, resolveEncoder } from '../ffmpeg-pipe'

describe('FFmpeg HLS pipe', () => {
  it('constructs with output directory', () => {
    const pipe = new FfmpegHlsPipe({ outputDir: '/tmp/hls-test', segmentDuration: 2 })
    expect(pipe).toBeDefined()
  })

  it('exposes playlist path based on output dir', () => {
    const pipe = new FfmpegHlsPipe({ outputDir: '/tmp/hls-test' })
    expect(pipe.getPlaylistPath()).toBe('/tmp/hls-test/stream.m3u8')
  })

  it('defaults segmentDuration to 2', () => {
    const pipe = new FfmpegHlsPipe({ outputDir: '/tmp/hls-test' })
    expect(pipe).toBeDefined()
  })

  it('buffers data before FFmpeg starts', () => {
    const pipe = new FfmpegHlsPipe({ outputDir: '/tmp/hls-test' })
    pipe.start()
    // write() should buffer data without throwing (FFmpeg starts after 200KB)
    expect(() => pipe.write(Buffer.from('test'))).not.toThrow()
  })
})

describe('buildHlsFfmpegArgs', () => {
  const PLAYLIST = '/tmp/hls/stream.m3u8'
  const OUT = '/tmp/hls'

  describe('nvenc (GPU full-resolution)', () => {
    it('decodes with NVDEC and encodes with NVENC, zero-copy on the GPU', () => {
      const args = buildHlsFfmpegArgs('nvenc', 'main', 2, OUT, PLAYLIST)
      expect(args).toContain('hevc_cuvid')
      expect(args).toContain('h264_nvenc')
      // zero-copy: frames stay in CUDA memory in and out
      expect(args).toContain('cuda')
      expect(args[args.indexOf('-hwaccel_output_format') + 1]).toBe('cuda')
    })

    it('does NOT downscale — serves the native source resolution', () => {
      for (const q of ['main', 'sub'] as const) {
        const args = buildHlsFfmpegArgs('nvenc', q, 2, OUT, PLAYLIST)
        expect(args).not.toContain('-vf')
        expect(args.join(' ')).not.toMatch(/scale=/)
      }
    })

    it('uses a higher quality target for the main stream than the sub', () => {
      const main = buildHlsFfmpegArgs('nvenc', 'main', 2, OUT, PLAYLIST)
      const sub = buildHlsFfmpegArgs('nvenc', 'sub', 2, OUT, PLAYLIST)
      // lower -cq = higher quality
      expect(main[main.indexOf('-cq') + 1]).toBe('23')
      expect(sub[sub.indexOf('-cq') + 1]).toBe('26')
    })

    it('emits an HLS playlist at the given path', () => {
      const args = buildHlsFfmpegArgs('nvenc', 'main', 4, OUT, PLAYLIST)
      expect(args).toContain('hls')
      expect(args[args.length - 1]).toBe(PLAYLIST)
      expect(args[args.indexOf('-hls_time') + 1]).toBe('4')
    })
  })

  describe('libx264 (CPU fallback)', () => {
    it('uses the software encoder, never the GPU one', () => {
      const args = buildHlsFfmpegArgs('libx264', 'main', 2, OUT, PLAYLIST)
      expect(args).toContain('libx264')
      expect(args).not.toContain('h264_nvenc')
      expect(args).not.toContain('hevc_cuvid')
    })

    it('downscales (4K is infeasible on CPU): main→720p, sub→360p', () => {
      const main = buildHlsFfmpegArgs('libx264', 'main', 2, OUT, PLAYLIST)
      const sub = buildHlsFfmpegArgs('libx264', 'sub', 2, OUT, PLAYLIST)
      expect(main[main.indexOf('-vf') + 1]).toBe('scale=1280:720')
      expect(sub[sub.indexOf('-vf') + 1]).toBe('scale=640:360')
    })

    it('emits an HLS playlist at the given path', () => {
      const args = buildHlsFfmpegArgs('libx264', 'sub', 2, OUT, PLAYLIST)
      expect(args).toContain('hls')
      expect(args[args.length - 1]).toBe(PLAYLIST)
    })
  })

  describe('passthrough (HEVC stream-copy, no transcode)', () => {
    it('stream-copies the HEVC payload — no software or GPU encoder', () => {
      const args = buildHlsFfmpegArgs('passthrough', 'main', 2, OUT, PLAYLIST)
      expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
      expect(args).not.toContain('libx264')
      expect(args).not.toContain('h264_nvenc')
      expect(args).not.toContain('hevc_cuvid')
      expect(args).not.toContain('cuda')
    })

    it('never downscales — serves the native source resolution (main 4K, sub 640×480)', () => {
      for (const q of ['main', 'sub'] as const) {
        const args = buildHlsFfmpegArgs('passthrough', q, 2, OUT, PLAYLIST)
        expect(args).not.toContain('-vf')
        expect(args.join(' ')).not.toMatch(/scale=/)
      }
    })

    it('emits fMP4 segments tagged hvc1 so browsers recognise the HEVC track', () => {
      const args = buildHlsFfmpegArgs('passthrough', 'main', 2, OUT, PLAYLIST)
      expect(args[args.indexOf('-hls_segment_type') + 1]).toBe('fmp4')
      expect(args[args.indexOf('-tag:v') + 1]).toBe('hvc1')
      // fMP4 uses .m4s media segments + an init.mp4 header, not .ts
      expect(args.join(' ')).toMatch(/seg_%03d\.m4s/)
      expect(args.join(' ')).not.toMatch(/seg_%03d\.ts/)
    })

    it('runs the hevc_metadata bitstream filter so the fMP4 init carries a populated hvcC', () => {
      // The raw `-f hevc` demuxer does not propagate VPS/SPS/PPS into codec
      // extradata, so a plain `-c:v copy` writes an EMPTY hvcC box — the HLS.js
      // MSE decoder then has no decoder-config record and the 4K stream won't
      // play. The hevc_metadata BSF re-parses the parameter sets back into
      // extradata so the mov muxer builds a valid hvcC. Regression guard.
      const args = buildHlsFfmpegArgs('passthrough', 'main', 2, OUT, PLAYLIST)
      expect(args[args.indexOf('-bsf:v') + 1]).toBe('hevc_metadata')
    })

    it('emits an HLS playlist at the given path with the requested segment time', () => {
      const args = buildHlsFfmpegArgs('passthrough', 'main', 4, OUT, PLAYLIST)
      expect(args).toContain('hls')
      expect(args[args.length - 1]).toBe(PLAYLIST)
      expect(args[args.indexOf('-hls_time') + 1]).toBe('4')
    })

    it('copies HEVC out of the MPEG-PS playback container too', () => {
      const args = buildHlsFfmpegArgs('passthrough', 'main', 2, OUT, PLAYLIST, 'mpeg')
      expect(args[args.indexOf('-f') + 1]).toBe('mpeg')
      expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
      expect(args[args.length - 1]).toBe(PLAYLIST)
    })
  })

  describe('resolveEncoder (HLS_ENCODER override)', () => {
    afterEach(() => {
      delete process.env.HLS_ENCODER
    })

    it('forces the configured backend regardless of GPU detection', () => {
      process.env.HLS_ENCODER = 'passthrough'
      expect(resolveEncoder()).toBe('passthrough')
    })

    it('ignores an unknown value and falls back to auto-detection', () => {
      process.env.HLS_ENCODER = 'bogus'
      // auto-detect returns a real backend (libx264 in CI with no GPU)
      expect(['nvenc', 'libx264']).toContain(resolveEncoder())
    })
  })

  describe('input container format', () => {
    // Live preview delivers a raw H.265 elementary stream (-f hevc); playback
    // delivers an MPEG Program Stream container (-f mpeg). The demuxer must match
    // or FFmpeg never finds a keyframe and produces no segments.

    // The input demuxer is the value after the first '-f' (a later '-f hls' is
    // the output muxer); '-i pipe:0' separates input args from output args.
    const inputDemuxer = (args: string[]) => args[args.indexOf('-f') + 1]

    it('defaults to the raw HEVC demuxer for live preview', () => {
      for (const enc of ['nvenc', 'libx264'] as const) {
        const args = buildHlsFfmpegArgs(enc, 'main', 2, OUT, PLAYLIST)
        expect(inputDemuxer(args)).toBe('hevc')
        // raw demuxer needs an explicit input framerate (PS carries its own PTS)
        expect(args).toContain('-framerate')
      }
    })

    it('uses the MPEG-PS demuxer for playback', () => {
      for (const enc of ['nvenc', 'libx264'] as const) {
        const args = buildHlsFfmpegArgs(enc, 'main', 2, OUT, PLAYLIST, 'mpeg')
        expect(inputDemuxer(args)).toBe('mpeg')
        // raw hevc demuxer must not appear; only output '-f hls' beyond the input
        const inputArgs = args.slice(0, args.indexOf('-i'))
        expect(inputArgs).not.toContain('hevc')
        // PS carries its own timestamps — no synthetic -framerate
        expect(args).not.toContain('-framerate')
      }
    })

    it('still transcodes the HEVC payload to H.264 HLS regardless of container', () => {
      const nvenc = buildHlsFfmpegArgs('nvenc', 'main', 2, OUT, PLAYLIST, 'mpeg')
      expect(nvenc).toContain('hevc_cuvid')   // GPU-decode the HEVC inside the PS
      expect(nvenc).toContain('h264_nvenc')
      expect(nvenc[nvenc.length - 1]).toBe(PLAYLIST)

      const cpu = buildHlsFfmpegArgs('libx264', 'main', 2, OUT, PLAYLIST, 'mpeg')
      expect(cpu).toContain('libx264')
      expect(cpu[cpu.length - 1]).toBe(PLAYLIST)
    })
  })
})
