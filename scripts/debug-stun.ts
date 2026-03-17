#!/usr/bin/env -S npx tsx
// Debug: raw STUN response hex dump
import { createSocket } from 'node:dgram'
import { buildSafeProtocolRequest, SAFE_PROTOCOL_HEADER_SIZE, HikStunCmd } from '../src/lib/p2p/stun-client'

const req = buildSafeProtocolRequest(HikStunCmd.BIND_PRIMARY, 'L38239367', 0)
console.log('Request hex:', req.toString('hex'))
console.log('Request length:', req.length)

const socket = createSocket('udp4')

socket.on('message', (msg, rinfo) => {
  console.log(`\nResponse from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`)
  console.log('Hex:', msg.toString('hex'))

  // Parse header fields
  if (msg.length >= 32) {
    console.log('\nHeader:')
    console.log('  magic:', '0x' + msg.readUInt32BE(0).toString(16))
    console.log('  version:', '0x' + msg.readUInt32BE(4).toString(16))
    console.log('  seq:', msg.readUInt32BE(8))
    console.log('  type:', '0x' + msg.readUInt32BE(0x0c).toString(16))
    console.log('  cmd:', '0x' + msg.readUInt32BE(0x10).toString(16))
    console.log('  enc:', '0x' + msg.readUInt32BE(0x14).toString(16))
    console.log('  bodyLen:', msg.readUInt32BE(0x18))
    console.log('  reg:', '0x' + msg.readUInt32BE(0x1c).toString(16))

    const bodyLen = msg.readUInt32BE(0x18)
    if (bodyLen > 0 && msg.length >= 32 + bodyLen) {
      const body = msg.subarray(32, 32 + bodyLen)
      console.log('\nBody (UTF-8):', body.toString('utf-8'))
      console.log('Body (hex):', body.toString('hex'))
    }

    if (msg.length >= 32 + bodyLen + 32) {
      const tail = msg.subarray(32 + bodyLen, 32 + bodyLen + 32)
      console.log('\nTail (hex):', tail.toString('hex'))
    }
  }
})

socket.bind(0, () => {
  const targets = [
    ['43.130.155.63', 6002],
    ['43.130.155.63', 6000],
    ['52.5.124.127', 6000],
    ['52.203.168.207', 6000],
  ] as const

  for (const [ip, port] of targets) {
    console.log(`Sending to ${ip}:${port}...`)
    socket.send(req, port, ip)
  }

  setTimeout(() => {
    console.log('\nNo more responses after 5s')
    socket.close()
  }, 5000)
})
