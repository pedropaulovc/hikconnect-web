/**
 * Pinpoint WHERE intermittent stream starts fail.
 *
 * Runs N attempts (configurable cooldown). For each, tracks how far the pipeline
 * gets: P2P_SETUP → punch → PLAY sent → SRT induction (device→us) → conclusion →
 * first SRT data. A failing run that reaches PLAY but no data tells us whether the
 * device never sends the SRT induction (device-side slot busy) or sends it but no
 * video follows (our handshake / something else).
 *
 * Captures the session's own [SRT]/[P2P] console.log lines via a temporary wrapper.
 *
 * Usage: npx tsx scripts/diag-srt.ts [attempts] [cooldownSec]
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
const ATTEMPTS = parseInt(process.argv[2] ?? '6', 10)
const COOLDOWN = parseInt(process.argv[3] ?? '0', 10)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Stage = {
  n: number; setupOk: boolean; punchOk: boolean; playSent: boolean
  srtInductionRx: number; srtConclusionSent: boolean; dataPkts: number; bytesKB: number; firstDataMs: number | null
}

async function runOnce(client: HikConnectClient, sessionId: string, n: number): Promise<Stage> {
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
    sessionToken: sessionId,
    userId: extractUserId(sessionId),
    clientId: randomClientId(),
    channelNo: 1,
    streamType: 1,
  })

  const st: Stage = { n, setupOk: false, punchOk: false, playSent: false, srtInductionRx: 0, srtConclusionSent: false, dataPkts: 0, bytesKB: 0, firstDataMs: null }
  const t0 = Date.now()
  let bytes = 0
  sess.on('data', (b: Buffer) => { bytes += b.length; st.dataPkts++; if (st.firstDataMs === null) st.firstDataMs = Date.now() - t0 })
  sess.on('punchComplete', () => { st.punchOk = true })

  // Intercept the session's console.log lines to track SRT stage progress.
  const orig = console.log
  console.log = (...args: unknown[]) => {
    const s = args.map(String).join(' ')
    if (s.includes('Device stream port from P2P_SETUP')) st.setupOk = true
    if (s.includes('[SRT] Handshake')) st.srtInductionRx++
    if (s.includes('[SRT] Sent conclusion')) st.srtConclusionSent = true
    if (s.includes('PLAY_REQUEST sent directly')) st.playSent = true
    // swallow the noisy per-packet lines, keep SRT lines for context
    if (s.startsWith('[SRT]')) orig(`  a${n}> ${s}`)
  }
  try {
    await sess.start()
    await sleep(14000)
  } finally {
    sess.stop()
    console.log = orig
  }
  st.bytesKB = Math.round(bytes / 1024)
  return st
}

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })

  const rows: Stage[] = []
  for (let i = 1; i <= ATTEMPTS; i++) {
    process.stdout.write(`\n[attempt ${i}/${ATTEMPTS}] (cooldown ${COOLDOWN}s before)`)
    if (i > 1 && COOLDOWN > 0) await sleep(COOLDOWN * 1000)
    try {
      const st = await runOnce(client, session.sessionId, i)
      rows.push(st)
      process.stdout.write(` → setup=${st.setupOk} punch=${st.punchOk} play=${st.playSent} srtInd=${st.srtInductionRx} concl=${st.srtConclusionSent} data=${st.dataPkts} (${st.bytesKB}KB, first@${st.firstDataMs}ms)`)
    } catch (e) {
      process.stdout.write(` ERROR ${(e as Error).message}`)
    }
  }

  console.log('\n\n=== STAGE TABLE ===')
  console.log('n  setup punch play srtInd concl data   bytesKB firstMs')
  for (const r of rows) {
    console.log(`${r.n}  ${b(r.setupOk)}   ${b(r.punchOk)}   ${b(r.playSent)}  ${String(r.srtInductionRx).padEnd(5)} ${b(r.srtConclusionSent)}    ${String(r.dataPkts).padEnd(5)}  ${String(r.bytesKB).padEnd(6)}  ${r.firstDataMs ?? '-'}`)
  }
  const ok = rows.filter(r => r.bytesKB > 50)
  const fail = rows.filter(r => r.bytesKB <= 50)
  console.log(`\n${ok.length}/${rows.length} streamed.`)
  if (fail.length) {
    console.log(`Failures reached: srtInductionRx>0 in ${fail.filter(f => f.srtInductionRx > 0).length}/${fail.length}, conclusionSent in ${fail.filter(f => f.srtConclusionSent).length}/${fail.length}`)
    console.log('=> If failures have srtInd=0, the DEVICE never starts SRT (slot busy). If srtInd>0 but no data, the handshake/our side is the issue.')
  }
  process.exit(0)
}
function b(v: boolean) { return v ? 'Y' : '.' }
main().catch(e => { console.error(e); process.exit(1) })
