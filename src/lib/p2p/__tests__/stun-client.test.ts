import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  buildSafeProtocolRequest,
  parseSafeProtocolResponse,
  SAFE_PROTOCOL_MAGIC,
  SAFE_PROTOCOL_VERSION,
  SAFE_PROTOCOL_HEADER_SIZE,
  SAFE_PROTOCOL_TAIL_SIZE,
  HikStunCmd,
  rfc5389BuildBindingRequest,
  rfc5389ParseBindingResponse,
  RFC5389_MAGIC_COOKIE,
} from '../stun-client'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMockResponse(address: string, port: number, seq = 0): Buffer {
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><Response><Client Address="${address}" Port="${port}"/></Response>`
  const body = Buffer.from(xmlBody, 'utf-8')

  const header = Buffer.alloc(SAFE_PROTOCOL_HEADER_SIZE)
  header.writeUInt32BE(SAFE_PROTOCOL_MAGIC, 0x00)
  header.writeUInt32BE(SAFE_PROTOCOL_VERSION, 0x04)
  header.writeUInt32BE(seq, 0x08)
  header.writeUInt32BE(0, 0x0c)
  header.writeUInt32BE(HikStunCmd.RESPONSE, 0x10)
  header.writeUInt32BE(0, 0x14)
  header.writeUInt32BE(body.length, 0x18)
  header.writeUInt32BE(0, 0x1c)

  const md5 = createHash('md5').update(body).digest()
  const tail = Buffer.alloc(SAFE_PROTOCOL_TAIL_SIZE)
  md5.copy(tail, 0)

  return Buffer.concat([header, body, tail])
}

// ─── SafeProtocol request building ───────────────────────────────────────────

describe('SafeProtocol request building', () => {
  it('builds a valid SafeProtocol frame', () => {
    const pkt = buildSafeProtocolRequest(HikStunCmd.BIND_PRIMARY, 'ABC123', 1)

    // Header checks
    expect(pkt.readUInt32BE(0x00)).toBe(SAFE_PROTOCOL_MAGIC)
    expect(pkt.readUInt32BE(0x04)).toBe(SAFE_PROTOCOL_VERSION)
    expect(pkt.readUInt32BE(0x08)).toBe(1) // seq
    expect(pkt.readUInt32BE(0x0c)).toBe(0) // type
    expect(pkt.readUInt32BE(0x10)).toBe(HikStunCmd.BIND_PRIMARY)
    expect(pkt.readUInt32BE(0x14)).toBe(0) // enc
    expect(pkt.readUInt32BE(0x1c)).toBe(0) // reg

    const bodyLen = pkt.readUInt32BE(0x18)
    expect(bodyLen).toBeGreaterThan(0)
    expect(pkt.length).toBe(SAFE_PROTOCOL_HEADER_SIZE + bodyLen + SAFE_PROTOCOL_TAIL_SIZE)
  })

  it('embeds the device serial in the XML body', () => {
    const serial = 'DS-2CD2042WD-I20180101AABB'
    const pkt = buildSafeProtocolRequest(HikStunCmd.BIND_PRIMARY, serial, 0)
    const bodyLen = pkt.readUInt32BE(0x18)
    const xml = pkt.subarray(SAFE_PROTOCOL_HEADER_SIZE, SAFE_PROTOCOL_HEADER_SIZE + bodyLen).toString('utf-8')

    expect(xml).toContain(`<DevSerial>${serial}</DevSerial>`)
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  })

  it('computes correct MD5 tail', () => {
    const pkt = buildSafeProtocolRequest(HikStunCmd.BIND_PRIMARY, 'TEST', 0)
    const bodyLen = pkt.readUInt32BE(0x18)
    const body = pkt.subarray(SAFE_PROTOCOL_HEADER_SIZE, SAFE_PROTOCOL_HEADER_SIZE + bodyLen)
    const tail = pkt.subarray(SAFE_PROTOCOL_HEADER_SIZE + bodyLen)

    const expectedMd5 = createHash('md5').update(body).digest()
    expect(tail.subarray(0, 16)).toEqual(expectedMd5)
    // Remaining 16 bytes should be zero
    expect(tail.subarray(16)).toEqual(Buffer.alloc(16))
  })

  it('sets different commands for each variant', () => {
    const p1 = buildSafeProtocolRequest(HikStunCmd.BIND_PRIMARY, 'S', 0)
    const p2 = buildSafeProtocolRequest(HikStunCmd.BIND_VARIANT2, 'S', 0)
    const p3 = buildSafeProtocolRequest(HikStunCmd.BIND_VARIANT3, 'S', 0)

    expect(p1.readUInt32BE(0x10)).toBe(0x0812)
    expect(p2.readUInt32BE(0x10)).toBe(0x0813)
    expect(p3.readUInt32BE(0x10)).toBe(0x0814)
  })

  it('increments sequence number', () => {
    const pkt0 = buildSafeProtocolRequest(HikStunCmd.BIND_PRIMARY, 'S', 0)
    const pkt5 = buildSafeProtocolRequest(HikStunCmd.BIND_PRIMARY, 'S', 5)

    expect(pkt0.readUInt32BE(0x08)).toBe(0)
    expect(pkt5.readUInt32BE(0x08)).toBe(5)
  })
})

// ─── SafeProtocol response parsing ───────────────────────────────────────────

describe('SafeProtocol response parsing', () => {
  it('parses a valid response', () => {
    const resp = buildMockResponse('203.0.113.42', 12345)
    const result = parseSafeProtocolResponse(resp)

    expect(result).not.toBeNull()
    expect(result!.address).toBe('203.0.113.42')
    expect(result!.port).toBe(12345)
  })

  it('returns null for wrong magic', () => {
    const resp = buildMockResponse('1.2.3.4', 80)
    resp.writeUInt32BE(0xdeadbeef, 0) // corrupt magic
    expect(parseSafeProtocolResponse(resp)).toBeNull()
  })

  it('returns null for non-response command', () => {
    const resp = buildMockResponse('1.2.3.4', 80)
    resp.writeUInt32BE(HikStunCmd.BIND_PRIMARY, 0x10) // wrong cmd
    expect(parseSafeProtocolResponse(resp)).toBeNull()
  })

  it('returns null for truncated buffer', () => {
    expect(parseSafeProtocolResponse(Buffer.alloc(10))).toBeNull()
  })

  it('returns null when XML lacks Client element', () => {
    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><Response><Error Code="1"/></Response>`
    const body = Buffer.from(xmlBody, 'utf-8')

    const header = Buffer.alloc(SAFE_PROTOCOL_HEADER_SIZE)
    header.writeUInt32BE(SAFE_PROTOCOL_MAGIC, 0x00)
    header.writeUInt32BE(SAFE_PROTOCOL_VERSION, 0x04)
    header.writeUInt32BE(HikStunCmd.RESPONSE, 0x10)
    header.writeUInt32BE(body.length, 0x18)

    const tail = Buffer.alloc(SAFE_PROTOCOL_TAIL_SIZE)
    const pkt = Buffer.concat([header, body, tail])

    expect(parseSafeProtocolResponse(pkt)).toBeNull()
  })
})

// ─── RFC 5389 legacy (fallback) ──────────────────────────────────────────────

describe('RFC 5389 legacy functions', () => {
  it('builds a valid binding request', () => {
    const msg = rfc5389BuildBindingRequest()
    expect(msg.length).toBeGreaterThanOrEqual(20)
    expect(msg.readUInt16BE(0)).toBe(0x0001)
    expect(msg.readUInt32BE(4)).toBe(RFC5389_MAGIC_COOKIE)
  })

  it('parses a binding response with XOR-MAPPED-ADDRESS', () => {
    const txId = Buffer.alloc(12, 0xaa)
    const resp = Buffer.alloc(32)
    resp.writeUInt16BE(0x0101, 0)
    resp.writeUInt16BE(12, 2)
    resp.writeUInt32BE(RFC5389_MAGIC_COOKIE, 4)
    txId.copy(resp, 8)
    resp.writeUInt16BE(0x0020, 20)
    resp.writeUInt16BE(8, 22)
    resp[24] = 0x00
    resp[25] = 0x01
    resp.writeUInt16BE(0x1234 ^ (RFC5389_MAGIC_COOKIE >> 16), 26)
    resp.writeUInt32BE((0xc0a80001 ^ RFC5389_MAGIC_COOKIE) >>> 0, 28)

    const result = rfc5389ParseBindingResponse(resp)
    expect(result.address).toBe('192.168.0.1')
    expect(result.port).toBe(0x1234)
  })
})
