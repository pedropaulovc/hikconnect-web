/**
 * Single-run SRT timeline tracer.
 *
 * Phase-1 evidence gathering for the intermittent "3-5 packets then silence" stall.
 * Captures the FULL ordered SRT event sequence for ONE attempt:
 *   - every 0x8000 handshake (induction hsType=1 / conclusion 0xFFFFFFFF) with its socketId+cookie
 *   - our induction/conclusion responses (target peerSocket)
 *   - every SRT ACK we emit (target peerSocket + dataCount at the time)
 *   - data packet arrivals (seq, dst socket id, relative ms)
 *   - ANY device packet that arrives AFTER the last data packet (NAK / new induction / keepalive)
 *
 * Then prints: the set of distinct handshake socket ids, the FINAL ack target,
 * whether the run stalled (<=5 pkts) or streamed, and the post-stall tail.
 *
 * Usage: npx tsx scripts/diag-srt-trace.ts [holdSec]
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
const HOLD = parseInt(process.argv[2] ?? '14', 10)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Ev = { t: number; kind: string; detail: string }

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
    streamType: 1,
  })

  const t0 = Date.now()
  const evs: Ev[] = []
  let dataPkts = 0
  let bytes = 0
  let lastDataT = 0
  const push = (kind: string, detail: string) => evs.push({ t: Date.now() - t0, kind, detail })

  sess.on('data', (b: Buffer) => { dataPkts++; bytes += b.length; lastDataT = Date.now() - t0 })

  // Intercept the session's own console.log timeline.
  const orig = console.log
  console.log = (...args: unknown[]) => {
    const s = args.map(String).join(' ')
    // Classify incoming 0x8000 handshakes (the session logs them verbatim).
    if (s.startsWith('[SRT] Handshake:')) {
      const type = s.match(/type=(\d+)/)?.[1]
      const sock = s.match(/socketId=(0x[0-9a-f]+)/)?.[1]
      const cookie = s.match(/cookie=(0x[0-9a-f]+)/)?.[1]
      const kind = type === '1' ? 'HS-INDUCTION' : type === '4294967295' ? 'HS-CONCLUSION' : `HS-type${type}`
      push(kind, `socket=${sock} cookie=${cookie}`)
    } else if (s.startsWith('[SRT] Sent induction response')) {
      push('TX-induction-resp', s.match(/peerSocket=(0x[0-9a-f]+)/)?.[1] ?? s)
    } else if (s.startsWith('[SRT] CONCLUSION received')) {
      push('RX-conclusion', s.match(/peerSocket=(0x[0-9a-f]+)/)?.[1] ?? s)
    } else if (s.startsWith('[SRT] Sent conclusion response')) {
      push('TX-conclusion-resp', '')
    } else if (s.startsWith('[SRT-ACK]')) {
      push('TX-ack', s.replace('[SRT-ACK]', '').trim())
    } else if (s.startsWith('[SRT-DATA]')) {
      push('RX-data', s.replace('[SRT-DATA]', '').trim())
    }
    // swallow everything else (per-packet noise)
  }

  try {
    await sess.start()
    await sleep(HOLD * 1000)
  } finally {
    console.log = orig
    await sess.stop()
  }

  // Final ACK target the session settled on.
  const finalPeerSocket = (sess as unknown as { srtPeerSocketId: number | null }).srtPeerSocketId
  const ourSourceId = (sess as unknown as { sourceId: number }).sourceId

  console.log('\n=== SRT TIMELINE ===')
  for (const e of evs) console.log(`+${String(e.t).padStart(5)}ms  ${e.kind.padEnd(18)} ${e.detail}`)

  const induSockets = [...new Set(evs.filter(e => e.kind === 'HS-INDUCTION').map(e => e.detail.match(/socket=(0x[0-9a-f]+)/)?.[1]))]
  const conclSockets = [...new Set(evs.filter(e => e.kind === 'RX-conclusion').map(e => e.detail))]
  const ackTargets = [...new Set(evs.filter(e => e.kind === 'TX-ack').map(e => e.detail.match(/peerSocket=(0x[0-9a-f]+)/)?.[1]))]

  console.log('\n=== SUMMARY ===')
  console.log(`our sourceId        : 0x${(ourSourceId >>> 0).toString(16)}`)
  console.log(`distinct INDUCTION socketIds : ${induSockets.join(', ') || '(none)'}`)
  console.log(`distinct CONCLUSION socketIds: ${conclSockets.join(', ') || '(none)'}`)
  console.log(`ACK target socketIds (in use): ${ackTargets.join(', ') || '(none)'}`)
  console.log(`final srtPeerSocketId        : 0x${((finalPeerSocket ?? 0) >>> 0).toString(16)}`)
  console.log(`data packets: ${dataPkts}  bytes: ${(bytes / 1024).toFixed(1)}KB  lastData@${lastDataT}ms`)

  // Tail: anything the device sent AFTER the last data packet (within the hold window)?
  const tail = evs.filter(e => e.t > lastDataT && lastDataT > 0)
  const verdict = bytes > 50 * 1024 ? 'STREAMED' : 'STALLED'
  console.log(`\nVERDICT: ${verdict}`)
  if (verdict === 'STALLED') {
    console.log(`Events AFTER last data packet (@${lastDataT}ms): ${tail.length}`)
    for (const e of tail.slice(0, 20)) console.log(`  +${e.t}ms ${e.kind} ${e.detail}`)
    console.log('Q: did the device keep handshaking/NAKing after stall, or go fully silent?')
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
