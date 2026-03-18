/**
 * End-to-end test: P2P → Hik-RTP extract → FFmpeg → HLS files
 *
 * Usage: PUBLIC_IP=x.x.x.x npx tsx scripts/test-p2p-to-ffmpeg.ts
 */
import { readFileSync, mkdirSync, existsSync, createWriteStream } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'
import { P2PSession } from '../src/lib/p2p/p2p-session'
import { HikRtpExtractor } from '../src/lib/p2p/hik-rtp'
import { spawn } from 'child_process'

const P2P_SERVER_KEY = Buffer.from('e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5', 'hex')

async function getPublicIp(): Promise<string> {
  try {
    const resp = await fetch('https://api.ipify.org?format=json')
    const data = await resp.json() as { ip: string }
    return data.ip
  } catch {
    return '0.0.0.0'
  }
}

async function main() {
  console.log('=== P2P → FFmpeg HLS Pipeline Test ===\n')

  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })
  console.log('Logged in:', session.apiDomain)

  const p2p = await client.getP2PConfig('L38239367')
  const p2pLinkKey = Buffer.from(p2p.secretKey.substring(0, 32), 'ascii')

  const tokenResp = await fetch(`https://${session.apiDomain}/api/user/token/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `sessionId=${encodeURIComponent(session.sessionId)}&clientType=55`,
  })
  const tokenData = await tokenResp.json() as { tokenArray?: string[] }

  const p2pSession = new P2PSession({
    deviceSerial: 'L38239367',
    devicePublicIp: p2p.connection.netIp || p2p.connection.wanIp,
    devicePublicPort: p2p.connection.netStreamPort || 9020,
    p2pServers: p2p.servers.map(s => ({ host: s.ip, port: s.port })),
    p2pKey: P2P_SERVER_KEY,
    p2pLinkKey,
    p2pKeyVersion: p2p.keyVersion || 101,
    p2pKeySaltIndex: 3,
    p2pKeySaltVer: 1,
    sessionToken: session.sessionId,
    userId: 'fcfaec90a55f4a61b4e7211152a2d805',
    clientId: 0x0aed13f5,
    channelNo: 1,
    streamType: 1,
    streamTokens: tokenData.tokenArray || [],
    localPublicIp: process.env.PUBLIC_IP || await getPublicIp(),
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
