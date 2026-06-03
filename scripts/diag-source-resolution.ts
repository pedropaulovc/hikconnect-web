/**
 * Capture the RAW H.265 source (pre-FFmpeg) for a given streamType and report its
 * resolution via ffprobe. Distinguishes the SOURCE resolution from the HLS output,
 * which ffmpeg-pipe.ts deliberately downscales (main 4K→720p, sub→360p).
 *
 * Usage: npx tsx scripts/diag-source-resolution.ts <streamType> [holdSec]
 *   streamType 1 = main (HD/4K source), 2 = sub (SD source)
 */
import { readFileSync, createWriteStream } from 'fs'
import { execFileSync } from 'child_process'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (m) process.env[m[1]] = m[2]
}

import { HikConnectClient, extractUserId } from '../src/lib/hikconnect/client'
import { P2PSession } from '../src/lib/p2p/p2p-session'
import { HikRtpExtractor } from '../src/lib/p2p/hik-rtp'
import { randomClientId } from '../src/lib/p2p/client-id'

const DEVICE = process.env.HIKCONNECT_DEVICE_SERIAL || 'L38239367'
const STREAM_TYPE = parseInt(process.argv[2] ?? '1', 10)
const HOLD = parseInt(process.argv[3] ?? '12', 10)
const OUT = `/tmp/src-stream-${STREAM_TYPE}.h265`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })
  const p2p = await client.getP2PConfig(DEVICE)
  const p2pLinkKey = Buffer.from(p2p.secretKey.substring(0, 32), 'ascii')
  const secret = await client.getP2PSecret()

  const sess = new P2PSession({
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
    userId: extractUserId(session.sessionId),
    clientId: randomClientId(),
    channelNo: 1,
    streamType: STREAM_TYPE,
  })

  const orig = console.log
  console.log = () => {}

  const out = createWriteStream(OUT)
  const extractor = new HikRtpExtractor()
  extractor.on('nalUnit', (nal: Buffer) => out.write(nal))
  sess.on('data', (b: Buffer) => extractor.processPacket(b))

  try {
    await sess.start()
    await sleep(HOLD * 1000)
  } finally {
    console.log = orig
    await sess.stop()
    out.end()
  }
  await sleep(300)

  const probe = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,profile',
    '-of', 'default=noprint_wrappers=1',
    OUT,
  ]).toString().trim()

  console.log(`\n=== SOURCE H.265 resolution (streamType=${STREAM_TYPE}, pre-FFmpeg) ===`)
  console.log(`captured: ${OUT}`)
  console.log(probe)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
