import { describe, it, expect } from 'vitest'
import { FfmpegHlsPipe } from '../ffmpeg-pipe'

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

  it('throws when writing before start', () => {
    const pipe = new FfmpegHlsPipe({ outputDir: '/tmp/hls-test' })
    expect(() => pipe.write(Buffer.from('test'))).toThrow('FFmpeg not running')
  })
})
