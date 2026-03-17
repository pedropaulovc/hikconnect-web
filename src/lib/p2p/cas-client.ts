import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import {
  type V3Message,
  type V3Attribute,
  encodeV3Message,
  decodeV3Message,
  defaultMask,
  Opcode,
  AttrTag,
  V3_HEADER_LEN,
} from '../p2p/v3-protocol'

// -- Re-exports for convenience -----------------------------------------------

export { Opcode, AttrTag }

// -- Sequence number generator ------------------------------------------------

let globalSeqNum = 0

/** Reset sequence counter (for testing). */
export function resetSeqNum(): void {
  globalSeqNum = 0
}

// -- Message builders ---------------------------------------------------------

function u8(val: number): Buffer {
  return Buffer.from([val & 0xff])
}

function u16be(val: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(val, 0)
  return buf
}

function u32be(val: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(val, 0)
  return buf
}

export type PlayRequestParams = {
  busType: number      // 1=preview, 2=playback
  sessionKey: string
  streamType: number   // 0=main, 1=sub
  channelNo: number
  streamSession: number
}

export function buildPlayRequest(params: PlayRequestParams): V3Message {
  return {
    msgType: Opcode.PLAY_REQUEST,
    seqNum: ++globalSeqNum,
    reserved: 0,
    mask: defaultMask(),
    attributes: [
      { tag: AttrTag.BUS_TYPE, value: u8(params.busType) },
      { tag: AttrTag.SESSION_KEY, value: Buffer.from(params.sessionKey) },
      { tag: AttrTag.STREAM_TYPE, value: u8(params.streamType) },
      { tag: AttrTag.CHANNEL_NO, value: u16be(params.channelNo) },
      { tag: AttrTag.STREAM_SESSION, value: u32be(params.streamSession) },
    ],
  }
}

export type TeardownParams = {
  sessionKey: string
  busType: number
  channelNo: number
  streamType: number
}

export function buildTeardown(params: TeardownParams): V3Message {
  return {
    msgType: Opcode.TEARDOWN,
    seqNum: ++globalSeqNum,
    reserved: 0,
    mask: defaultMask(),
    attributes: [
      { tag: AttrTag.SESSION_KEY, value: Buffer.from(params.sessionKey) },
      { tag: AttrTag.BUS_TYPE, value: u8(params.busType) },
      { tag: AttrTag.CHANNEL_NO, value: u16be(params.channelNo) },
      { tag: AttrTag.STREAM_TYPE, value: u8(params.streamType) },
    ],
  }
}

// -- CAS TCP client -----------------------------------------------------------

export type CasClientConfig = {
  host: string
  port: number
}

type CasClientState = 'disconnected' | 'connecting' | 'connected'

export class CasClient extends EventEmitter {
  private readonly config: CasClientConfig
  private socket: Socket | null = null
  private recvBuf = Buffer.alloc(0)
  private state: CasClientState = 'disconnected'

  constructor(config: CasClientConfig) {
    super()
    this.config = config
  }

  get connected(): boolean {
    return this.state === 'connected'
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
        reject(new Error('CAS connection timeout'))
      }, 5_000)

      socket.once('connect', () => {
        clearTimeout(timeout)
        this.state = 'connected'
        this.emit('connect')
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

  send(msg: V3Message): void {
    if (!this.socket || this.state !== 'connected') {
      throw new Error('Not connected')
    }
    const frame = encodeV3Message(msg)
    this.socket.write(frame)
  }

  sendPlayRequest(params: PlayRequestParams): void {
    this.send(buildPlayRequest(params))
  }

  sendTeardown(params: TeardownParams): void {
    this.send(buildTeardown(params))
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.state = 'disconnected'
    this.recvBuf = Buffer.alloc(0)
  }

  // -- Private ----------------------------------------------------------------

  private onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk])
    this.drain()
  }

  /**
   * Drain buffered data, extracting complete V3 frames.
   *
   * Frame length is determined by:
   *   1. Read the 12-byte header (byte 10 = headerLen).
   *   2. Scan TLV attributes after the header to find total body length.
   *
   * Since V3 frames have no explicit "total length" field, we walk the TLV
   * body to determine where the frame ends. As a simpler heuristic we use the
   * attribute encoding: each TLV is tag(1) + len(1) + value(len), except for
   * tag 0x07 with is2BLen where length is 2 bytes.
   */
  private drain(): void {
    while (this.recvBuf.length >= V3_HEADER_LEN) {
      const headerLen = this.recvBuf[10]
      if (headerLen < V3_HEADER_LEN) {
        this.emit('error', new Error(`Invalid headerLen: ${headerLen}`))
        this.recvBuf = Buffer.alloc(0)
        return
      }

      // Determine body length by walking TLV attributes
      const is2BLen = (this.recvBuf[1] & 0x02) !== 0
      const bodyLen = this.measureBody(headerLen, is2BLen)
      if (bodyLen < 0) {
        return // need more data
      }

      const totalFrameLen = headerLen + bodyLen
      if (this.recvBuf.length < totalFrameLen) {
        return // need more data
      }

      const frameBuf = Buffer.from(this.recvBuf.subarray(0, totalFrameLen))
      this.recvBuf = Buffer.from(this.recvBuf.subarray(totalFrameLen))

      try {
        const msg = decodeV3Message(frameBuf)
        this.emit('message', msg)
      } catch (err) {
        this.emit('error', err)
      }
    }
  }

  /**
   * Walk TLV attributes starting at `headerLen` offset to measure total body
   * length. Returns -1 if the buffer is incomplete.
   */
  private measureBody(headerLen: number, is2BLen: boolean): number {
    let offset = headerLen
    while (offset < this.recvBuf.length) {
      if (offset + 1 > this.recvBuf.length) return -1

      const tag = this.recvBuf[offset]

      // End marker
      if (tag === AttrTag.END_MARKER) {
        if (offset + 2 > this.recvBuf.length) return -1
        return offset + 2 - headerLen
      }

      if (tag === 0x07 && is2BLen) {
        if (offset + 3 > this.recvBuf.length) return -1
        const len = this.recvBuf.readUInt16BE(offset + 1)
        offset += 3 + len
      } else {
        if (offset + 2 > this.recvBuf.length) return -1
        const len = this.recvBuf[offset + 1]
        offset += 2 + len
      }
    }
    // Reached end of buffer without finding all data — could be complete if
    // the last attribute ended exactly at the buffer boundary.
    return offset - headerLen
  }
}
