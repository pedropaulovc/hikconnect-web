#!/usr/bin/env -S npx tsx
// Debug: send V3 P2P_SETUP (0x0B02) with correct ComposeTransfor attributes
import { readFileSync } from 'node:fs'
import { createSocket } from 'node:dgram'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^(\w+)="?([^"]*)"?$/)
  if (m) process.env[m[1]] = m[2]
}

import { HikConnectClient } from '../src/lib/hikconnect/client'
import {
  encodeV3Message, defaultMask, Opcode, AttrTag,
  V3_HEADER_LEN, decodeV3Message,
  type V3Attribute,
} from '../src/lib/p2p/v3-protocol'

async function main() {
  const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com' })
  const session = await client.login({
    account: process.env.HIKCONNECT_ACCOUNT!,
    password: process.env.HIKCONNECT_PASSWORD!,
  })
  console.log('Logged in:', session.apiDomain)

  // Get P2P config
  const base = `https://${session.apiDomain}`
  const headers = { sessionId: session.sessionId, clientType: '55', featureCode: 'deadbeef' }
  const r = await fetch(base + '/v3/userdevices/v1/resources/pagelist?groupId=-1&limit=50&offset=0&filter=P2P,KMS,CONNECTION', { headers })
  const d = await r.json() as Record<string, Record<string, unknown>>
  const p2pServers = d.P2P['L38239367'] as Array<{ ip: string; port: number }>
  const kms = d.KMS['L38239367'] as { secretKey: string; version: string }
  const conn = d.CONNECTION['L38239367'] as Record<string, unknown>
  console.log('P2P servers:', p2pServers)
  console.log('KMS key:', kms.secretKey.substring(0, 16) + '... version:', kms.version)
  console.log('NVR IP:', conn.netIp)

  // Build P2P_SETUP (0x0B02) with ComposeTransfor attributes
  // From cas-session-flow.md section 5:
  // ComposeTransfor writes: 0x71(busType), 0x72(protoVer), 0x75(flag), 0x7F(transportFlag),
  //   0x74(localAddr "IP:port"), 0x73(relayAddr), 0x8C(sessionId 4bytes)
  // Then: 0x05(sessionKey), 0x06(sessionInfo), 0x00(serial), busType byte, 0x04(encoded), 0xFF(end)

  const attrs: V3Attribute[] = [
    // ComposeTransfor block
    { tag: 0x71, value: Buffer.from([1]) },           // busType: 1 = preview
    { tag: 0x72, value: Buffer.from([3]) },           // protocol version: 3
    { tag: 0x75, value: Buffer.from([0]) },           // additional flag
    { tag: 0x7f, value: Buffer.from([0]) },           // transport flag
    { tag: 0x74, value: Buffer.from('0.0.0.0:0') },  // local address (placeholder)
    // { tag: 0x73, value: Buffer.from('') },          // relay/mapped addr (empty)
    { tag: 0x8c, value: Buffer.alloc(4) },            // session ID: 0

    // Session info
    { tag: AttrTag.SESSION_KEY, value: Buffer.from(session.sessionId) },
    { tag: 0x06, value: Buffer.from('L38239367') },   // additional session info (serial)
    { tag: 0x00, value: Buffer.from('L38239367') },   // device serial
    { tag: 0x76, value: Buffer.from([1]) },           // busType byte
    { tag: 0x04, value: Buffer.from([1]) },           // encoded data
    { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
  ]

  // Build the key buffer from KMS hex (first 32 bytes = first 16 bytes of AES key)
  const keyBuf = Buffer.from(kms.secretKey, 'hex')
  console.log('Key buffer:', keyBuf.length, 'bytes')

  // Try both encrypted and unencrypted
  const msgEncrypted = encodeV3Message({
    msgType: Opcode.P2P_SETUP,
    seqNum: 1,
    reserved: 0,
    mask: defaultMask({ encrypt: true, saltVersion: 1 }),
    attributes: attrs,
  }, keyBuf)

  const msgPlain = encodeV3Message({
    msgType: Opcode.P2P_SETUP,
    seqNum: 2,
    reserved: 0,
    mask: defaultMask(),
    attributes: attrs,
  })

  const msg = msgPlain // Try plain first to verify connectivity
  console.log('\nEncrypted P2P_SETUP:', msgEncrypted.length, 'bytes, mask:', '0x' + msgEncrypted[1].toString(16))
  console.log('Plain P2P_SETUP:', msgPlain.length, 'bytes, mask:', '0x' + msgPlain[1].toString(16))

  console.log('\nP2P_SETUP message:', msg.length, 'bytes')
  console.log('Header hex:', msg.subarray(0, V3_HEADER_LEN).toString('hex'))
  console.log('Body hex:', msg.subarray(V3_HEADER_LEN).toString('hex').substring(0, 100) + '...')

  // Send to P2P servers and listen for response
  const socket = createSocket('udp4')

  socket.on('message', (buf, rinfo) => {
    console.log(`\n=== RESPONSE from ${rinfo.address}:${rinfo.port} (${buf.length} bytes) ===`)
    console.log('Raw hex:', buf.toString('hex'))

    // Try V3 parse
    if (buf.length >= V3_HEADER_LEN && (buf[0] >> 4) === 0xE) {
      try {
        const parsed = decodeV3Message(buf)
        console.log('V3 msgType:', '0x' + parsed.msgType.toString(16).padStart(4, '0'))
        console.log('V3 seqNum:', parsed.seqNum)
        console.log('V3 mask:', JSON.stringify(parsed.mask))
        for (const a of parsed.attributes) {
          const hex = a.value.toString('hex')
          const ascii = a.value.toString('ascii').replace(/[^\x20-\x7e]/g, '.')
          console.log(`  attr 0x${a.tag.toString(16).padStart(2, '0')} (${a.value.length}b): ${hex.substring(0, 40)} | ${ascii.substring(0, 30)}`)
        }
      } catch (e) {
        console.log('V3 parse error:', (e as Error).message)
      }
    }

    // Try SafeProtocol parse
    if (buf.length >= 32 && buf.readUInt32BE(0) === 0x9ebaace9) {
      console.log('SafeProtocol response!')
      const bodyLen = buf.readUInt32BE(0x18)
      if (bodyLen > 0) {
        console.log('Body:', buf.subarray(32, 32 + bodyLen).toString('utf-8'))
      }
    }
  })

  socket.bind(0, () => {
    const localPort = socket.address().port
    console.log(`\nBound to port ${localPort}`)

    // Send both encrypted and plain to all servers
    for (const server of p2pServers) {
      console.log(`Sending ENCRYPTED P2P_SETUP to ${server.ip}:${server.port}`)
      socket.send(msgEncrypted, server.port, server.ip)
    }
    // Also try plain after a short delay
    setTimeout(() => {
      for (const server of p2pServers) {
        console.log(`Sending PLAIN P2P_SETUP to ${server.ip}:${server.port}`)
        socket.send(msgPlain, server.port, server.ip)
      }
    }, 1000)

    setTimeout(() => {
      console.log('\nTimeout (10s)')
      socket.close()
    }, 10000)
  })
}

main().catch(console.error)
