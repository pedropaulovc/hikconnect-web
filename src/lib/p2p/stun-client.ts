import { createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'

// ─── SafeProtocol constants ───────────────────────────────────────────────────

export const SAFE_PROTOCOL_MAGIC = 0x9ebaace9
export const SAFE_PROTOCOL_VERSION = 0x01000000
export const SAFE_PROTOCOL_HEADER_SIZE = 32
export const SAFE_PROTOCOL_TAIL_SIZE = 32

/** SafeProtocol command codes for Hik STUN */
export const HikStunCmd = {
  BIND_PRIMARY: 0x0812,
  BIND_VARIANT2: 0x0813,
  BIND_VARIANT3: 0x0814,
  RESPONSE: 0x0811,
} as const

export type HikNatType =
  | 'UNKNOWN'
  | 'FULL_CONE'
  | 'RESTRICTED_CONE'
  | 'PORT_RESTRICTED'
  | 'SYMMETRIC'
  | 'NO_NAT'
  | 'FIREWALL'
  | 'UDP_BLOCKED'
  | 'SYMMETRIC_FIREWALL'

const NAT_TYPE_MAP: Record<number, HikNatType> = {
  0: 'UNKNOWN',
  1: 'FULL_CONE',
  2: 'RESTRICTED_CONE',
  3: 'PORT_RESTRICTED',
  4: 'SYMMETRIC',
  5: 'NO_NAT',
  6: 'FIREWALL',
  7: 'UDP_BLOCKED',
  8: 'SYMMETRIC_FIREWALL',
}

// ─── SafeProtocol frame building / parsing ────────────────────────────────────

export function buildSafeProtocolRequest(
  cmd: number,
  deviceSerial: string,
  seqNum: number,
): Buffer {
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><Request><DevSerial>${deviceSerial}</DevSerial></Request>`
  const body = Buffer.from(xmlBody, 'utf-8')
  const bodyLen = body.length

  const header = Buffer.alloc(SAFE_PROTOCOL_HEADER_SIZE)
  header.writeUInt32BE(SAFE_PROTOCOL_MAGIC, 0x00)
  header.writeUInt32BE(SAFE_PROTOCOL_VERSION, 0x04)
  header.writeUInt32BE(seqNum, 0x08)
  header.writeUInt32BE(0, 0x0c) // iProtocolTYP
  header.writeUInt32BE(cmd, 0x10)
  header.writeUInt32BE(0, 0x14) // iProtocolENC
  header.writeUInt32BE(bodyLen, 0x18)
  header.writeUInt32BE(0, 0x1c) // iProtocolREG

  // Tail: MD5 of body, zero-padded to 32 bytes
  const md5 = createHash('md5').update(body).digest() // 16 bytes
  const tail = Buffer.alloc(SAFE_PROTOCOL_TAIL_SIZE)
  md5.copy(tail, 0)

  return Buffer.concat([header, body, tail])
}

export type StunResult = { address: string; port: number }

export function parseSafeProtocolResponse(buf: Buffer): StunResult | null {
  if (buf.length < SAFE_PROTOCOL_HEADER_SIZE + SAFE_PROTOCOL_TAIL_SIZE) {
    return null
  }

  const magic = buf.readUInt32BE(0)
  if (magic !== SAFE_PROTOCOL_MAGIC) {
    return null
  }

  const cmd = buf.readUInt32BE(0x10)
  if (cmd !== HikStunCmd.RESPONSE) {
    return null
  }

  const bodyLen = buf.readUInt32BE(0x18)
  if (buf.length < SAFE_PROTOCOL_HEADER_SIZE + bodyLen + SAFE_PROTOCOL_TAIL_SIZE) {
    return null
  }

  const xmlStr = buf
    .subarray(SAFE_PROTOCOL_HEADER_SIZE, SAFE_PROTOCOL_HEADER_SIZE + bodyLen)
    .toString('utf-8')

  // Parse <Client Address="IP" Port="PORT"/> from XML
  const addrMatch = xmlStr.match(/Address="([^"]+)"/)
  const portMatch = xmlStr.match(/Port="(\d+)"/)
  if (!addrMatch || !portMatch) {
    return null
  }

  return { address: addrMatch[1], port: parseInt(portMatch[1], 10) }
}

// ─── UDP send/receive helper ──────────────────────────────────────────────────

function sendAndReceive(
  host: string,
  port: number,
  packet: Buffer,
  timeoutMs: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const timer = setTimeout(() => {
      socket.close()
      resolve(null)
    }, timeoutMs)

    socket.on('message', (msg) => {
      clearTimeout(timer)
      socket.close()
      resolve(msg)
    })

    socket.on('error', () => {
      clearTimeout(timer)
      socket.close()
      resolve(null)
    })

    socket.send(packet, port, host)
  })
}

// ─── Main STUN bind (single request/response) ────────────────────────────────

export async function hikStunBind(
  stunHost: string,
  stunPort: number,
  deviceSerial: string,
): Promise<StunResult & { natType: HikNatType }> {
  const maxRetries = 5
  const timeoutPerRound = 1000

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const seq = attempt
    const req = buildSafeProtocolRequest(HikStunCmd.BIND_PRIMARY, deviceSerial, seq)
    const resp = await sendAndReceive(stunHost, stunPort, req, timeoutPerRound)
    if (!resp) continue

    const result = parseSafeProtocolResponse(resp)
    if (!result) continue

    // With a single server we can only confirm connectivity; full NAT detection
    // requires two servers. Return FULL_CONE as a reasonable default when we get
    // a valid mapping back.
    return { ...result, natType: 'FULL_CONE' }
  }

  return { address: '', port: 0, natType: 'UDP_BLOCKED' }
}

// ─── RFC 5389 legacy functions (kept for fallback) ────────────────────────────

export const RFC5389_MAGIC_COOKIE = 0x2112a442

export function rfc5389BuildBindingRequest(transactionId?: Buffer): Buffer {
  const txId = transactionId ?? randomBytes(12)
  const msg = Buffer.alloc(20)
  msg.writeUInt16BE(0x0001, 0) // Binding Request
  msg.writeUInt16BE(0, 2) // message length (no attributes)
  msg.writeUInt32BE(RFC5389_MAGIC_COOKIE, 4)
  txId.copy(msg, 8)
  return msg
}

export function rfc5389ParseBindingResponse(buf: Buffer): StunResult {
  const msgType = buf.readUInt16BE(0)
  if (msgType !== 0x0101) {
    throw new Error(`Not a binding response: 0x${msgType.toString(16)}`)
  }

  const msgLen = buf.readUInt16BE(2)
  let offset = 20

  while (offset < 20 + msgLen) {
    const attrType = buf.readUInt16BE(offset)
    const attrLen = buf.readUInt16BE(offset + 2)

    // XOR-MAPPED-ADDRESS (0x0020) or MAPPED-ADDRESS (0x0001)
    if (attrType === 0x0020 || attrType === 0x0001) {
      const family = buf[offset + 5]
      if (family !== 0x01) {
        throw new Error(`Unsupported address family: ${family}`)
      }

      let port = buf.readUInt16BE(offset + 6)
      let ip = buf.readUInt32BE(offset + 8)

      if (attrType === 0x0020) {
        port ^= RFC5389_MAGIC_COOKIE >> 16
        ip ^= RFC5389_MAGIC_COOKIE
      }

      const address = [
        (ip >>> 24) & 0xff,
        (ip >>> 16) & 0xff,
        (ip >>> 8) & 0xff,
        ip & 0xff,
      ].join('.')

      return { address, port }
    }

    offset += 4 + attrLen
    if (attrLen % 4 !== 0) offset += 4 - (attrLen % 4) // padding
  }

  throw new Error('No MAPPED-ADDRESS found in STUN response')
}

export async function rfc5389StunBind(stunHost: string, stunPort: number): Promise<StunResult> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('STUN binding timeout'))
    }, 3000)

    socket.on('message', (msg) => {
      clearTimeout(timeout)
      socket.close()
      resolve(rfc5389ParseBindingResponse(msg))
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      socket.close()
      reject(err)
    })

    const req = rfc5389BuildBindingRequest()
    socket.send(req, stunPort, stunHost)
  })
}
