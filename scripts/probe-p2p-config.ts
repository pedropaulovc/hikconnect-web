/**
 * Probe POST /api/p2p/configurations — the endpoint the official app uses
 * (ConfigApi.getP2PConfigInfo) to fetch the account-level P2PServerKey + salt.
 *
 * Confirms BLOCKER #1: P2PServerKey is derivable from username/password alone.
 * Response shape (P2PConfigInfoResp):
 *   { expireTime, ticket, secret: { data: "[b0,b1,...,b31]", saltIndex, version, expireTime } }
 * data → strip [], split ',', parse 32 shorts → 32-byte P2PServerKey.
 *
 * Usage: npx tsx scripts/probe-p2p-config.ts
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (m) process.env[m[1]] = m[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('apiDomain:', session.apiDomain)

  const url = `https://${session.apiDomain}/api/p2p/configurations`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      sessionId: session.sessionId,
      clientType: '55',
      featureCode: 'deadbeef',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })
  console.log('HTTP', resp.status)
  const text = await resp.text()
  console.log('RAW:', text.slice(0, 2000))

  try {
    const data = JSON.parse(text)
    const secret = data.secret
    if (secret?.data) {
      const bytes = secret.data.replace(/^\[|\]$/g, '').split(',').map((s: string) => parseInt(s.trim(), 10) & 0xff)
      const hex = Buffer.from(bytes).toString('hex')
      console.log('\n=== DERIVED ===')
      console.log('P2PServerKey :', hex)
      console.log('saltIndex    :', secret.saltIndex)
      console.log('version(salt):', secret.version)
      console.log('secret.expire:', secret.expireTime)
      console.log('cfg.expire   :', data.expireTime)
      console.log('ticket       :', data.ticket)
      console.log('servers      :', JSON.stringify(data.serverInfos))
      console.log('\nNote: the server holds 8 salt-indexed keys and returns one per call;')
      console.log('the saltIndex tells the P2P server which key to decrypt with. Any pair is valid.')
    }
  } catch (e) {
    console.log('parse error:', e)
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
