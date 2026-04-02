// Device-side P2P packet framing for the Hikvision streaming protocol.
// Wire format reverse-engineered from UDP captures of Hik-Connect P2P sessions.

// ─── Packet type identifiers (first 2 bytes of each UDP packet) ──────────────

export const ControlType = {
  CONNECTION_CONTROL: 0x8000,
  KEEPALIVE: 0x8001,
  DATA_ACK: 0x8002,
  DATA_REFERENCE: 0x8003,
  SHORT_ACK: 0x8006,
} as const

export const SESSION_SETUP_MAGIC = 0x7534

// ─── Sizes ───────────────────────────────────────────────────────────────────

export const CONNECTION_CONTROL_SIZE = 64
export const KEEPALIVE_SIZE = 20
export const DATA_ACK_SIZE = 44
export const DATA_REFERENCE_SIZE = 20
export const SHORT_ACK_SIZE = 20
export const SESSION_SETUP_HEADER_SIZE = 28
export const DATA_HEADER_SIZE = 16

// ─── Data packet flag prefixes ───────────────────────────────────────────────

export const DataFlags = {
  FIRST_FRAGMENT: 0xe000,
  CONTINUATION_MASK: 0xc000,
} as const

// ─── Session setup flags ─────────────────────────────────────────────────────

export const SessionFlags = {
  SYN: 0xc000,
} as const

// ─── Init data magic ────────────────────────────────────────────────────────

export const INIT_DATA_MAGIC = 0x01000101
export const IMKH_MAGIC = 0x494d4b48 // "IMKH" ASCII

// ─── Types ───────────────────────────────────────────────────────────────────

export type PacketKind =
  | 'connection_control'
  | 'keepalive'
  | 'data_ack'
  | 'data_reference'
  | 'short_ack'
  | 'session_setup'
  | 'data'
  | 'unknown'

export type ConnectionControlPacket = {
  kind: 'connection_control'
  raw: Buffer
  dataSessionId: number
  mtu: number
}

export type KeepalivePacket = {
  kind: 'keepalive'
  timestamp: number
  sourceId: number
}

export type DataAckPacket = {
  kind: 'data_ack'
  sequenceNumber: bigint
  timestamp: number
  sourceId: number
  ackedSessionId: number
  ackMetadata: Buffer
}

export type DataReferencePacket = {
  kind: 'data_reference'
  raw: Buffer
}

export type ShortAckPacket = {
  kind: 'short_ack'
  timestamp: number
  sourceId: number
}

export type SessionSetupPacket = {
  kind: 'session_setup'
  sessionCounter: number
  flags: number
  sequenceNumber: number
  timestamp1: number
  sourceId: number
  headerData: Buffer
  embeddedV3: Buffer | null
}

export type DataPacket = {
  kind: 'data'
  dataSessionId: number
  flags: number
  sequenceNumber: number
  totalLengthOrOffset: number
  sourceId: number
  payload: Buffer
}

export type ParsedPacket =
  | ConnectionControlPacket
  | KeepalivePacket
  | DataAckPacket
  | DataReferencePacket
  | ShortAckPacket
  | SessionSetupPacket
  | DataPacket

// ─── Packet type identification ──────────────────────────────────────────────

export function identifyPacket(buf: Buffer): PacketKind {
  if (buf.length < 2) return 'unknown'

  const first2 = buf.readUInt16BE(0)

  if (first2 === ControlType.CONNECTION_CONTROL) return 'connection_control'
  if (first2 === ControlType.KEEPALIVE) return 'keepalive'
  if (first2 === ControlType.DATA_ACK) return 'data_ack'
  if (first2 === ControlType.DATA_REFERENCE) return 'data_reference'
  if (first2 === ControlType.SHORT_ACK) return 'short_ack'
  if (first2 === SESSION_SETUP_MAGIC) return 'session_setup'

  // Data packets: first 4 bytes are the negotiated session ID (not 0x80xx or 0x7534).
  // They have flags at offset 4-5 with the high bits set (0xc000 or 0xe000).
  if (buf.length >= DATA_HEADER_SIZE) {
    const flags = buf.readUInt16BE(4)
    if ((flags & DataFlags.CONTINUATION_MASK) === DataFlags.CONTINUATION_MASK) return 'data'
  }

  return 'unknown'
}

// ─── Parsing: control packets ────────────────────────────────────────────────

export function parseConnectionControl(buf: Buffer): ConnectionControlPacket {
  if (buf.length < CONNECTION_CONTROL_SIZE) {
    throw new Error(`Connection control packet too short: ${buf.length} bytes, need ${CONNECTION_CONTROL_SIZE}`)
  }

  return {
    kind: 'connection_control',
    raw: Buffer.from(buf),
    dataSessionId: buf.readUInt32BE(24),
    mtu: buf.readUInt32BE(28),
  }
}

export function parseKeepalive(buf: Buffer): KeepalivePacket {
  if (buf.length < KEEPALIVE_SIZE) {
    throw new Error(`Keepalive packet too short: ${buf.length} bytes, need ${KEEPALIVE_SIZE}`)
  }

  return {
    kind: 'keepalive',
    timestamp: buf.readUInt32BE(8),
    sourceId: buf.readUInt32BE(12),
  }
}

export function parseDataAck(buf: Buffer): DataAckPacket {
  if (buf.length < DATA_ACK_SIZE) {
    throw new Error(`Data ACK packet too short: ${buf.length} bytes, need ${DATA_ACK_SIZE}`)
  }

  // Sequence number is 6 bytes big-endian at offset 2-7
  const seqHigh = buf.readUInt16BE(2)
  const seqLow = buf.readUInt32BE(4)
  const sequenceNumber = (BigInt(seqHigh) << 32n) | BigInt(seqLow)

  return {
    kind: 'data_ack',
    sequenceNumber,
    timestamp: buf.readUInt32BE(8),
    sourceId: buf.readUInt32BE(12),
    ackedSessionId: buf.readUInt32BE(16),
    ackMetadata: Buffer.from(buf.subarray(20, 44)),
  }
}

export function parseDataReference(buf: Buffer): DataReferencePacket {
  if (buf.length < DATA_REFERENCE_SIZE) {
    throw new Error(`Data reference packet too short: ${buf.length} bytes, need ${DATA_REFERENCE_SIZE}`)
  }

  return {
    kind: 'data_reference',
    raw: Buffer.from(buf),
  }
}

export function parseShortAck(buf: Buffer): ShortAckPacket {
  if (buf.length < SHORT_ACK_SIZE) {
    throw new Error(`Short ACK packet too short: ${buf.length} bytes, need ${SHORT_ACK_SIZE}`)
  }

  return {
    kind: 'short_ack',
    timestamp: buf.readUInt32BE(8),
    sourceId: buf.readUInt32BE(12),
  }
}

// ─── Parsing: session setup (0x7534) ─────────────────────────────────────────

export function parseSessionSetup(buf: Buffer): SessionSetupPacket {
  if (buf.length < SESSION_SETUP_HEADER_SIZE) {
    throw new Error(`Session setup packet too short: ${buf.length} bytes, need ${SESSION_SETUP_HEADER_SIZE}`)
  }

  const headerData = Buffer.from(buf.subarray(16, 28))

  // Embedded V3 message starts at offset 28, identified by 0xE2 magic
  let embeddedV3: Buffer | null = null
  if (buf.length > SESSION_SETUP_HEADER_SIZE && (buf[28] & 0xf0) === 0xe0) {
    embeddedV3 = Buffer.from(buf.subarray(28))
  }

  return {
    kind: 'session_setup',
    sessionCounter: buf.readUInt16BE(2),
    flags: buf.readUInt16BE(4),
    sequenceNumber: buf.readUInt16BE(6),
    timestamp1: buf.readUInt32BE(8),
    sourceId: buf.readUInt32BE(12),
    headerData,
    embeddedV3,
  }
}

// ─── Parsing: data packets ───────────────────────────────────────────────────

export function parseDataPacket(buf: Buffer): DataPacket {
  if (buf.length < DATA_HEADER_SIZE) {
    throw new Error(`Data packet too short: ${buf.length} bytes, need ${DATA_HEADER_SIZE}`)
  }

  return {
    kind: 'data',
    dataSessionId: buf.readUInt32BE(0),
    flags: buf.readUInt16BE(4),
    sequenceNumber: buf.readUInt16BE(6),
    totalLengthOrOffset: buf.readUInt32BE(8),
    sourceId: buf.readUInt32BE(12),
    payload: Buffer.from(buf.subarray(16)),
  }
}

// ─── Unified parser ──────────────────────────────────────────────────────────

export function parsePacket(buf: Buffer): ParsedPacket | null {
  const kind = identifyPacket(buf)

  if (kind === 'connection_control') return parseConnectionControl(buf)
  if (kind === 'keepalive') return parseKeepalive(buf)
  if (kind === 'data_ack') return parseDataAck(buf)
  if (kind === 'data_reference') return parseDataReference(buf)
  if (kind === 'short_ack') return parseShortAck(buf)
  if (kind === 'session_setup') return parseSessionSetup(buf)
  if (kind === 'data') return parseDataPacket(buf)

  return null
}

// ─── Building: keepalive ─────────────────────────────────────────────────────

export function buildKeepalive(timestamp: number, sourceId: number): Buffer {
  const buf = Buffer.alloc(KEEPALIVE_SIZE)
  buf.writeUInt16BE(ControlType.KEEPALIVE, 0)
  // bytes 2-7: zeros (already zeroed by alloc)
  buf.writeUInt32BE(timestamp, 8)
  buf.writeUInt32BE(sourceId, 12)
  // bytes 16-19: zeros (already zeroed by alloc)
  return buf
}

// ─── Building: data ACK ──────────────────────────────────────────────────────

export function buildDataAck(
  sequenceNumber: bigint,
  timestamp: number,
  sourceId: number,
  ackedSessionId: number,
  ackMetadata?: Buffer,
): Buffer {
  const buf = Buffer.alloc(DATA_ACK_SIZE)
  buf.writeUInt16BE(ControlType.DATA_ACK, 0)

  // 6-byte big-endian sequence number at offset 2-7
  const seqHigh = Number((sequenceNumber >> 32n) & 0xffffn)
  const seqLow = Number(sequenceNumber & 0xffffffffn)
  buf.writeUInt16BE(seqHigh, 2)
  buf.writeUInt32BE(seqLow, 4)

  buf.writeUInt32BE(timestamp, 8)
  buf.writeUInt32BE(sourceId, 12)
  buf.writeUInt32BE(ackedSessionId, 16)

  if (ackMetadata) {
    const copyLen = Math.min(ackMetadata.length, 24)
    ackMetadata.copy(buf, 20, 0, copyLen)
  }

  return buf
}

// ─── Building: short ACK ─────────────────────────────────────────────────────

export function buildShortAck(timestamp: number, sourceId: number): Buffer {
  const buf = Buffer.alloc(SHORT_ACK_SIZE)
  buf.writeUInt16BE(ControlType.SHORT_ACK, 0)
  // bytes 2-7: zeros
  buf.writeUInt32BE(timestamp, 8)
  buf.writeUInt32BE(sourceId, 12)
  // bytes 16-19: zeros
  return buf
}

// ─── Building: session setup (0x7534) ────────────────────────────────────────

export function buildSessionSetup(
  sessionCounter: number,
  flags: number,
  sequenceNumber: number,
  timestamp1: number,
  sourceId: number,
  headerData: Buffer,
  embeddedV3?: Buffer,
): Buffer {
  const totalSize = SESSION_SETUP_HEADER_SIZE + (embeddedV3?.length ?? 0)
  const buf = Buffer.alloc(totalSize)

  buf.writeUInt16BE(SESSION_SETUP_MAGIC, 0)
  buf.writeUInt16BE(sessionCounter, 2)
  buf.writeUInt16BE(flags, 4)
  buf.writeUInt16BE(sequenceNumber, 6)
  buf.writeUInt32BE(timestamp1, 8)
  buf.writeUInt32BE(sourceId, 12)

  const hdCopyLen = Math.min(headerData.length, 12)
  headerData.copy(buf, 16, 0, hdCopyLen)

  if (embeddedV3) {
    embeddedV3.copy(buf, SESSION_SETUP_HEADER_SIZE)
  }

  return buf
}

// ─── Init data payload helpers ───────────────────────────────────────────────

export function extractDeviceSerial(initPayload: Buffer): string | null {
  // Device serial starts at offset 12 from payload start, null-terminated ASCII
  if (initPayload.length < 13) return null

  const serialStart = 12
  let serialEnd = serialStart
  while (serialEnd < initPayload.length && initPayload[serialEnd] !== 0) {
    serialEnd++
  }

  if (serialEnd === serialStart) return null
  return initPayload.subarray(serialStart, serialEnd).toString('ascii')
}

export function findImkhOffset(initPayload: Buffer): number {
  // "IMKH" media container header typically at offset 140 from payload start
  if (initPayload.length >= 144) {
    const candidate = initPayload.readUInt32BE(140)
    if (candidate === IMKH_MAGIC) return 140
  }

  // Fallback: scan for IMKH magic
  for (let i = 0; i <= initPayload.length - 4; i++) {
    if (initPayload.readUInt32BE(i) === IMKH_MAGIC) return i
  }

  return -1
}

export function isInitDataPayload(payload: Buffer): boolean {
  if (payload.length < 4) return false
  return payload.readUInt32BE(0) === INIT_DATA_MAGIC
}

// ─── Fragment reassembly buffer ──────────────────────────────────────────────

export type FragmentEntry = {
  sequenceNumber: number
  offset: number
  payload: Buffer
}

export type ReassemblyResult =
  | { status: 'incomplete' }
  | { status: 'complete'; message: Buffer }

export type ReassemblyBuffer = {
  totalLength: number
  receivedBytes: number
  fragments: Map<number, FragmentEntry>
}

export function createReassemblyBuffer(): ReassemblyBuffer {
  return {
    totalLength: 0,
    receivedBytes: 0,
    fragments: new Map(),
  }
}

/**
 * Feed a parsed data packet into the reassembly buffer.
 * Returns { status: 'complete', message } when all fragments have arrived,
 * or { status: 'incomplete' } otherwise.
 */
export function feedFragment(rb: ReassemblyBuffer, packet: DataPacket): ReassemblyResult {
  const isFirst = (packet.flags & DataFlags.FIRST_FRAGMENT) === DataFlags.FIRST_FRAGMENT

  // First fragment declares totalLength in the totalLengthOrOffset field
  if (isFirst) {
    rb.totalLength = packet.totalLengthOrOffset
    rb.receivedBytes = 0
    rb.fragments.clear()
  }

  // Avoid duplicate fragments
  if (rb.fragments.has(packet.sequenceNumber)) {
    return checkComplete(rb)
  }

  const entry: FragmentEntry = {
    sequenceNumber: packet.sequenceNumber,
    offset: isFirst ? 0 : packet.totalLengthOrOffset,
    payload: packet.payload,
  }

  rb.fragments.set(packet.sequenceNumber, entry)
  rb.receivedBytes += packet.payload.length

  return checkComplete(rb)
}

function checkComplete(rb: ReassemblyBuffer): ReassemblyResult {
  if (rb.totalLength === 0) return { status: 'incomplete' }
  if (rb.receivedBytes < rb.totalLength) return { status: 'incomplete' }

  // Assemble: sort fragments by offset and concatenate
  const sorted = [...rb.fragments.values()].sort((a, b) => a.offset - b.offset)
  const assembled = Buffer.alloc(rb.totalLength)

  for (const frag of sorted) {
    const copyLen = Math.min(frag.payload.length, rb.totalLength - frag.offset)
    if (copyLen <= 0) continue
    frag.payload.copy(assembled, frag.offset, 0, copyLen)
  }

  return { status: 'complete', message: assembled }
}

/**
 * Reset the reassembly buffer, discarding any partial state.
 */
export function resetReassemblyBuffer(rb: ReassemblyBuffer): void {
  rb.totalLength = 0
  rb.receivedBytes = 0
  rb.fragments.clear()
}
