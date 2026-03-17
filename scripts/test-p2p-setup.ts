#!/usr/bin/env -S npx tsx
// Test: send UDP P2P_SETUP (0x0B02) to real P2P servers
// Usage: npx tsx scripts/test-p2p-setup.ts

import { readFileSync } from 'node:fs'
import { createSocket } from 'node:dgram'
import { encodeV3Message, decodeV3Message, defaultMask, Opcode, AttrTag, V3_HEADER_LEN } from '../src/lib/p2p/v3-protocol'

// Load env
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^(\w+)="?([^"]*)"?$/)
  if (m) process.env[m[1]] = m[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'

async function main() {
  // Login
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('Logged in:', session.apiDomain)

  // Get P2P servers
  const base = `https://${session.apiDomain}`
  const headers = { sessionId: session.sessionId, clientType: '55', featureCode: 'deadbeef' }
  const r = await fetch(base + '/v3/userdevices/v1/resources/pagelist?groupId=-1&limit=50&offset=0&filter=P2P', { headers })
  const d = await r.json() as { P2P: Record<string, Array<{ ip: string; port: number }>> }
  const p2pServers = d.P2P['L38239367']
  console.log('P2P servers:', p2pServers)

  // Build P2P_SETUP message (0x0B02)
  // From RE: attrs: 0x05 (session key), 0x06, 0x00, busType byte, 0x04, 0xFF
  const setupMsg = encodeV3Message({
    msgType: Opcode.P2P_SETUP,
    seqNum: 1,
    reserved: 0,
    mask: defaultMask(),
    attributes: [
      { tag: AttrTag.SESSION_KEY, value: Buffer.from(session.sessionId) },
      { tag: AttrTag.SESSION_INFO, value: Buffer.from('L38239367') },
      { tag: AttrTag.TRANSFOR_DATA, value: Buffer.alloc(0) },
      { tag: AttrTag.BUS_TYPE_ENC, value: Buffer.from([1]) }, // preview
      { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
    ],
  })

  console.log('P2P_SETUP message:', setupMsg.toString('hex'))
  console.log('Message length:', setupMsg.length, 'bytes')

  // Send UDP to each P2P server
  const socket = createSocket('udp4')

  socket.on('message', (msg, rinfo) => {
    console.log(`\n=== RESPONSE from ${rinfo.address}:${rinfo.port} (${msg.length} bytes) ===`)
    console.log('Hex:', msg.toString('hex'))

    // Try to parse as V3 message
    try {
      if (msg.length >= V3_HEADER_LEN && (msg[0] >> 4) === 0xE) {
        const parsed = decodeV3Message(msg)
        console.log('Parsed V3:', {
          msgType: `0x${parsed.msgType.toString(16).padStart(4, '0')}`,
          seqNum: parsed.seqNum,
          attrs: parsed.attributes.map(a => ({
            tag: `0x${a.tag.toString(16).padStart(2, '0')}`,
            len: a.value.length,
            hex: a.value.toString('hex').substring(0, 64),
          })),
        })
      } else {
        console.log('Not a V3 message (magic mismatch)')
      }
    } catch (e) {
      console.log('Parse error:', (e as Error).message)
    }
  })

  socket.bind(0, () => {
    const localPort = socket.address().port
    console.log(`\nBound to local port ${localPort}`)

    for (const server of p2pServers) {
      console.log(`Sending P2P_SETUP to ${server.ip}:${server.port}...`)
      socket.send(setupMsg, server.port, server.ip)
    }

    // Wait for responses
    setTimeout(() => {
      console.log('\nTimeout reached, closing.')
      socket.close()
    }, 10000)
  })
}

main().catch(console.error)
