/**
 * Stream reliability + clientId diagnostic.
 *
 * Runs N attempts. Each: fresh getP2PSecret() → new P2PSession → stream ~15s →
 * record (saltIndex, clientId, bytes, gotPlayAck, devPkts) → stop → cooldown.
 * Alternates clientId between a fixed known-good value and a random one to test
 * whether clientId is validated server-side (controlling for intermittency).
 *
 * Usage: npx tsx scripts/diag-stream-reliability.ts [attempts] [cooldownSec]
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (m) process.env[m[1]] = m[2]
}

import { HikConnectClient, extractUserId } from '../src/lib/hikconnect/client'
import { P2PSession } from '../src/lib/p2p/p2p-session'

const DEVICE = process.env.HIKCONNECT_DEVICE_SERIAL || 'L38239367'
const ATTEMPTS = parseInt(process.argv[2] ?? '6', 10)
const COOLDOWN = parseInt(process.argv[3] ?? '45', 10)
const KNOWN_GOOD_CLIENT_ID = 0x0aed13f5

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Attempt = { n: number; clientId: string; saltIndex: number; bytes: number; playAck: boolean; devPkts: number; stream: boolean }

async function runOnce(client: HikConnectClient, sessionId: string, n: number, clientId: number): Promise<Attempt> {
  const p2p = await client.getP2PConfig(DEVICE)
  const p2pLinkKey = Buffer.from(p2p.secretKey.substring(0, 32), 'ascii')
  const secret = await client.getP2PSecret()
  const userId = extractUserId(sessionId)

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
    userId,
    clientId,
    channelNo: 1,
    streamType: 1,
  })

  let bytes = 0
  let devPkts = 0
  let playAck = false
  let stream = false
  sess.on('data', (b: Buffer) => { bytes += b.length; devPkts++ })
  sess.on('stateChange', (s: { from: string; to: string }) => { if (s.to === 'streaming') stream = true })
  // 0xb05 SUCCESS is logged inside the session; approximate playAck via reaching streaming state.

  await sess.start()
  await sleep(15000)
  if (stream) playAck = true
  sess.stop()

  return { n, clientId: '0x' + clientId.toString(16), saltIndex: secret.saltIndex, bytes: Math.round(bytes / 1024), playAck, devPkts, stream }
}

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })

  const results: Attempt[] = []
  for (let i = 1; i <= ATTEMPTS; i++) {
    // alternate: odd = known-good, even = random
    const clientId = i % 2 === 1 ? KNOWN_GOOD_CLIENT_ID : (0x40000000 + i * 0x111111)
    process.stdout.write(`\n[attempt ${i}/${ATTEMPTS}] clientId=0x${clientId.toString(16)} ... `)
    try {
      const r = await runOnce(client, session.sessionId, i, clientId)
      results.push(r)
      process.stdout.write(`salt=${r.saltIndex} bytes=${r.bytes}KB stream=${r.stream} pkts=${r.devPkts}`)
    } catch (e) {
      process.stdout.write(`ERROR ${(e as Error).message}`)
    }
    if (i < ATTEMPTS) await sleep(COOLDOWN * 1000)
  }

  console.log('\n\n=== SUMMARY ===')
  console.log('n  clientId      salt  bytesKB  stream  pkts')
  for (const r of results) {
    console.log(`${r.n}  ${r.clientId.padEnd(12)}  ${String(r.saltIndex).padEnd(4)}  ${String(r.bytes).padEnd(7)}  ${String(r.stream).padEnd(6)}  ${r.devPkts}`)
  }
  const good = results.filter(r => r.clientId === '0x' + KNOWN_GOOD_CLIENT_ID.toString(16))
  const rand = results.filter(r => r.clientId !== '0x' + KNOWN_GOOD_CLIENT_ID.toString(16))
  const ok = (a: Attempt[]) => a.filter(r => r.bytes > 50).length
  console.log(`\nknown-good clientId: ${ok(good)}/${good.length} streamed`)
  console.log(`random clientId    : ${ok(rand)}/${rand.length} streamed`)
  console.log('=> if random ever streams, clientId is NOT validated (can be arbitrary/random).')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
