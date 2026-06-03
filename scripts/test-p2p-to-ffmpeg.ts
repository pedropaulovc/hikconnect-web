/**
 * End-to-end test: P2P → Hik-RTP extract → FFmpeg → HLS files
 *
 * Usage: npx tsx scripts/test-p2p-to-ffmpeg.ts
 * Optional: PUBLIC_IP=x.x.x.x to provide a hint (not required — works behind NAT)
 */
import { readFileSync, mkdirSync, existsSync, createWriteStream } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient, extractUserId } from '../src/lib/hikconnect/client'
import { P2PSession } from '../src/lib/p2p/p2p-session'
import { randomClientId } from '../src/lib/p2p/client-id'
import { HikRtpExtractor } from '../src/lib/p2p/hik-rtp'
import { spawn } from 'child_process'

const DEVICE = process.env.HIKCONNECT_DEVICE_SERIAL || 'L38239367'

/** Optional public IP hint — P2P server derives NAT address from UDP source regardless. */
function getPublicIpHint(): string | undefined {
  return process.env.PUBLIC_IP
}

async function main() {
  console.log('=== P2P → FFmpeg HLS Pipeline Test ===\n')

  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })
  console.log('Logged in:', session.apiDomain)

  const p2p = await client.getP2PConfig(DEVICE)
  const p2pLinkKey = Buffer.from(p2p.secretKey.substring(0, 32), 'ascii')

  // Fresh, account-level P2P server key + salt (rotates server-side — never hardcode).
  const secret = await client.getP2PSecret()
  console.log('P2P key:', secret.key.toString('hex'), 'saltIndex', secret.saltIndex, 'ver', secret.saltVer)

  const userId = extractUserId(session.sessionId)
  console.log('userId:', userId)

  const p2pSession = new P2PSession({
    deviceSerial: DEVICE,
    devicePublicIp: p2p.connection.netIp || p2p.connection.wanIp,
    devicePublicPort: p2p.connection.netStreamPort,
    p2pServers: secret.servers.map(s => ({ host: s.ip, port: s.port })),
    p2pKey: secret.key,
    p2pLinkKey,
    p2pKeyVersion: p2p.keyVersion,
    p2pKeySaltIndex: secret.saltIndex,
    p2pKeySaltVer: secret.saltVer,
    sessionToken: session.sessionId,
    userId,
    clientId: randomClientId(),
    channelNo: 1,
    streamType: 1,
    localPublicIp: getPublicIpHint(),
  })

  // Hik-RTP extractor: strips headers, emits H.265 NALs
  const extractor = new HikRtpExtractor()

  // HLS output directory
  const hlsDir = '/tmp/hls-output'
  mkdirSync(hlsDir, { recursive: true })

  // Raw SRT packet dump for debugging
  const rawDump = createWriteStream('/tmp/raw-srt-packets.bin')

  // Start FFmpeg: input raw H.265 via stdin → HLS output
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'hevc',
    '-i', 'pipe:0',
    '-c:v', 'copy',    // Don't re-encode, just remux
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '0',  // keep ALL segments
    `${hlsDir}/stream.m3u8`,
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) console.log(`[FFmpeg] ${line}`)
  })

  ffmpeg.on('exit', (code) => console.log(`[FFmpeg] exited with code ${code}`))

  let nalBytes = 0
  extractor.on('nalUnit', (nal: Buffer) => {
    nalBytes += nal.length
    // Write to FFmpeg stdin
    if (ffmpeg.stdin?.writable) {
      ffmpeg.stdin.write(nal)
    }
  })

  // Wire P2P data → extractor (with raw dump for debugging)
  p2pSession.on('data', (payload: Buffer) => {
    // Write length-prefixed raw packet for later analysis
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(payload.length, 0)
    rawDump.write(lenBuf)
    rawDump.write(payload)
    extractor.processPacket(payload)
  })

  p2pSession.on('stateChange', (s: { from: string; to: string }) => {
    console.log(`[State] ${s.from} → ${s.to}`)
  })
  p2pSession.on('punchComplete', () => console.log('[Punch] Complete!'))
  p2pSession.on('error', (err: Error) => console.log(`[Error] ${err.message}`))

  // Start P2P session
  await p2pSession.start()
  console.log(`\nStreaming for 30 seconds...`)

  // Status updates
  const statusInterval = setInterval(() => {
    console.log(`[Status] NAL data: ${(nalBytes / 1024).toFixed(0)}KB`)
    // Check for HLS files
    if (existsSync(`${hlsDir}/stream.m3u8`)) {
      console.log(`[HLS] Playlist exists at ${hlsDir}/stream.m3u8`)
    }
  }, 5000)

  await new Promise(resolve => setTimeout(resolve, 30000))

  clearInterval(statusInterval)
  extractor.flush() // flush any remaining type-49 fragments
  rawDump.end()
  ffmpeg.stdin?.end()
  p2pSession.stop()

  console.log(`\nFinal: ${(nalBytes / 1024).toFixed(0)}KB of H.265 data piped to FFmpeg`)
  console.log(`HLS files:`)
  const { execSync } = await import('child_process')
  try {
    console.log(execSync(`ls -la ${hlsDir}/`).toString())
  } catch {}

  process.exit(0)
}

main().catch(console.error)
