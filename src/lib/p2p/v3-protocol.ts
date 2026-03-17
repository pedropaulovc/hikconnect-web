export type V3Attribute = { tag: number; value: Buffer }

export type V3Message = {
  msgType: number
  attributes: V3Attribute[]
}

export function encodeV3Message(msg: V3Message): Buffer {
  const body = encodeAttributes(msg.attributes)
  // Header: 2-byte msg type + 2-byte body length
  const header = Buffer.alloc(4)
  header.writeUInt16BE(msg.msgType, 0)
  header.writeUInt16BE(body.length, 2)
  return Buffer.concat([header, body])
}

export function decodeV3Message(buf: Buffer): V3Message {
  const msgType = buf.readUInt16BE(0)
  const bodyLen = buf.readUInt16BE(2)
  const attributes = decodeAttributes(buf.subarray(4, 4 + bodyLen))
  return { msgType, attributes }
}

function encodeAttributes(attrs: V3Attribute[]): Buffer {
  const parts: Buffer[] = []
  for (const attr of attrs) {
    const tlv = Buffer.alloc(3 + attr.value.length)
    tlv[0] = attr.tag
    tlv.writeUInt16BE(attr.value.length, 1)
    attr.value.copy(tlv, 3)
    parts.push(tlv)
  }
  return Buffer.concat(parts)
}

function decodeAttributes(buf: Buffer): V3Attribute[] {
  const attrs: V3Attribute[] = []
  let offset = 0
  while (offset < buf.length) {
    const tag = buf[offset]
    const len = buf.readUInt16BE(offset + 1)
    const value = Buffer.from(buf.subarray(offset + 3, offset + 3 + len))
    attrs.push({ tag, value })
    offset += 3 + len
  }
  return attrs
}

export function getStringAttr(attrs: V3Attribute[], tag: number): string | undefined {
  const attr = attrs.find(a => a.tag === tag)
  return attr ? attr.value.toString() : undefined
}

export function getIntAttr(attrs: V3Attribute[], tag: number): number | undefined {
  const attr = attrs.find(a => a.tag === tag)
  if (!attr) return undefined
  if (attr.value.length === 4) return attr.value.readUInt32BE(0)
  if (attr.value.length === 2) return attr.value.readUInt16BE(0)
  return attr.value[0]
}
