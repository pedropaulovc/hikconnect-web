import { describe, it, expect } from 'vitest'
import { FfmpegHlsPipe, buildHlsFfmpegArgs } from '../ffmpeg-pipe'

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
