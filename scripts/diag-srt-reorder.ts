/**
 * Per-packet SRT/Hik-RTP reordering + loss detector.
 *
 * Root-cause evidence for the intermittent "frame decodes top-left CTUs then goes
 * gray" corruption seen in the live UI. The SRT receiver (handleSrtDataPacket) and
 * the FU reassembler (HikRtpExtractor) both process payloads in ARRIVAL order with
 * no reorder buffer. If UDP delivers video packets out of order, fragmented NALs
 * reassemble with bytes in the wrong order → corrupt slice → gray frame until the
 * next IDR.
 *
 * This measures, in arrival order, the Hik-RTP sequence number (payload bytes 2-3)
 * of every video packet and classifies each step:
 *   - in-order  (seq == prev+1)
 *   - forward gap (seq > prev+1)  — packet(s) not yet arrived (loss OR pending reorder)
 *   - BACKWARD  (seq <= prev)     — a late/out-of-order packet => definitive reordering
 *
 * Usage: npx tsx scripts/diag-srt-reorder.ts [holdSec]
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (m) process.env[m[1]] = m[2]
}

import { HikConnectClient, extractUserId } from '../src/lib/hikconnect/client'
import { P2PSession } from '../src/lib/p2p/p2p-session'
import { randomClientId } from '../src/lib/p2p/client-id'

const DEVICE = process.env.HIKCONNECT_DEVICE_SERIAL || 'L38239367'
const HOLD = parseInt(process.argv[2] ?? '20', 10)
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
    streamType: 1, // main
  })

  // silence the session's per-packet console noise
  const orig = console.log
  console.log = () => {}

  let total = 0
  let video = 0
  const typeHist: Record<string, number> = {}

  sess.on('data', (b: Buffer) => {
    total++
    if (b.length < 4) return
    const type = b.readUInt16BE(0)
    const tk = '0x' + type.toString(16)
    typeHist[tk] = (typeHist[tk] ?? 0) + 1
    if (type === 0x8050 || type === 0x8051 || type === 0x8060) video++
  })

  try {
    await sess.start()
    await sleep(HOLD * 1000)
  } finally {
    console.log = orig
    await sess.stop()
  }

  // The SRT sequence reorder/loss counters live inside the session (the 'data'
  // event does not expose the SRT seq; Hik-RTP bytes 2-3 are always 0).
  const s = sess as unknown as {
    srtDataCount: number
    srtReorderEvents: number
    srtGapEvents: number
    srtMaxBackward: number
  }

  console.log('\n=== SRT ARRIVAL-ORDER ANALYSIS (video sub-session) ===')
  console.log(`hold: ${HOLD}s   total 'data' payloads: ${total}   video packets: ${video}`)
  console.log(`payload type histogram: ${JSON.stringify(typeHist)}`)
  console.log('')
  console.log(`SRT data packets       : ${s.srtDataCount}`)
  console.log(`forward-gap events     : ${s.srtGapEvents}   (seq jumped ahead — pkt missing at that moment)`)
  console.log(`BACKWARD (reorder)     : ${s.srtReorderEvents}   (max backward jump: ${s.srtMaxBackward})`)
  const denom = Math.max(1, s.srtDataCount - 1)
  console.log(`reorder rate           : ${(s.srtReorderEvents / denom * 100).toFixed(3)}% of SRT data packets arrived out of order`)
  console.log('')
  console.log('INTERPRETATION:')
  console.log('  BACKWARD > 0  => UDP delivers SRT data out of order; with no reorder buffer it')
  console.log('                  reaches FU reassembly in arrival order => corrupt NAL => gray frame.')
  console.log('  forward-gap that is NEVER matched by a later backward arrival => genuine loss.')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
