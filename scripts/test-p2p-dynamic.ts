/**
 * P2P test with dynamically-built request body.
 * Uses P2PLinkKey (API secret key) for inner PLAY_REQUEST encryption.
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'
import { P2PSession } from '../src/lib/p2p/p2p-session'

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
  console.log('Starting P2P test...')
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  console.log('Logging in...')
  const session = await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })
  console.log('Logged in, domain:', session.apiDomain)

  const p2p = await client.getP2PConfig('L38239367')
  console.log('P2P config:', JSON.stringify({
    servers: p2p.servers.length,
    secretKey: p2p.secretKey.substring(0, 20) + '...',
    keyVersion: p2p.keyVersion,
    netIp: p2p.connection.netIp,
    netStreamPort: p2p.connection.netStreamPort,
  }))

  // P2PLinkKey = first 32 chars of API secretKey as ASCII bytes
  const p2pLinkKey = Buffer.from(p2p.secretKey.substring(0, 32), 'ascii')
  console.log('P2PLinkKey (32 ASCII chars):', p2pLinkKey.toString('ascii'))
  console.log('P2PLinkKey length:', p2pLinkKey.length)

  // Fetch stream tokens
  const tokenResp = await fetch(`https://${session.apiDomain}/api/user/token/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `sessionId=${encodeURIComponent(session.sessionId)}&clientType=55`,
  })
  const tokenData = await tokenResp.json() as { tokenArray?: string[] }
  const tokens = tokenData.tokenArray || []
  console.log(`Got ${tokens.length} stream tokens`)

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
    clientId: 0x0aed13f5,  // From capture — may need to fetch from API
    channelNo: 1,
    streamType: 1,
    streamTokens: tokens,
    // Auto-detect public IP or use env var
    localPublicIp: process.env.PUBLIC_IP || await getPublicIp(),
  })

  console.log('Local public IP:', p2pSession['config'].localPublicIp)

  let dataCount = 0
  let totalDataBytes = 0
  const fs = await import('fs')
  const captureDir = '/tmp/p2p-capture'
  fs.mkdirSync(captureDir, { recursive: true })

  p2pSession.on('data', (payload: Buffer) => {
    dataCount++
    totalDataBytes += payload.length
    if (dataCount <= 20 || dataCount % 200 === 0) {
      console.log(`[DATA] #${dataCount} ${payload.length}B total=${totalDataBytes}B type=0x${payload.readUInt16BE(0).toString(16)} first32=${payload.subarray(0, Math.min(32, payload.length)).toString('hex')}`)
    }
    // Save first 50 packets for analysis
    if (dataCount <= 50) {
      fs.writeFileSync(`${captureDir}/pkt-${String(dataCount).padStart(4, '0')}.bin`, payload)
    }
  })
  p2pSession.on('v3message', (msg: { msgType: number; seqNum: number; reserved: number; mask: { encrypt: boolean }; attributes: { tag: number; value: Buffer }[] }) => {
    console.log(`[V3] cmd=0x${msg.msgType.toString(16)} seq=${msg.seqNum} reserved=0x${msg.reserved.toString(16)} encrypt=${msg.mask.encrypt} attrs=${msg.attributes.length}`)
    for (const a of msg.attributes) {
      const valHex = a.value.toString('hex').substring(0, 60)
      const valAscii = a.value.toString('ascii').substring(0, 40).replace(/[^\x20-\x7e]/g, '.')
      console.log(`  tag=0x${a.tag.toString(16)} len=${a.value.length} hex=${valHex} ascii=${valAscii}`)
    }
  })
  p2pSession.on('error', (err: Error) => console.log(`[ERR] ${err.message}`))
  p2pSession.on('stateChange', (s: { from: string; to: string }) => console.log(`[STATE] ${s.from} -> ${s.to}`))
  p2pSession.on('dataSessionEstablished', (id: number) => console.log(`[DATA-SESSION] 0x${id.toString(16)}`))
  p2pSession.on('punchComplete', () => console.log(`[PUNCH] Hole-punch complete!`))

  await p2pSession.start()
  console.log('Waiting 60s...')
  await new Promise(resolve => setTimeout(resolve, 60000))
  p2pSession.stop()
}
main().catch(console.error)
