import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'
import { P2PSession } from '../src/lib/p2p/p2p-session'

const P2P_SERVER_KEY = Buffer.from('e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5', 'hex')

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })
  console.log('Logged in')

  const p2p = await client.getP2PConfig('L38239367')

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
    p2pKeySaltIndex: 3,
    p2pKeySaltVer: 1,
    sessionToken: session.sessionId,
    userId: 'fcfaec90a55f4a61b4e7211152a2d805',
    channelNo: 1,
    streamType: 1,
    streamTokens: tokens,
  })

  p2pSession.on('data', (payload: Buffer) => {
    console.log(`[DATA] ${payload.length}B first: ${payload.subarray(0, 16).toString('hex')}`)
  })
  p2pSession.on('v3message', (msg: { msgType: number; attributes: { tag: number; value: Buffer }[] }) => {
    console.log(`[V3] cmd=0x${msg.msgType.toString(16)} attrs=${msg.attributes.length}`)
    for (const a of msg.attributes) {
      console.log(`  tag=0x${a.tag.toString(16)} len=${a.value.length} val=${a.value.toString('hex').substring(0, 40)}`)
    }
  })
  p2pSession.on('error', (err: Error) => console.log(`[ERR] ${err.message}`))
  p2pSession.on('stateChange', (s: { from: string; to: string }) => console.log(`[STATE] ${s.from} -> ${s.to}`))

  await p2pSession.start()
  console.log('Waiting 30s...')
  await new Promise(resolve => setTimeout(resolve, 30000))
  p2pSession.stop()
}
main().catch(console.error)
