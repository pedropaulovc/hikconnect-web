/**
 * VTM (VTDU) client — TCP connection to Hikvision relay server.
 *
 * Protocol: '$' magic framing with protobuf-encoded messages.
 * Used when P2P direct connection fails (device behind NAT).
 */

import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'

// -- Protobuf helpers (hand-encoded, no library needed) --

function pbVarint(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v & 0x7f)
  return Buffer.from(bytes)
}

function pbTag(fieldNum: number, wireType: number): Buffer {
  return pbVarint((fieldNum << 3) | wireType)
}

function pbBytes(fieldNum: number, value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([pbTag(fieldNum, 2), pbVarint(data.length), data])
}

function pbInt32(fieldNum: number, value: number): Buffer {
  return Buffer.concat([pbTag(fieldNum, 0), pbVarint(value)])
}

// -- Message type IDs (from Ghidra get_msg_type decompilation) --

export const VtmMsgType = {
  STREAM_INFO_REQ: 0x0130,
  STREAM_INFO_RSP: 0x0131,
  KEEP_ALIVE_REQ: 0x0132,
  STOP_STREAM_REQ: 0x013b,
  STOP_STREAM_RSP: 0x013c,
  START_STREAM_REQ: 0x0145,
} as const

// -- StreamInfoReq (protobuf field numbers from Ghidra SerializeWithCachedSizes) --
// Field 1: streamurl (bytes) — the ysproto:// URL
// Field 2: vtmstreamkey (bytes) — stream ticket/key
// Field 3: clnversion (bytes) — client version
// Field 4: proxytype (int32) — proxy type
// Field 5: pdsstring (bytes) — PDS info
// Field 6: useragent (bytes) — user agent string
// Field 7: pdsnum (int32) — PDS number
// Field 8: timeout (int32) — timeout in ms

export type StreamInfoReqParams = {
  streamUrl: string     // field 1: ysproto://host:port/serial?params
  vtmStreamKey: string  // field 2: stream ticket from API
  clnVersion: string    // field 3: client version
  proxyType: number     // field 4: proxy type (0 = direct)
  pdsString: string     // field 5: PDS info string
  userAgent: string     // field 6: user agent
  pdsNum: number        // field 7: PDS number
  timeout: number       // field 8: timeout ms
}

function encodeStreamInfoReq(params: StreamInfoReqParams): Buffer {
  const parts: Buffer[] = []
  parts.push(pbBytes(1, params.streamUrl))
  parts.push(pbBytes(2, params.vtmStreamKey))
  if (params.clnVersion) parts.push(pbBytes(3, params.clnVersion))
  if (params.proxyType > 0) parts.push(pbInt32(4, params.proxyType))
  if (params.pdsString) parts.push(pbBytes(5, params.pdsString))
  if (params.userAgent) parts.push(pbBytes(6, params.userAgent))
  if (params.pdsNum > 0) parts.push(pbInt32(7, params.pdsNum))
  if (params.timeout > 0) parts.push(pbInt32(8, params.timeout))
  return Buffer.concat(parts)
}

// -- VTM framing: 8-byte header --
// Byte 0: 0x24 ('$') magic
// Bytes 1-2: message type (big-endian)
// Bytes 3-4: payload length (big-endian)
// Byte 5: flags (0x10 = standard)
// Bytes 6-7: sub-type / message ID

const VTM_MAGIC = 0x24

function encodeVtmFrame(msgType: number, subType: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header[0] = VTM_MAGIC
  header.writeUInt16BE(msgType, 1)
  header.writeUInt16BE(payload.length, 3)
  header[5] = 0x10 // flags
  // Sub-type is stored little-endian (from Ghidra decompilation)
  header[6] = subType & 0xff
  header[7] = (subType >> 8) & 0xff
  return Buffer.concat([header, payload])
}

function decodeVtmFrame(buf: Buffer): { msgType: number; subType: number; payload: Buffer; totalLen: number } | null {
  if (buf.length < 8) return null
  if (buf[0] !== VTM_MAGIC) return null
  const msgType = buf.readUInt16BE(1)
  const payloadLen = buf.readUInt16BE(3)
  const subType = buf.readUInt16BE(6)
  const totalLen = 8 + payloadLen
  if (buf.length < totalLen) return null
  return { msgType, subType, payload: buf.subarray(8, totalLen), totalLen }
}

// -- VtmClient --

export type VtmClientConfig = {
  host: string
  port: number
}

type VtmClientState = 'disconnected' | 'connecting' | 'connected'

export class VtmClient extends EventEmitter {
  private socket: Socket | null = null
  private recvBuf = Buffer.alloc(0)
  private state: VtmClientState = 'disconnected'

  constructor(private config: VtmClientConfig) {
    super()
  }

  connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      return Promise.reject(new Error(`Cannot connect: state is ${this.state}`))
    }
    this.state = 'connecting'

    return new Promise((resolve, reject) => {
      const socket = new Socket()
      this.socket = socket

      const timeout = setTimeout(() => {
        socket.destroy()
        this.state = 'disconnected'
        reject(new Error('VTM connection timeout'))
      }, 10_000)

      socket.once('connect', () => {
        clearTimeout(timeout)
        this.state = 'connected'
        console.log(`[VTM] Connected to ${this.config.host}:${this.config.port}`)
        resolve()
      })

      socket.once('error', (err) => {
        clearTimeout(timeout)
        this.state = 'disconnected'
        this.emit('error', err)
        reject(err)
      })

      socket.on('data', (chunk: Buffer) => this.onData(chunk))

      socket.on('close', () => {
        this.state = 'disconnected'
        this.socket = null
        this.recvBuf = Buffer.alloc(0)
        this.emit('close')
      })

      socket.connect(this.config.port, this.config.host)
    })
  }

  sendStreamInfoReq(params: StreamInfoReqParams): void {
    const payload = encodeStreamInfoReq(params)
    const frame = encodeVtmFrame(0, VtmMsgType.STREAM_INFO_REQ, payload)
    this.sendRaw(frame)
    console.log(`[VTM] Sent StreamInfoReq (${payload.length}B payload, subType=0x${VtmMsgType.STREAM_INFO_REQ.toString(16)})`)
  }

  sendRaw(data: Buffer): void {
    if (!this.socket || this.state !== 'connected') {
      throw new Error('Not connected')
    }
    this.socket.write(data)
  }

  disconnect(): void {
    this.socket?.destroy()
    this.socket = null
    this.state = 'disconnected'
    this.recvBuf = Buffer.alloc(0)
  }

  private onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk])
    this.drain()
  }

  private drain(): void {
    while (this.recvBuf.length >= 8) {
      const frame = decodeVtmFrame(this.recvBuf)
      if (!frame) {
        // Check if first byte is valid
        if (this.recvBuf[0] !== VTM_MAGIC) {
          // Raw stream data (video/audio frames)
          this.emit('streamData', Buffer.from(this.recvBuf))
          this.recvBuf = Buffer.alloc(0)
          return
        }
        return // need more data
      }

      console.log(`[VTM] Recv frame type=${frame.msgType} subType=${frame.subType} len=${frame.payload.length}`)
      this.emit('frame', frame)

      this.recvBuf = Buffer.from(this.recvBuf.subarray(frame.totalLen))
    }

    // Any remaining data that doesn't start with '$' is stream data
    if (this.recvBuf.length > 0 && this.recvBuf[0] !== VTM_MAGIC) {
      this.emit('streamData', Buffer.from(this.recvBuf))
      this.recvBuf = Buffer.alloc(0)
    }
  }
}
