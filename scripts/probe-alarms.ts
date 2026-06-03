/**
 * Capture the raw /v3/alarms/advanced response shape for the design plan.
 * Usage: npx tsx scripts/probe-alarms.ts
 */
import { readFileSync } from 'fs'
const envFile = readFileSync('.env.local', 'utf-8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^(\w+)=["']?(.+?)["']?$/)
  if (m) process.env[m[1]] = m[2]
}
import { HikConnectClient } from '../src/lib/hikconnect/client'

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })
  const session = client.getSession()!

  const serial = 'L38239367'
  const end = new Date()
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000)
  const qs = new URLSearchParams({
    limit: '5', queryType: '-1', alarmType: '-1',
    deviceSerial: serial,
    alarmStart: fmt(start), alarmEnd: fmt(end),
    offset: '0',
  })
  let base = session.apiDomain
  if (!base.startsWith('http')) base = `https://${base}`
  const resp = await fetch(`${base}/v3/alarms/advanced?${qs}`, {
    headers: { clientType: '55', featureCode: 'deadbeef', sessionId: session.sessionId },
  })
  const data = await resp.json()
  console.log('meta:', JSON.stringify(data.meta))
  console.log('page:', JSON.stringify(data.page))
  console.log('alarms.length:', data.alarms?.length)
  console.log('first alarm keys:', Object.keys(data.alarms?.[0] ?? {}).sort().join(', '))
  console.log('first alarm:', JSON.stringify(data.alarms?.[0], null, 2))
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
