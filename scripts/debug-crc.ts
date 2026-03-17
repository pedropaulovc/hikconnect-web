#!/usr/bin/env -S npx tsx
import { crc8 } from '../src/lib/p2p/v3-protocol'

// Response from server: e2020b030000000200000c23020400000003
// CRC byte is at offset 11 = 0x23
const response = Buffer.from('e2020b030000000200000c23020400000003', 'hex')
console.log('Response hex:', response.toString('hex'))
console.log('Stored CRC:', '0x' + response[11].toString(16))

// Zero byte 11 for CRC calc
const check = Buffer.from(response)
check[11] = 0x00
console.log('CRC over full msg:', '0x' + crc8(check).toString(16))

// CRC over just the header (12 bytes)
const headerOnly = Buffer.from('e2020b030000000200000c00', 'hex')
console.log('CRC over header only:', '0x' + crc8(headerOnly).toString(16))

// Try different polynomials
function crc8poly(data: Buffer, poly: number): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff
    }
  }
  return crc
}

for (const poly of [0x07, 0x31, 0x1d, 0x9b, 0xd5, 0x39, 0x49, 0x97]) {
  const result = crc8poly(check, poly)
  if (result === 0x23) {
    console.log(`MATCH! poly=0x${poly.toString(16)} → CRC=0x${result.toString(16)}`)
  }
}

// Try CRC over header only with different polys
for (const poly of [0x07, 0x31, 0x1d, 0x9b, 0xd5, 0x39, 0x49, 0x97]) {
  const result = crc8poly(headerOnly, poly)
  if (result === 0x23) {
    console.log(`MATCH (header only)! poly=0x${poly.toString(16)} → CRC=0x${result.toString(16)}`)
  }
}

// Try init value variations
for (const init of [0x00, 0xff, 0x23]) {
  for (const poly of [0x07, 0x31, 0x1d, 0x9b, 0xd5, 0x39, 0x49, 0x97]) {
    let crc = init
    for (const byte of check) {
      crc ^= byte
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x80) ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff
      }
    }
    if (crc === 0x23) {
      console.log(`MATCH! init=0x${init.toString(16)} poly=0x${poly.toString(16)} → 0x${crc.toString(16)}`)
    }
  }
}
