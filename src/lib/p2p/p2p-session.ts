/**
 * P2P Streaming Session — connects to device via Hikvision P2P protocol.
 *
 * Flow:
 * 1. Send V3 TRANSFOR_DATA to P2P servers for NAT traversal
 * 2. UDP hole-punch to device public IP
 * 3. Exchange session setup (7534) and connection control (8000)
 * 4. Receive video data (41ab) packets
 * 5. Reassemble fragments and emit 'data' events
 */

import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import { encodeV3Message, decodeV3Message, defaultMask, Opcode } from './v3-protocol'

// -- Config --

export type P2PServer = {
  host: string
  port: number
}

export type P2PSessionConfig = {
  deviceSerial: string
  devicePublicIp: string
  devicePublicPort: number
  p2pServers: P2PServer[]
  p2pKey: Buffer          // 32-byte P2P server key
  p2pKeySaltIndex: number
  p2pKeySaltVer: number
  sessionToken: string    // JWT client session
  userId: string
  channelNo: number
  streamType: number      // 0=main, 1=sub
}

// -- Packet types --

const PktType = {
  SESSION_SETUP: 0x7534,
  CONN_CTRL:    0x8000,
  KEEPALIVE:    0x8001,
  DATA_ACK:     0x8002,
  DATA_REF:     0x8003,
  SHORT_ACK:    0x8006,
} as const

type SessionState = 'idle' | 'punching' | 'setup' | 'streaming' | 'stopped' | 'error'

function timestamp32(): number {
  return Number(BigInt(Date.now()) & 0xffffffffn)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// -- P2PSession --

export class P2PSession extends EventEmitter {
  private socket: UdpSocket | null = null
  private state: SessionState = 'idle'
  private config: P2PSessionConfig
  private sessionCounter = 0
  private seqNum = 0
  private sourceId = 0
  private dataSessionId = 0
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null
  private _localPort = 0

  constructor(config: P2PSessionConfig) {
    super()
    this.config = config
    this.sourceId = (Math.random() * 0xffffffff) >>> 0
  }

  get sessionState(): SessionState {
    return this.state
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start: state is ${this.state}`)
    }

    this.socket = createSocket('udp4')

    this.socket.on('message', (msg, rinfo) => {
      this.handlePacket(msg, rinfo.address, rinfo.port)
    })

    this.socket.on('error', (err) => {
      this.emit('error', err)
      this.transition('error')
    })

    await new Promise<void>((resolve, reject) => {
      this.socket!.bind(0, () => {
        const addr = this.socket!.address()
        this._localPort = addr.port
        resolve()
      })
      this.socket!.once('error', reject)
    })

    this.transition('punching')

    // Step 1: Contact P2P servers for NAT traversal
    await this.contactP2PServers()

    // Step 2: Hole-punch to device
    this.holePunch()

    // Step 3: Send session setup
    this.transition('setup')
    this.sendSessionSetup()

    // Step 4: Start keepalive timer
    this.keepaliveInterval = setInterval(() => this.sendKeepalive(), 15_000)

    // Wait for data session to establish (or timeout)
    await this.waitForDataSession(10_000)
    this.transition('streaming')
  }

  stop(): void {
    if (this.state === 'stopped') return

    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval)
      this.keepaliveInterval = null
    }

    this.socket?.close()
    this.socket = null
    this.transition('stopped')
  }

  // -- P2P Server Contact --

  private async contactP2PServers(): Promise<void> {
    const msg = this.buildP2PServerRequest()
    for (const server of this.config.p2pServers) {
      this.sendTo(msg, server.port, server.host)
    }
    // Wait briefly for P2P server responses
    await delay(500)
  }

  private buildP2PServerRequest(): Buffer {
    // V3 TRANSFOR_DATA message with encrypted session info
    const v3msg = encodeV3Message({
      msgType: Opcode.TRANSFOR_DATA,
      seqNum: ++this.seqNum,
      reserved: 0,
      mask: defaultMask({
        encrypt: true,
        saltIndex: this.config.p2pKeySaltIndex,
        saltVersion: this.config.p2pKeySaltVer,
      }),
      attributes: [
        { tag: 0x02, value: Buffer.from(this.config.userId) },          // CLIENT_ID
        { tag: 0x05, value: Buffer.from(this.config.sessionToken) },    // SESSION_KEY
        { tag: 0x03, value: Buffer.from(this.config.deviceSerial) },    // DEVICE_CHANNEL
      ],
    }, this.config.p2pKey)

    return v3msg
  }

  // -- Hole Punching --

  private holePunch(): void {
    // Send empty packets to punch through NAT
    const punch = Buffer.alloc(1)
    for (let i = 0; i < 5; i++) {
      this.sendToDevice(punch)
    }
  }

  // -- Session Setup (0x7534) --

  private sendSessionSetup(): void {
    const serial = this.config.deviceSerial
    const b64Serial = Buffer.from(serial).toString('base64')

    // Build embedded V3 message for the session setup
    const v3body = encodeV3Message({
      msgType: 0x0c00, // Session setup command
      seqNum: ++this.seqNum,
      reserved: 0,
      mask: defaultMask(),
      attributes: [
        { tag: 0x05, value: Buffer.from(b64Serial) },  // Base64 serial
        { tag: 0x71, value: Buffer.from([0x01]) },      // Preview mode
        { tag: 0x01, value: Buffer.from([0x01]) },       // Version
        { tag: 0x82, value: Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00]) }, // Port count
      ],
    })

    // Wrap in 7534 session packet
    const sessionId = ++this.sessionCounter
    const pkt = Buffer.alloc(16 + v3body.length)
    pkt.writeUInt16BE(PktType.SESSION_SETUP, 0)
    pkt.writeUInt16BE(sessionId, 2)
    pkt.writeUInt16BE(0xc000, 4) // SYN flags
    pkt.writeUInt16BE(this.seqNum, 6)
    pkt.writeUInt32BE(timestamp32(), 8)
    pkt.writeUInt32BE(this.sourceId, 12)
    v3body.copy(pkt, 16)

    // Pad to expected size
    const fullPkt = Buffer.alloc(Math.max(pkt.length, 83))
    pkt.copy(fullPkt)

    this.sendToDevice(fullPkt.subarray(0, pkt.length))

    // Retry a few times
    setTimeout(() => this.sendToDevice(fullPkt.subarray(0, pkt.length)), 200)
    setTimeout(() => this.sendToDevice(fullPkt.subarray(0, pkt.length)), 500)
  }

  // -- Connection Control (0x8000) --

  private sendConnectionControl(dataSessionId: number): void {
    const pkt = Buffer.alloc(64)
    pkt.writeUInt16BE(PktType.CONN_CTRL, 0)
    // bytes 2-7: zeros
    pkt.writeUInt32BE(timestamp32(), 8)
    pkt.writeUInt32BE(this.sourceId, 12)
    // Connection params
    pkt.writeUInt32BE(5, 16)          // param1
    pkt.writeUInt32BE(0x4a17, 20)     // param2
    pkt.writeUInt32BE(dataSessionId, 24)
    pkt.writeUInt32BE(1500, 28)       // MTU
    pkt.writeUInt32BE(0x20, 32)       // window size
    pkt.writeUInt32BE(1, 36)          // version
    pkt.writeUInt32BE(0x3e8, 40)      // param3
    pkt.writeUInt32BE(0x38, 44)       // param4
    pkt.writeUInt32BE(this.sourceId, 48)

    this.sendToDevice(pkt)
  }

  // -- Keepalive (0x8001) --

  private sendKeepalive(): void {
    const pkt = Buffer.alloc(20)
    pkt.writeUInt16BE(PktType.KEEPALIVE, 0)
    pkt.writeUInt32BE(timestamp32(), 8)
    pkt.writeUInt32BE(this.sourceId, 12)
    this.sendToDevice(pkt)
  }

  // -- Data ACK (0x8002) --

  private sendDataAck(ackedSessionId: number, seq: number): void {
    const pkt = Buffer.alloc(44)
    pkt.writeUInt16BE(PktType.DATA_ACK, 0)
    // bytes 2-7: sequence info
    pkt.writeUInt32BE(timestamp32(), 8)
    pkt.writeUInt32BE(this.sourceId, 12)
    pkt.writeUInt32BE(ackedSessionId, 16)
    // ACK metadata
    pkt.writeUInt32BE(0x3a0c, 20)
    pkt.writeUInt32BE(seq, 24)
    pkt.writeUInt32BE(0x1e, 28)
    pkt.writeUInt32BE(1, 32)
    pkt.writeUInt32BE(0x3e8, 36)
    pkt.writeUInt32BE(0x38, 40)

    this.sendToDevice(pkt)
  }

  // -- Short ACK (0x8006) --

  private sendShortAck(_seq: number): void {
    const pkt = Buffer.alloc(20)
    pkt.writeUInt16BE(PktType.SHORT_ACK, 0)
    // Copy seq into bytes 2-7
    pkt.writeUInt32BE(timestamp32(), 8)
    pkt.writeUInt32BE(this.sourceId, 12)
    this.sendToDevice(pkt)
  }

  // -- Packet Handler --

  private handlePacket(buf: Buffer, _fromAddr: string, _fromPort: number): void {
    if (buf.length < 2) return

    const type = buf.readUInt16BE(0)

    // Known control types
    if (type === PktType.KEEPALIVE) {
      this.sendKeepalive()
      return
    }

    if (type === PktType.DATA_ACK) {
      // Device acknowledging our packets — nothing to do
      return
    }

    if (type === PktType.SHORT_ACK) {
      return
    }

    if (type === PktType.SESSION_SETUP) {
      this.handleSessionSetup(buf)
      return
    }

    if (type === PktType.CONN_CTRL) {
      this.handleConnectionControl(buf)
      return
    }

    if (type === PktType.DATA_REF) {
      return
    }

    // Check if this is a data packet (session ID matches)
    if (this.dataSessionId !== 0) {
      const possibleSessionId = buf.readUInt32BE(0)
      if (possibleSessionId === this.dataSessionId) {
        this.handleDataPacket(buf)
        return
      }
    }

    // Unknown packet with known data session prefix — try as data
    if (buf.length > 16 && (type & 0xff00) !== 0x8000 && type !== PktType.SESSION_SETUP) {
      this.handlePossibleDataPacket(buf)
    }
  }

  private handleSessionSetup(buf: Buffer): void {
    // Device responded to our session setup
    // Extract any V3 message embedded in it
    if (buf.length < 28) return

    // Look for V3 magic (0xE2) in the packet
    for (let i = 16; i < buf.length - 12; i++) {
      if ((buf[i] >> 4) === 0xe) {
        try {
          const v3msg = decodeV3Message(buf.subarray(i))
          this.emit('v3message', v3msg)
        } catch {
          // Not a valid V3 message at this offset
        }
        break
      }
    }

    // Send ACK for the session
    const sessionId = buf.readUInt32BE(0)
    this.sendDataAck(sessionId, 0)
  }

  private handleConnectionControl(buf: Buffer): void {
    if (buf.length < 32) return

    // Extract data session ID from device's connection control
    const proposedDataSession = buf.readUInt32BE(24)
    if (proposedDataSession !== 0 && this.dataSessionId === 0) {
      this.dataSessionId = proposedDataSession
      // Respond with our own connection control
      this.sendConnectionControl(proposedDataSession)
      this.emit('dataSessionEstablished', proposedDataSession)
    }
  }

  private handleDataPacket(buf: Buffer): void {
    if (buf.length < 16) return

    const seq = buf.readUInt16BE(6)
    const payload = buf.subarray(16)

    // Send ACK
    this.sendShortAck(seq)

    // Emit the data payload
    this.emit('data', payload)
  }

  private handlePossibleDataPacket(buf: Buffer): void {
    // If we haven't established a data session yet, try to detect one
    if (this.dataSessionId === 0 && buf.length > 16) {
      const possibleId = buf.readUInt32BE(0)
      // Data session IDs don't start with 0x80 or 0x75
      if ((possibleId & 0xff000000) !== 0x80000000 && (possibleId & 0xffff0000) !== 0x75340000) {
        this.dataSessionId = possibleId
        this.emit('dataSessionEstablished', possibleId)
        this.handleDataPacket(buf)
      }
    }
  }

  // -- Helpers --

  private sendToDevice(data: Buffer): void {
    if (!this.socket) return
    this.socket.send(data, this.config.devicePublicPort, this.config.devicePublicIp)
  }

  private sendTo(data: Buffer, port: number, host: string): void {
    if (!this.socket) return
    this.socket.send(data, port, host)
  }

  private transition(next: SessionState): void {
    const prev = this.state
    this.state = next
    this.emit('stateChange', { from: prev, to: next })
  }

  private waitForDataSession(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.dataSessionId !== 0) {
        resolve()
        return
      }

      const timeout = setTimeout(() => {
        this.removeListener('dataSessionEstablished', onSession)
        this.removeListener('data', onData)
        // Even without explicit data session, try to stream
        resolve()
      }, timeoutMs)

      const onSession = () => {
        clearTimeout(timeout)
        this.removeListener('data', onData)
        resolve()
      }

      const onData = () => {
        clearTimeout(timeout)
        this.removeListener('dataSessionEstablished', onSession)
        resolve()
      }

      this.once('dataSessionEstablished', onSession)
      this.once('data', onData)
    })
  }
}
