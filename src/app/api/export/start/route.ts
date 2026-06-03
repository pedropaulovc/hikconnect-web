import { NextResponse } from 'next/server'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { LiveStream } from '@/lib/p2p/live-stream'
import { FfmpegMp4Pipe } from '@/lib/hls/ffmpeg-mp4-pipe'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'
import { extractUserId } from '@/lib/hikconnect/client'
import { randomClientId } from '@/lib/p2p/client-id'
import {
  exportJobs,
  EXPORT_TTL_MS,
  type ExportState,
} from '../jobs'
import { durationSeconds, exportFilename } from '../export-helpers'

/** No footage seen after this long → the range is empty; fail the job. */
const NO_DATA_TIMEOUT_MS = 12_000
/** Wall-clock slack past the requested duration before we hard-stop a done job. */
const OVERRUN_SLACK_MS = 15_000
/** ffmpeg output may finish a couple seconds short of the requested range. */
const COMPLETE_TOLERANCE_SEC = 2

/**
 * POST /api/export/start
 * Start a background MP4 export for a recording time range. Reuses the playback
 * P2P wiring (busType=2) but feeds an FfmpegMp4Pipe sink instead of HLS. The
 * NVR has no end-of-stream event, so an inactivity watchdog finalizes the job
 * when ffmpeg's output reaches the requested duration (or stalls).
 */
export async function POST(req: Request) {
  const body = await req.json()
  const { deviceSerial, channel = 1, startTime, stopTime } = body

  if (!deviceSerial) {
    return NextResponse.json({ error: 'deviceSerial is required' }, { status: 400 })
  }
  if (!startTime || !stopTime) {
    return NextResponse.json({ error: 'startTime and stopTime are required' }, { status: 400 })
  }

  const exportId = `ex-${deviceSerial}-${channel}-${Date.now()}`
  const filename = exportFilename(channel, startTime)
  const outputPath = join(tmpdir(), 'exports', exportId, filename)
  const requestedDurationSec = durationSeconds(startTime, stopTime)

  try {
    const client = getAuthenticatedClient()
    const p2pConfig = await client.getP2PConfig(deviceSerial)
    const secret = await client.getP2PSecret()
    const p2pLinkKey = Buffer.from(p2pConfig.secretKey.substring(0, 32), 'ascii')

    const pipe = new FfmpegMp4Pipe({ outputPath })
    const stream = new LiveStream(
      {
        deviceSerial,
        deviceIp: p2pConfig.connection.netIp || p2pConfig.connection.wanIp,
        devicePort: p2pConfig.connection.netStreamPort,
        p2pServers: secret.servers.map(s => ({ host: s.ip, port: s.port })),
        p2pKey: secret.key,
        p2pLinkKey,
        p2pKeyVersion: p2pConfig.keyVersion,
        p2pKeySaltIndex: secret.saltIndex,
        p2pKeySaltVer: secret.saltVer,
        sessionToken: client.getSession()!.sessionId,
        userId: extractUserId(client.getSession()!.sessionId),
        clientId: randomClientId(),
        channelNo: channel,
        streamType: 0, // main stream for playback
        busType: 2, // playback mode
        startTime,
        stopTime,
        // MP4 sink ignores hls; the field is required by the config type.
        hls: { outputDir: dirname(outputPath) },
      },
      () => pipe,
    )

    exportJobs.set(exportId, {
      id: exportId,
      state: 'running',
      stream,
      pipe,
      outputPath,
      filename,
      requestedDurationSec,
    })

    wireWatchdog(exportId, stream, pipe, requestedDurationSec)

    await stream.start()

    return NextResponse.json({ exportId })
  } catch (err) {
    exportJobs.delete(exportId)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * The NVR streams the bounded range at ~realtime then goes quiet — there is no
 * end-of-stream event. ffmpeg's output position (progressSeconds) is the
 * activity signal: when it reaches the requested duration we're done; if it
 * never moves the range was empty. A P2P 'error' fails the job immediately.
 */
function wireWatchdog(
  exportId: string,
  stream: LiveStream,
  pipe: FfmpegMp4Pipe,
  requestedDurationSec: number,
): void {
  const startedAt = Date.now()

  // Single-shot: both the watchdog interval and the 'error' handler can call
  // finalize, and job.state is only set AFTER the await — so a state check
  // wouldn't stop a second caller from flipping a 'done' job to 'error'. The
  // synchronous flag (set before any await) makes the second call a no-op.
  let finalized = false
  const finalize = async (state: ExportState, error?: string) => {
    if (finalized) return
    finalized = true
    clearInterval(timer)
    await stream.stop() // stops P2P + flushes the MP4 (pipe.stop awaits ffmpeg exit)
    const job = exportJobs.get(exportId)
    if (!job) return
    job.state = state
    if (error) job.error = error
    if (state === 'done') scheduleTtlCleanup(exportId)
  }

  stream.on('error', (e: Error) => {
    void finalize('error', e.message)
  })

  const timer = setInterval(() => {
    const progressed = pipe.progressSeconds > 0
    const elapsed = Date.now() - startedAt

    if (progressed && pipe.progressSeconds >= requestedDurationSec - COMPLETE_TOLERANCE_SEC) {
      void finalize('done')
      return
    }
    if (progressed && elapsed > requestedDurationSec * 1000 + OVERRUN_SLACK_MS) {
      void finalize('done')
      return
    }
    if (!progressed && elapsed > NO_DATA_TIMEOUT_MS) {
      void finalize('error', 'no footage for this range')
    }
  }, 1000)
  // Don't let the poll keep the event loop alive; finalize() clears it on every
  // terminal path (incl. the self-healing no-data timeout if start() threw).
  timer.unref?.()
}

/** Backstop: drop a finished export that's never downloaded after the TTL. */
function scheduleTtlCleanup(exportId: string): void {
  setTimeout(() => {
    const job = exportJobs.get(exportId)
    if (!job) return
    rmSync(dirname(job.outputPath), { recursive: true, force: true })
    exportJobs.delete(exportId)
  }, EXPORT_TTL_MS).unref?.()
}
