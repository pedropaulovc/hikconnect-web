/**
 * Playback test v2: strip RTP headers → MPEG-PS stream → FFmpeg → MP4
 *
 * Playback data from Hikvision NVR uses MPEG Program Stream container
 * (recordings stored as .ps files), NOT raw H.265 NALs like live preview.
 *
 * Usage: npx tsx scripts/test-playback-ps.ts [startTime]
 * Works behind NAT — no public IP or VPS required.
 */
import { readFileSync, mkdirSync, writeFileSync, createWriteStream } from 'fs'

const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient, extractUserId } from '../src/lib/hikconnect/client'
import { P2PSession, P2P_SERVER_KEY } from '../src/lib/p2p/p2p-session'
import { spawn } from 'child_process'

const DEVICE_SERIAL = 'L38239367'
const CHANNEL = 1
const CAPTURE_DURATION_MS = 70_000

async function main() {
  console.log('=== Playback Stream Test (MPEG-PS) ===\n')

  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('Logged in:', session.apiDomain)

  // Parse start time — NVR expects device-local time, NOT UTC.
  // Pass the string literally without Date conversion to avoid timezone shift.
  const startTime = process.argv[2] || '2026-03-15T17:30:00'
  // Add 1 minute for stop time by simple string arithmetic
  const [datePart, timePart] = startTime.split('T')
  const [hh, mm, ss] = timePart.split(':').map(Number)
  const totalSec = hh * 3600 + (mm + 1) * 60 + ss
  const stopH = String(Math.floor(totalSec / 3600)).padStart(2, '0')
  const stopM = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')
  const stopS = String(totalSec % 60).padStart(2, '0')
  const stopTime = `${datePart}T${stopH}:${stopM}:${stopS}`
  console.log(`Playback range: ${startTime} → ${stopTime}\n`)

  // P2P config
  const p2p = await client.getP2PConfig(DEVICE_SERIAL)
  const p2pLinkKey = Buffer.from(p2p.secretKey.substring(0, 32), 'ascii')
  const tokenResp = await fetch(`https://${session.apiDomain}/api/user/token/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `sessionId=${encodeURIComponent(session.sessionId)}&clientType=55`,
  })
  const tokenData = await tokenResp.json() as { tokenArray?: string[] }

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
    streamType: 0,
    streamTokens: tokenData.tokenArray || [],
    localPublicIp: process.env.PUBLIC_IP, // optional — P2P server derives NAT address from UDP source
    busType: 2,
    startTime,
    stopTime,
  })

  const outDir = '/tmp/playback-output'
  mkdirSync(outDir, { recursive: true })
  const psPath = `${outDir}/playback.ps`
  const mp4Path = `${outDir}/playback.mp4`
  const psStream = createWriteStream(psPath)

  let totalBytes = 0
  let packetCount = 0
  let videoPackets = 0

  p2pSession.on('data', (payload: Buffer) => {
    packetCount++
    const type = payload.readUInt16BE(0)

    // 0x8050/0x8060/0x8051: video data — strip 12-byte Hik-RTP header
    if (type === 0x8050 || type === 0x8060 || type === 0x8051) {
      const inner = payload.subarray(12)
      psStream.write(inner)
      totalBytes += inner.length
      videoPackets++
      return
    }

    // 0x0200: IMKH header — log metadata
    if (type === 0x0200) {
      const imkhIdx = payload.indexOf('IMKH')
      if (imkhIdx >= 0) {
        const videoCodec = payload[imkhIdx + 8]
        const audioCodec = payload[imkhIdx + 9]
        const codecNames: Record<number, string> = { 0x04: 'H.264', 0x05: 'H.265' }
        console.log(`IMKH: videoCodec=${codecNames[videoCodec] ?? `0x${videoCodec.toString(16)}`} audioCodec=0x${audioCodec.toString(16)}`)
      }
      return
    }

    // 0x807f: control, ignore
  })

  p2pSession.on('stateChange', (s: { from: string; to: string }) => {
    console.log(`[State] ${s.from} → ${s.to}`)
  })
  p2pSession.on('punchComplete', () => console.log('[Punch] Complete'))
  p2pSession.on('error', (err: Error) => console.log(`[Error] ${err.message}`))

  console.log('Starting P2P playback...')
  await p2pSession.start()
  console.log(`Capturing ${CAPTURE_DURATION_MS / 1000}s...\n`)

  const statusInterval = setInterval(() => {
    console.log(`[Status] ${videoPackets} video pkts, ${(totalBytes / 1024 / 1024).toFixed(2)}MB PS data`)
  }, 5000)

  await new Promise(resolve => setTimeout(resolve, CAPTURE_DURATION_MS))

  clearInterval(statusInterval)
  p2pSession.stop()
  psStream.end()

  console.log(`\n=== Capture Complete ===`)
  console.log(`Total packets: ${packetCount}, video: ${videoPackets}`)
  console.log(`PS stream: ${(totalBytes / 1024 / 1024).toFixed(2)}MB → ${psPath}`)

  if (totalBytes === 0) {
    console.error('No video data received!')
    process.exit(1)
  }

  // Convert PS → MP4 with FFmpeg
  console.log('\nConverting MPEG-PS → MP4...')
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'mpeg',       // MPEG-PS input
    '-i', psPath,
    '-c:v', 'copy',     // copy H.265 without re-encode
    '-an',               // skip audio for now
    '-movflags', '+faststart',
    mp4Path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let ffmpegOut = ''
  ffmpeg.stderr?.on('data', (d: Buffer) => { ffmpegOut += d.toString() })

  const ffmpegCode = await new Promise<number>((resolve) => {
    ffmpeg.on('exit', code => resolve(code ?? 1))
  })

  if (ffmpegCode !== 0) {
    console.error('FFmpeg failed. Trying as raw input...')
    // Fallback: let FFmpeg auto-detect
    const ff2 = spawn('ffmpeg', [
      '-y', '-i', psPath, '-c:v', 'copy', '-an',
      '-movflags', '+faststart', mp4Path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let ff2Out = ''
    ff2.stderr?.on('data', (d: Buffer) => { ff2Out += d.toString() })
    const code2 = await new Promise<number>(r => ff2.on('exit', c => r(c ?? 1)))
    if (code2 !== 0) {
      console.error('FFmpeg auto-detect also failed:')
      console.error(ff2Out.split('\n').filter(l => l.includes('Error') || l.includes('Invalid')).join('\n'))

      // Last resort: try as raw mpegvideo
      console.log('\nTrying as raw MPEG video...')
      const { execSync } = await import('child_process')
      try {
        execSync(`ffprobe -v error -show_streams ${psPath} 2>&1 | head -20`, { stdio: 'inherit' })
      } catch {}
      try {
        const probe = execSync(`ffprobe -v quiet -show_format -print_format json ${psPath} 2>/dev/null`).toString()
        console.log('Probe:', probe)
      } catch {}
    } else {
      ffmpegOut = ff2Out
    }
  }

  // Check output
  const streamLine = ffmpegOut.split('\n').find(l => l.includes('Video:'))
  if (streamLine) console.log('\nCodec:', streamLine.trim())

  const timeLine = ffmpegOut.match(/time=(\d+:\d+:\d+\.\d+)/)
  if (timeLine) console.log(`Duration: ${timeLine[1]}`)
  console.log(`MP4: ${mp4Path}`)

  // Extract frames for verification
  const { execSync } = await import('child_process')
  try {
    execSync(`ffmpeg -y -i ${mp4Path} -frames:v 1 ${outDir}/first-frame.png 2>/dev/null`)
    execSync(`ffmpeg -y -sseof -2 -i ${mp4Path} -frames:v 1 ${outDir}/last-frame.png 2>/dev/null`)
    console.log(`\nFirst frame: ${outDir}/first-frame.png`)
    console.log(`Last frame:  ${outDir}/last-frame.png`)
  } catch {
    // Try extracting from PS directly
    try {
      execSync(`ffmpeg -y -f mpeg -i ${psPath} -frames:v 1 ${outDir}/first-frame.png 2>/dev/null`)
      console.log(`First frame: ${outDir}/first-frame.png`)
    } catch {
      console.log('Frame extraction failed')
    }
  }

  process.exit(0)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
