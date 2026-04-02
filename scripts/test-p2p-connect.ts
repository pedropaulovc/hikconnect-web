/**
 * Standalone P2P connection test — bypasses Next.js to test raw UDP P2P.
 */
// Load env from .env.local
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const match = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (match) process.env[match[1]] = match[2]
}
import { HikConnectClient } from '../src/lib/hikconnect/client'
import { P2PSession } from '../src/lib/p2p/p2p-session'

const account = process.env.HIKCONNECT_ACCOUNT!
const password = process.env.HIKCONNECT_PASSWORD!

async function main() {
  console.log('=== Step 1: Login ===')
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({ account, password })
  console.log('Logged in. Domain:', session.apiDomain)

  console.log('\n=== Step 2: Get P2P Config ===')
  const p2p = await client.getP2PConfig('L38239367')
  console.log('P2P servers:', p2p.servers)
  console.log('Secret key:', p2p.secretKey.substring(0, 20) + '...')
  console.log('Key version:', p2p.keyVersion)
  console.log('Connection:', JSON.stringify(p2p.connection, null, 2))

  console.log('\n=== Step 3: Start P2P Session ===')
  // Use API KMS secretKey as the P2P key
  const p2pKey = Buffer.from(p2p.secretKey, 'hex')
  console.log('P2P key (from API KMS):', p2pKey.toString('hex').substring(0, 40) + '...')
  console.log('P2P key length:', p2pKey.length, 'bytes')

  const p2pLinkKey = Buffer.from(p2p.secretKey.substring(0, 32), 'ascii')
  const p2pSession = new P2PSession({
    deviceSerial: 'L38239367',
    devicePublicIp: p2p.connection.netIp || p2p.connection.wanIp,
    devicePublicPort: p2p.connection.netStreamPort || 9020,
    p2pServers: p2p.servers.map(s => ({ host: s.ip, port: s.port })),
    p2pKey,
    p2pLinkKey,
    p2pKeyVersion: p2p.keyVersion || 101,
    p2pKeySaltIndex: 3,
    p2pKeySaltVer: 1,
    sessionToken: session.sessionId,
    userId: '',
    clientId: 0x0aed13f5,
    channelNo: 1,
    streamType: 1,
    streamTokens: [],
  })

  p2pSession.on('stateChange', ({ from, to }: { from: string; to: string }) => {
    console.log(`[STATE] ${from} -> ${to}`)
  })

  p2pSession.on('data', (payload: Buffer) => {
    console.log(`[DATA] ${payload.length} bytes, first 32: ${payload.subarray(0, 32).toString('hex')}`)
  })

  p2pSession.on('dataSessionEstablished', (id: number) => {
    console.log(`[DATA-SESSION] established: 0x${id.toString(16)}`)
  })

  p2pSession.on('v3message', (msg: unknown) => {
    console.log(`[V3] message:`, msg)
  })

  p2pSession.on('error', (err: Error) => {
    console.log(`[ERROR] ${err.message}`)
  })

  try {
    await p2pSession.start()
    console.log('\nSession started. Waiting 30s for data...')

    await new Promise(resolve => setTimeout(resolve, 30000))
  } catch (err) {
    console.error('Failed:', err)
  } finally {
    p2pSession.stop()
    console.log('Session stopped.')
  }
}

main().catch(console.error)
