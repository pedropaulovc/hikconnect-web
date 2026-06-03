/**
 * List available recordings for the device so we can pick a valid playback range.
 * Usage: npx tsx scripts/probe-recordings.ts [YYYY-MM-DD]
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
  await client.login({ account: process.env.HIKCONNECT_ACCOUNT!, password: process.env.HIKCONNECT_PASSWORD! })

  const day = process.argv[2] || '2026-06-03'
  const start = `${day}T00:00:00`
  const stop = `${day}T23:59:59`
  console.log(`Recordings for L38239367 ch1, ${day}:`)
  const files = await client.getRecordings('L38239367', 1, start, stop)
  console.log(`count=${files.length}`)
  for (const f of files.slice(0, 10)) console.log(`  ${f.begin} → ${f.end}  type=${f.type}`)
  if (files.length > 10) console.log(`  ... +${files.length - 10} more`)
  if (files.length) {
    const last = files[files.length - 1]
    console.log(`\nLatest segment: ${last.begin} → ${last.end}`)
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
