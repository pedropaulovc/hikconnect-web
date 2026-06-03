import type { LiveStream } from '@/lib/p2p/live-stream'
import type { FfmpegMp4Pipe } from '@/lib/hls/ffmpeg-mp4-pipe'

/**
 * In-memory registry of MP4 export jobs, pinned to globalThis.
 *
 * Next.js bundles each route handler separately, so a plain module-level Map
 * gets duplicated per route bundle — /export/start would write to one Map and
 * /export/[id]/status read an empty other. globalThis is shared across every
 * bundle in the process and survives HMR. Mirrors stream/sessions.ts.
 */

export const EXPORT_STATES = ['running', 'done', 'error'] as const
export type ExportState = typeof EXPORT_STATES[number]

export type ExportJob = {
  id: string
  state: ExportState
  stream: LiveStream
  pipe: FfmpegMp4Pipe
  outputPath: string
  filename: string
  requestedDurationSec: number
  error?: string
}

const g = globalThis as unknown as { __hikExportJobs?: Map<string, ExportJob> }

/** Keyed by exportId (e.g. "ex-<serial>-<ch>-<ts>"). */
export const exportJobs = (g.__hikExportJobs ??= new Map<string, ExportJob>())

/** Delete finished export files after this long as a backstop (ms). */
export const EXPORT_TTL_MS = 60 * 60 * 1000
