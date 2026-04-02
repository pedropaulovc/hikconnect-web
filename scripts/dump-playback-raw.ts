/**
 * Dump raw playback packets for protocol analysis.
 * Captures 10s of busType=2 data, prints first 10 packet headers.
 *
 * Usage: npx tsx scripts/dump-playback-raw.ts
 */
import { readFileSync, writeFileSync } from 'fs'

const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (m) process.env[m[1]] = m[2]
}

import { HikConnectClient, extractUserId } from '../src/lib/hikconnect/client'
import { P2PSession, P2P_SERVER_KEY } from '../src/lib/p2p/p2p-session'

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })

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
    userId: extractUserId(session.sessionId),
    clientId: 0x0aed13f5,
    channelNo: 1,
    streamType: 0,
    streamTokens: tokenData.tokenArray || [],
    localPublicIp: process.env.PUBLIC_IP,
    busType: 2,
    startTime: '2026-03-15T17:30:00',
    stopTime: '2026-03-15T17:31:00',
  })

  const packets: Buffer[] = []
  p2pSession.on('data', (payload: Buffer) => {
    packets.push(Buffer.from(payload))
    if (packets.length <= 15) {
      const type = payload.readUInt16BE(0)
      console.log(`PKT#${packets.length} type=0x${type.toString(16).padStart(4, '0')} len=${payload.length}`)
      console.log(`  hex[0:64]: ${payload.subarray(0, Math.min(64, payload.length)).toString('hex')}`)

      // Check for IMKH anywhere in payload
      const imkhIdx = payload.indexOf('IMKH')
      if (imkhIdx >= 0) {
        console.log(`  ** IMKH magic at offset ${imkhIdx}`)
        console.log(`  IMKH header: ${payload.subarray(imkhIdx, imkhIdx + 16).toString('hex')}`)
      }

      // After stripping 12-byte Hik-RTP header, show what's left
      if (type === 0x8050 || type === 0x8060 || type === 0x8051) {
        const inner = payload.subarray(12)
        console.log(`  after RTP hdr: ${inner.subarray(0, Math.min(32, inner.length)).toString('hex')}`)
        if (inner[0] === 0x0d) {
          console.log(`  sub-header present, after sub-hdr: ${inner.subarray(13, Math.min(45, inner.length)).toString('hex')}`)
        }
      }
    }
  })

  p2pSession.on('stateChange', (s: { from: string; to: string }) => {
    console.log(`[State] ${s.from} → ${s.to}`)
  })

  await p2pSession.start()
  console.log('Capturing 10s of playback data...')
  await new Promise(r => setTimeout(r, 10000))
  p2pSession.stop()

  // Save raw packets
  const chunks: Buffer[] = []
  for (const p of packets.slice(0, 100)) {
    const hdr = Buffer.alloc(4)
    hdr.writeUInt32BE(p.length)
    chunks.push(hdr, p)
  }
  writeFileSync('/tmp/playback-raw.bin', Buffer.concat(chunks))
  console.log(`\nSaved ${Math.min(100, packets.length)} of ${packets.length} packets`)

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
