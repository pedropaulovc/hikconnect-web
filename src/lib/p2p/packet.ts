export const PacketType = {
  DATA: 0x02,
} as const

export type PacketHeader = {
  type: number
  payloadLength: number
  seqNum: number
}

export function encodeHeader(header: PacketHeader): Buffer {
  const buf = Buffer.alloc(11)
  buf[0] = 0x24 // magic
  buf[1] = header.type
  buf[2] = 0x00 // padding
  buf.writeUInt16BE(header.payloadLength, 3)
  buf.writeUInt16BE(0, 5) // reserved
  buf.writeUInt32BE(header.seqNum, 7)
  return buf
}

export function decodeHeader(buf: Buffer): PacketHeader {
  if (buf[0] !== 0x24) {
    throw new Error(`Invalid magic byte: 0x${buf[0].toString(16)}`)
  }
  return {
    type: buf[1],
    payloadLength: buf.readUInt16BE(3),
    seqNum: buf.readUInt32BE(7),
  }
}

export const HEADER_SIZE = 11
export const HMAC_SIZE = 32
export const OVERHEAD = HEADER_SIZE + HMAC_SIZE // 43 bytes
