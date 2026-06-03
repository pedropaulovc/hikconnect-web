/**
 * Export integration test (Task 10): drive the REAL production export pipeline
 * against the live NVR and validate the output MP4 with ffprobe.
 *
 * Builds FfmpegMp4Pipe + LiveStream(busType=2) exactly the way
 * src/app/api/export/start/route.ts does — so this exercises the actual sink,
 * the MPEG-PS playback path, and the +faststart MP4 finalize, not a reimpl.
 *
 * Usage: npx tsx scripts/test-export-mp4.ts [startTime] [stopTime]
 *   startTime/stopTime: device wall-clock "YYYY-MM-DDTHH:MM:SS" (no Z).
 *   Default: a ~35s window ~1h ago (NVR retention rotates old footage off).
 * Works behind NAT — no public IP / VPS required.
 */
import { readFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (m) process.env[m[1]] = m[2]
}

import { HikConnectClient, extractUserId } from '../src/lib/hikconnect/client'
import { LiveStream } from '../src/lib/p2p/live-stream'
import { FfmpegMp4Pipe } from '../src/lib/hls/ffmpeg-mp4-pipe'
import { randomClientId } from '../src/lib/p2p/client-id'
import { durationSeconds, exportFilename } from '../src/app/api/export/export-helpers'

const DEVICE_SERIAL = process.env.HIKCONNECT_DEVICE_SERIAL || 'L38239367'
const CHANNEL = 1
const EXPORT_SECONDS = 35
const POLL_MS = 1000
const NO_DATA_TIMEOUT_MS = 12_000
const COMPLETE_TOLERANCE_SEC = 2
/** Hard cap so a stuck stream can't hang the script forever. */
const HARD_CAP_MS = (EXPORT_SECONDS + 30) * 1000

const pad = (n: number) => String(n).padStart(2, '0')

/** Device wall-clock "YYYY-MM-DDTHH:MM:SS" some seconds before now. */
function recentWallClock(secondsAgo: number): string {
  const d = new Date(Date.now() - secondsAgo * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Add N seconds to a wall-clock string by literal arithmetic (no Date/TZ shift). */
function addSeconds(wallClock: string, secs: number): string {
  const [date, time] = wallClock.split('T')
  const [hh, mm, ss] = time.split(':').map(Number)
  const total = hh * 3600 + mm * 60 + ss + secs
  // Same calendar day for our short windows; wrap the clock but keep the date.
  const wrapped = ((total % 86_400) + 86_400) % 86_400
  return `${date}T${pad(Math.floor(wrapped / 3600))}:${pad(Math.floor((wrapped % 3600) / 60))}:${pad(wrapped % 60)}`
}

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`)
  process.exit(1)
}

async function main() {
  console.log('=== Export MP4 Integration Test ===\n')

  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('Logged in:', session.apiDomain)

  const startTime = process.argv[2] || recentWallClock(60 * 60)
  const stopTime = process.argv[3] || addSeconds(startTime, EXPORT_SECONDS)
  const requestedDurationSec = durationSeconds(startTime, stopTime)
  console.log(`Export range: ${startTime} → ${stopTime} (${requestedDurationSec}s)\n`)

  // Bonus: log raw recording begin/end so we can settle whether they carry a Z.
  const day = startTime.split('T')[0]
  try {
    const recs = await client.getRecordings(DEVICE_SERIAL, CHANNEL, `${day}T00:00:00`, `${day}T23:59:59`)
    console.log(`Recordings on ${day}: count=${recs.length}`)
    if (recs.length) {
      console.log(`  raw begin/end of first segment: "${recs[0].begin}" → "${recs[0].end}"`)
      const last = recs[recs.length - 1]
      console.log(`  raw begin/end of last  segment: "${last.begin}" → "${last.end}"`)
    }
  } catch (e) {
    console.log('  (could not list recordings:', (e as Error).message, ')')
  }
  console.log('')

  // Build the pipeline IDENTICALLY to src/app/api/export/start/route.ts.
  const p2pConfig = await client.getP2PConfig(DEVICE_SERIAL)
  const secret = await client.getP2PSecret()
  const p2pLinkKey = Buffer.from(p2pConfig.secretKey.substring(0, 32), 'ascii')

  const exportId = `ex-${DEVICE_SERIAL}-${CHANNEL}-${Date.now()}`
  const outputPath = join(tmpdir(), 'exports', exportId, exportFilename(CHANNEL, startTime))
  mkdirSync(dirname(outputPath), { recursive: true })

  const pipe = new FfmpegMp4Pipe({ outputPath })
  const stream = new LiveStream(
    {
      deviceSerial: DEVICE_SERIAL,
      deviceIp: p2pConfig.connection.netIp || p2pConfig.connection.wanIp,
      devicePort: p2pConfig.connection.netStreamPort,
      p2pServers: secret.servers.map(s => ({ host: s.ip, port: s.port })),
      p2pKey: secret.key,
      p2pLinkKey,
      p2pKeyVersion: p2pConfig.keyVersion,
      p2pKeySaltIndex: secret.saltIndex,
      p2pKeySaltVer: secret.saltVer,
      sessionToken: session.sessionId,
      userId: extractUserId(session.sessionId),
      clientId: randomClientId(),
      channelNo: CHANNEL,
      streamType: 0,
      busType: 2,
      startTime,
      stopTime,
      hls: { outputDir: dirname(outputPath) },
    },
    () => pipe,
  )

  stream.on('error', (e: Error) => console.log(`[stream error] ${e.message}`))

  console.log('Starting export (P2P playback → FfmpegMp4Pipe)...')
  await stream.start()

  // Drive to completion using the route watchdog's signal: pipe.progressSeconds.
  const startedAt = Date.now()
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      const progress = pipe.progressSeconds
      const elapsed = Date.now() - startedAt
      console.log(`[progress] ${progress.toFixed(1)}s / ${requestedDurationSec}s output`)

      if (progress >= requestedDurationSec - COMPLETE_TOLERANCE_SEC) {
        clearInterval(timer)
        resolve()
        return
      }
      if (progress === 0 && elapsed > NO_DATA_TIMEOUT_MS) {
        clearInterval(timer)
        reject(new Error('no footage for this range (progressSeconds stayed 0)'))
        return
      }
      if (elapsed > HARD_CAP_MS) {
        clearInterval(timer)
        reject(new Error(`hard cap: only ${progress.toFixed(1)}s after ${Math.round(elapsed / 1000)}s wall`))
      }
    }, POLL_MS)
  }).catch(async (e) => {
    await stream.stop()
    fail((e as Error).message)
  })

  console.log('\nFinalizing (stream.stop flushes the +faststart moov)...')
  await stream.stop()

  // --- ffprobe assertions ---
  const probeRaw = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', outputPath,
  ], { encoding: 'utf8' })
  const probe = JSON.parse(probeRaw) as {
    format?: { format_name?: string; duration?: string; size?: string }
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>
  }

  const formatName = probe.format?.format_name ?? ''
  const duration = Number(probe.format?.duration ?? 0)
  const size = statSync(outputPath).size
  const video = probe.streams?.find(s => s.codec_type === 'video')
  const codec = video?.codec_name ?? ''
  const audio = probe.streams?.find(s => s.codec_type === 'audio')
  const acodec = audio?.codec_name ?? ''

  console.log('\n=== ffprobe summary ===')
  console.log(`  output:      ${outputPath}`)
  console.log(`  format_name: ${formatName}`)
  console.log(`  video codec: ${codec} (${video?.width ?? '?'}x${video?.height ?? '?'})`)
  console.log(`  audio codec: ${acodec || '(none)'}`)
  console.log(`  duration:    ${duration.toFixed(2)}s (requested ${requestedDurationSec}s)`)
  console.log(`  size:        ${(size / 1024 / 1024).toFixed(2)} MB`)

  if (!/mp4|mov/.test(formatName)) fail(`container is "${formatName}", expected mp4/mov`)
  if (codec !== 'hevc') fail(`video codec is "${codec}", expected hevc`)
  // The NVR records G.711; export transcodes it to AAC (the MP4-portable codec).
  // A missing audio track means the export silently dropped sound.
  if (acodec !== 'aac') fail(`audio codec is "${acodec || 'none'}", expected aac`)
  if (size <= 0) fail('output file is empty')
  const lo = requestedDurationSec * 0.8
  const hi = requestedDurationSec * 1.2
  if (duration < lo || duration > hi) {
    fail(`duration ${duration.toFixed(2)}s outside ±20% of ${requestedDurationSec}s [${lo.toFixed(1)}, ${hi.toFixed(1)}]`)
  }

  console.log(`\nPASS: ${codec} ${video?.width}x${video?.height} + ${acodec} MP4, ${duration.toFixed(1)}s, ${(size / 1024 / 1024).toFixed(2)}MB`)
  process.exit(0)
}

main().catch(e => { console.error('\nFAIL (fatal):', e); process.exit(1) })
