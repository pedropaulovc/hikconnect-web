import type { Buffer } from 'node:buffer'

/**
 * A consumer of the decoded video stream produced by LiveStream — the bytes
 * the device sends after Hik-RTP framing (raw HEVC NALs for live preview, or
 * MPEG-PS container bytes for playback). Implemented by the HLS pipe
 * (`FfmpegHlsPipe`) and the MP4 export pipe (`FfmpegMp4Pipe`).
 *
 * `stop()` may be async: the MP4 pipe resolves only once FFmpeg has flushed
 * its `+faststart` moov atom, whereas the HLS pipe tears down synchronously.
 */
export type VideoSink = {
  start(): void
  write(data: Buffer): void
  stop(): void | Promise<void>
}
