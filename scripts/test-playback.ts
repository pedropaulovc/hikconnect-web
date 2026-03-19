/**
 * End-to-end playback test: fetch recordings → P2P connect → stream 1 min → save MP4
 *
 * Usage:
 *   npx tsx scripts/test-playback.ts [startTime]
 *
 * Examples:
 *   npx tsx scripts/test-playback.ts 2026-03-19T09:00:00
 *   npx tsx scripts/test-playback.ts   # auto-picks recent recording
 *
 * Works behind NAT — no public IP or VPS required.
 * P2P server derives our NAT-mapped address from UDP packet source.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs'

const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient, extractUserId } from '../src/lib/hikconnect/client'
import { P2PSession, P2P_SERVER_KEY } from '../src/lib/p2p/p2p-session'
import { HikRtpExtractor } from '../src/lib/p2p/hik-rtp'
import { spawn } from 'child_process'

const DEVICE_SERIAL = 'L38239367'
const CHANNEL = 1
const CAPTURE_DURATION_MS = 65_000 // 65s to ensure 60s+ of video

/** Optional public IP hint — P2P server derives NAT address from UDP source regardless. */
function getPublicIpHint(): string | undefined {
  return process.env.PUBLIC_IP
}

async function main() {
  console.log('=== Playback Stream Test ===\n')

  // --- Login ---
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('Logged in:', session.apiDomain)

  // --- Find a recording to play ---
  let startTime = process.argv[2]
  let stopTime: string

  if (startTime) {
    // Pass literal time string — NVR expects device-local time, NOT UTC
    const [datePart, timePart] = startTime.split('T')
    const [hh, mm, ss] = timePart.split(':').map(Number)
    const totalSec = hh * 3600 + (mm + 1) * 60 + ss
    const stopH = String(Math.floor(totalSec / 3600)).padStart(2, '0')
    const stopM = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')
    const stopS = String(totalSec % 60).padStart(2, '0')
    stopTime = `${datePart}T${stopH}:${stopM}:${stopS}`
  } else {
    // Auto-pick: query recordings from last 2 hours
    console.log('No startTime provided, querying recent recordings...')
    const now = new Date()
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000)
    const fmt = (d: Date) => d.toISOString().replace(/\.\d+Z$/, '').replace('Z', '')

    const recordings = await client.getRecordings(DEVICE_SERIAL, CHANNEL, fmt(twoHoursAgo), fmt(now))
    if (recordings.length === 0) {
      console.error('No recordings found in the last 2 hours.')
      console.error('Provide a startTime manually: npx tsx scripts/test-playback.ts 2026-03-19T09:00:00')
      process.exit(1)
    }

    // Pick the most recent recording, start 1 min before its end
    const latest = recordings[recordings.length - 1]
    console.log(`Found ${recordings.length} recordings. Latest: ${latest.begin} → ${latest.end}`)
    const latestEnd = new Date(latest.end)
    const pickStart = new Date(latestEnd.getTime() - 90_000) // 90s before end
    startTime = fmt(pickStart)
    stopTime = fmt(latestEnd)
  }

  console.log(`\nPlayback range: ${startTime} → ${stopTime!}\n`)

  // --- P2P config ---
  const p2p = await client.getP2PConfig(DEVICE_SERIAL)
  const p2pLinkKey = Buffer.from(p2p.secretKey.substring(0, 32), 'ascii')
  const publicIpHint = getPublicIpHint()
  console.log(`Public IP hint: ${publicIpHint ?? '(auto — P2P server derives from UDP source)'}`)
  console.log(`Device IP: ${p2p.connection.netIp || p2p.connection.wanIp}:${p2p.connection.netStreamPort}`)

  // --- Stream tokens ---
  const tokenResp = await fetch(`https://${session.apiDomain}/api/user/token/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `sessionId=${encodeURIComponent(session.sessionId)}&clientType=55`,
  })
  const tokenData = await tokenResp.json() as { tokenArray?: string[] }

  // --- P2P session (busType=2 for playback) ---
  const p2pSession = new P2PSession({
    deviceSerial: DEVICE_SERIAL,
    devicePublicIp: p2p.connection.netIp || p2p.connection.wanIp,
    devicePublicPort: p2p.connection.netStreamPort || 9020,
    p2pServers: p2p.servers.map(s => ({ host: s.ip, port: s.port })),
    p2pKey: P2P_SERVER_KEY,
    p2pLinkKey,
    p2pKeyVersion: p2p.keyVersion || 101,
    p2pKeySaltIndex: 3,
    p2pKeySaltVer: 1,
    sessionToken: session.sessionId,
    userId: extractUserId(session.sessionId),
    clientId: 0x0aed13f5,
    channelNo: CHANNEL,
    streamType: 0, // main stream for playback
    streamTokens: tokenData.tokenArray || [],
    localPublicIp: publicIpHint,
    busType: 2, // PLAYBACK
    startTime,
    stopTime: stopTime!,
  })

  // --- Hik-RTP extractor + FFmpeg ---
  const extractor = new HikRtpExtractor()
  const outDir = '/tmp/playback-output'
  mkdirSync(outDir, { recursive: true })

  const h265Path = `${outDir}/playback.h265`
  const mp4Path = `${outDir}/playback.mp4`
  const nalChunks: Buffer[] = []
  let nalBytes = 0
  let nalCount = 0

  extractor.on('nalUnit', (nal: Buffer) => {
    nalChunks.push(nal)
    nalBytes += nal.length
    nalCount++
  })

  p2pSession.on('data', (payload: Buffer) => {
    extractor.processPacket(payload)
  })

  p2pSession.on('stateChange', (s: { from: string; to: string }) => {
    console.log(`[State] ${s.from} → ${s.to}`)
  })
  p2pSession.on('punchComplete', () => console.log('[Punch] Hole-punch complete'))
  p2pSession.on('error', (err: Error) => console.log(`[Error] ${err.message}`))

  // --- Start ---
  console.log('\nStarting P2P playback session...')
  await p2pSession.start()
  console.log(`Capturing ${CAPTURE_DURATION_MS / 1000}s of playback data...\n`)

  // Status updates every 5s
  const statusInterval = setInterval(() => {
    console.log(`[Status] ${nalCount} NALs, ${(nalBytes / 1024).toFixed(0)}KB H.265 data`)
  }, 5000)

  // Wait for capture duration
  await new Promise(resolve => setTimeout(resolve, CAPTURE_DURATION_MS))

  // --- Stop ---
  clearInterval(statusInterval)
  extractor.flush()
  p2pSession.stop()

  console.log(`\n=== Capture Complete ===`)
  console.log(`NAL units: ${nalCount}`)
  console.log(`H.265 data: ${(nalBytes / 1024 / 1024).toFixed(2)}MB`)

  if (nalCount === 0) {
    console.error('\nNo video data received. Possible issues:')
    console.error('- Device may not have recordings for this time range')
    console.error('- P2P hole-punch may have failed (need public IP)')
    console.error('- NVR may be rate-limiting connections (wait 30s between attempts)')
    process.exit(1)
  }

  // --- Write H.265 ---
  const annexB = Buffer.concat(nalChunks)
  writeFileSync(h265Path, annexB)
  console.log(`\nWrote ${h265Path}`)

  // --- Convert to MP4 ---
  console.log('Converting to MP4...')
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-f', 'hevc', '-r', '25',
    '-i', h265Path,
    '-c:v', 'copy', '-movflags', '+faststart',
    mp4Path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let ffmpegOutput = ''
  ffmpeg.stderr?.on('data', (d: Buffer) => { ffmpegOutput += d.toString() })

  await new Promise<void>((resolve, reject) => {
    ffmpeg.on('exit', code => {
      if (code !== 0) return reject(new Error(`FFmpeg exited ${code}: ${ffmpegOutput}`))
      resolve()
    })
  })

  // Duration
  const durationMatch = ffmpegOutput.match(/time=(\d+:\d+:\d+\.\d+)/)
  console.log(`MP4: ${mp4Path}`)
  if (durationMatch) console.log(`Duration: ${durationMatch[1]}`)

  // Extract first + last frame
  const { execSync } = await import('child_process')
  try {
    execSync(`ffmpeg -y -f hevc -r 25 -i ${h265Path} -frames:v 1 -f image2 ${outDir}/first-frame.png 2>/dev/null`)
    execSync(`ffmpeg -y -sseof -2 -f hevc -r 25 -i ${h265Path} -frames:v 1 -f image2 ${outDir}/last-frame.png 2>/dev/null`)
    console.log(`\nFirst frame: ${outDir}/first-frame.png`)
    console.log(`Last frame:  ${outDir}/last-frame.png`)
    console.log('Check these frames to verify the playback timestamp matches the requested time range.')
  } catch {
    console.log('(frame extraction failed — check MP4 manually)')
  }

  // NAL type summary
  const nalTypes = new Map<number, number>()
  for (const nal of nalChunks) {
    if (nal.length < 5) continue
    const t = (nal[4] >> 1) & 0x3f
    nalTypes.set(t, (nalTypes.get(t) ?? 0) + 1)
  }
  const typeNames: Record<number, string> = {
    0: 'TRAIL_N', 1: 'TRAIL_R', 19: 'IDR_W_RADL', 20: 'IDR_N_LP',
    32: 'VPS', 33: 'SPS', 34: 'PPS',
  }
  console.log('\nNAL type breakdown:', Object.fromEntries(
    [...nalTypes.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => [`${t}(${typeNames[t] ?? '?'})`, c])
  ))

  process.exit(0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
