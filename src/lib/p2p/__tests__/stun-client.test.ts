import { describe, it, expect } from 'vitest'
import { buildBindingRequest, parseBindingResponse, STUN_MAGIC_COOKIE } from '../stun-client'

describe('STUN message building', () => {
  it('builds a valid binding request', () => {
    const msg = buildBindingRequest()
    // STUN header: 20 bytes minimum
    expect(msg.length).toBeGreaterThanOrEqual(20)
    // Type: 0x0001 (Binding Request)
    expect(msg.readUInt16BE(0)).toBe(0x0001)
    // Magic cookie
    expect(msg.readUInt32BE(4)).toBe(STUN_MAGIC_COOKIE)
  })

  it('parses a binding response with XOR-MAPPED-ADDRESS', () => {
    // Craft a minimal STUN response with XOR-MAPPED-ADDRESS
    const txId = Buffer.alloc(12, 0xaa)
    const resp = Buffer.alloc(32)
    resp.writeUInt16BE(0x0101, 0) // Binding Response
    resp.writeUInt16BE(12, 2) // message length
    resp.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
    txId.copy(resp, 8)
    // XOR-MAPPED-ADDRESS attribute
    resp.writeUInt16BE(0x0020, 20) // type
    resp.writeUInt16BE(8, 22) // length
    resp[24] = 0x00 // reserved
    resp[25] = 0x01 // IPv4
    resp.writeUInt16BE(0x1234 ^ (STUN_MAGIC_COOKIE >> 16), 26) // XOR'd port
    resp.writeUInt32BE((0xc0a80001 ^ STUN_MAGIC_COOKIE) >>> 0, 28) // XOR'd IP

    const result = parseBindingResponse(resp)
    expect(result.address).toBe('192.168.0.1')
    expect(result.port).toBe(0x1234)
  })
})
