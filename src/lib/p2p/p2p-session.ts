/**
 * P2P Streaming Session — connects to device via Hikvision P2P protocol.
 *
 * Flow (from iVMS-4200 Ghidra RE):
 * 1. P2P_SETUP (0x0B02) → register with P2P servers
 * 2. Wait for device hole-punch (0x0C00) → respond with 0x0C01 (10x)
 * 3. PLAY_REQUEST (0x0C02) → direct to device + via TRANSFOR_DATA relay
 * 4. Receive video data (SRT/UDP) and emit 'data' events
 */

import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import { createCipheriv, randomUUID } from 'node:crypto'
import { encodeV3Message, decodeV3Message, defaultMask, Opcode, crc8, type V3Message } from './v3-protocol'

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
  p2pKey: Buffer          // 32-byte P2P server key (outer encryption)
  p2pLinkKey: Buffer      // 32-byte P2P link key (inner PLAY_REQUEST encryption)
  p2pKeyVersion: number   // P2P key version (e.g. 101)
  p2pKeySaltIndex: number
  p2pKeySaltVer: number
  sessionToken: string    // JWT client session
  userId: string
  clientId: number        // Client ID for expand header
  channelNo: number
  streamType: number      // 0=main, 1=sub
  streamTokens: string[]  // Stream auth tokens from /api/user/token/get
  localPublicIp?: string  // Public IP for P2P_SETUP registration
  busType?: number        // 1=live preview (default), 2=playback
  startTime?: string      // Playback start time (YYYY-MM-DDTHH:MM:SS)
  stopTime?: string       // Playback stop time (YYYY-MM-DDTHH:MM:SS)
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

/** AES-128-CBC IV used for ALL V3 encryption: "01234567" + 8 zero bytes */
const HIK_AES_IV = Buffer.from('30313233343536370000000000000000', 'hex')

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
  // Device peer address — updated when device punches through (0x0C00)
  private devicePeerIp: string | null = null
  private devicePeerPort: number | null = null
  private punchComplete = false
  // Session key shared between P2P_SETUP and PLAY_REQUEST
  private currentSessionKey: string = ''
  // SRT handshake state
  private srtSynCookie: number | null = null
  private srtPeerSocketId: number | null = null

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
        resolve()
      })
      this.socket!.once('error', reject)
    })

    this.transition('punching')

    // Step 1: P2P_SETUP → wait for device punch (0x0C00 → 0x0C01)
    await this.contactP2PServers()

    // Step 2: After punch completes, send PLAY_REQUEST
    this.transition('setup')
    await this.sendPlayRequest()

    // Step 3: Start keepalive timer (device expects periodic keepalives)
    this.keepaliveInterval = setInterval(() => this.sendKeepalive(), 15_000)

    // Step 4: Wait for device to send CONNECTION_CONTROL (0x8000)
    // VPS test confirmed: device sends 0x8000 after receiving PLAY_REQUEST.
    // handleConnectionControl() responds and establishes the data session.
    await this.waitForDataSession(15_000)

    // Step 5: Send SESSION_SETUP (0x7534) with V3 0x0C00 to start video
    // The SRT library does this internally in the native code, but since we
    // use raw UDP, we need to do it explicitly to tell the device to start streaming.
    if (this.dataSessionId !== 0) {
      this.sendSessionSetup()
    }
    this.transition('streaming')
  }

  stop(): void {
    if (this.state === 'stopped') return

    // Send TEARDOWN (0x0C04) to cleanly release the device session
    if (this.socket && this.dataSessionId !== 0) {
      try { this.sendTeardown() } catch {}
    }

    // Send SRT shutdown to cleanly release the device's stream slot
    if (this.srtPeerSocketId) {
      const shutdown = Buffer.alloc(16)
      shutdown.writeUInt16BE(0x8005, 0) // F=1, control type=5 (shutdown)
      shutdown.writeUInt16BE(0, 2)
      shutdown.writeUInt32BE(0, 4)
      shutdown.writeUInt32BE(timestamp32(), 8)
      shutdown.writeUInt32BE(this.srtPeerSocketId, 12)
      try { this.sendToDevice(shutdown) } catch {}
    }

    this.stopSrtAckTimer()
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval)
      this.keepaliveInterval = null
    }

    // Defer socket close to let queued UDP sends (TEARDOWN, SRT shutdown) flush
    const sock = this.socket
    this.socket = null
    this.transition('stopped')
    if (sock) {
      setImmediate(() => { try { sock.close() } catch {} })
    }
  }

  // -- P2P Server Contact --

  private async contactP2PServers(): Promise<void> {
    // Step 1: P2P_SETUP (0x0B02) — registers "link" with P2P server
    const setup = this.buildP2PSetupRequest()
    for (const server of this.config.p2pServers) {
      this.sendTo(setup, server.port, server.host)
    }

    // Step 2: Wait for device punch-through (0x0C00)
    // After P2P_SETUP, the server notifies the device, which sends us 0x0C00.
    // Our handleV3Response() will catch it and send 0x0C01 response.
    console.log('[P2P] P2P_SETUP sent, waiting for device punch (0x0C00)...')
    await this.waitForPunch(10_000)

    if (this.punchComplete) {
      console.log(`[P2P] Hole-punch complete! Device at ${this.devicePeerIp}:${this.devicePeerPort}`)
    } else {
      console.log('[P2P] Punch timeout — device did not send 0x0C00. Trying direct punch...')
      // Fallback: send empty packets to the known device address
      this.holePunch()
      await delay(2000)
    }
  }

  private async sendPlayRequest(): Promise<void> {
    // Path A: Send PLAY_REQUEST directly to device (via punched connection)
    if (this.punchComplete && this.devicePeerIp && this.devicePeerPort) {
      const directMsg = this.buildDirectPlayRequest()
      for (let i = 0; i < 3; i++) {
        this.sendTo(directMsg, this.devicePeerPort, this.devicePeerIp)
      }
      console.log(`[P2P] PLAY_REQUEST sent directly to device ${this.devicePeerIp}:${this.devicePeerPort}`)
    }

    // Path B: Send PLAY_REQUEST via P2P server relay (TRANSFOR_DATA wrapper)
    const relayMsg = this.buildP2PServerRequest()
    for (const server of this.config.p2pServers) {
      this.sendTo(relayMsg, server.port, server.host)
      console.log(`[P2P] PLAY_REQUEST sent via relay ${server.host}:${server.port}`)
    }

    await delay(3000)
  }

  private sendTeardown(): void {
    const teardownBody = this.buildTeardownBody()
    const innerV3 = this.buildInnerV3Message(teardownBody, Opcode.TEARDOWN)

    // Path A: Send directly to device
    if (this.devicePeerIp && this.devicePeerPort) {
      this.sendTo(innerV3, this.devicePeerPort, this.devicePeerIp)
    }

    // Path B: Send via P2P server relay (TRANSFOR_DATA wrapper)
    const outerBody = this.buildOuterBody(innerV3)
    const outerKey = this.config.p2pKey.subarray(0, 16)
    const outerCipher = createCipheriv('aes-128-cbc', outerKey, HIK_AES_IV)
    const encrypted = Buffer.concat([outerCipher.update(outerBody), outerCipher.final()])

    const seq = ++this.seqNum
    const mask = 0xda
    const header = Buffer.alloc(12)
    header[0] = 0xe2
    header[1] = mask
    header.writeUInt16BE(Opcode.TRANSFOR_DATA, 2)
    header.writeUInt32BE(seq, 4)
    header.writeUInt16BE(0x6234, 8)
    header[10] = 0x0c
    header[11] = 0x00
    const full = Buffer.concat([header, encrypted])
    full[11] = crc8(full)

    for (const server of this.config.p2pServers) {
      this.sendTo(full, server.port, server.host)
    }
  }

  private buildTeardownBody(): Buffer {
    const attrs: Buffer[] = []
    const writeTlv = (tag: number, value: Buffer) => {
      const hdr = Buffer.alloc(2)
      hdr[0] = tag
      hdr[1] = value.length
      attrs.push(hdr, value)
    }

    writeTlv(0x05, Buffer.from(this.currentSessionKey))
    writeTlv(0x76, Buffer.from([this.config.busType ?? 1]))
    const channelBuf = Buffer.alloc(2)
    channelBuf.writeUInt16BE(this.config.channelNo)
    writeTlv(0x77, channelBuf)
    writeTlv(0x78, Buffer.from([this.config.streamType]))
    const sessionBuf = Buffer.alloc(4)
    sessionBuf.writeUInt32BE(this.dataSessionId)
    writeTlv(0x84, sessionBuf)

    return Buffer.concat(attrs)
  }

  private waitForPunch(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.punchComplete) {
        resolve()
        return
      }

      const timeout = setTimeout(() => {
        this.removeListener('punchComplete', onPunch)
        resolve()
      }, timeoutMs)

      const onPunch = () => {
        clearTimeout(timeout)
        resolve()
      }
      this.once('punchComplete', onPunch)
    })
  }

  private buildP2PSetupRequest(): Buffer {
    // Build P2P_SETUP (0x0B02) — standalone V3 message (NOT wrapped in TRANSFOR_DATA).
    // This registers the client "link" with the P2P server.
    //
    // From Ghidra RE of ComposeMsgBody case 0x0B02:
    //   ComposeTransfor() — inline sub-TLVs (0x71, 0x72, 0x75, 0x7f, 0x74, 0x73, 0x8c)
    //   tag=0x05: session key
    //   tag=0x06: additional session info
    //   tag=0x00: device serial
    //   busType byte
    //   tag=0x04: encoded data
    //   tag=0xFF: end marker

    const serial = this.config.deviceSerial
    const b64Serial = Buffer.from(serial).toString('base64')
    const now = new Date()
    const dateStr = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0')
    const rand5 = String(Math.floor(10000 + Math.random() * 90000))
    const sessionKey = b64Serial + String(this.config.channelNo) + dateStr + rand5
    this.currentSessionKey = sessionKey // Store for PLAY_REQUEST reuse
    const localAddr = this.socket?.address()
    const localPort = localAddr?.port || 0
    // Use configured public IP if available, fall back to socket address
    const localIp = this.config.localPublicIp || localAddr?.address || '0.0.0.0'

    // Build body (order from captured P2P_SETUP pcap):
    //   tag=0x05: session key (32 bytes)
    //   tag=0x06: userId (32 bytes)
    //   tag=0x00: device serial
    //   tag=0x04: protocol version (value=3)
    //   tag=0xFF: ComposeTransfor sub-TLVs as value
    const parts: Buffer[] = []
    const writeTlv = (tag: number, value: Buffer) => {
      parts.push(Buffer.from([tag, value.length]), value)
    }

    writeTlv(0x05, Buffer.from(sessionKey))         // session key
    writeTlv(0x06, Buffer.from(this.config.userId))  // userId
    writeTlv(0x00, Buffer.from(serial))              // device serial
    writeTlv(0x04, Buffer.from([0x03]))              // protocol_version=3

    // ComposeTransfor sub-TLVs wrapped in tag=0xFF
    const transforParts: Buffer[] = []
    const writeTransforTlv = (tag: number, value: Buffer) => {
      transforParts.push(Buffer.from([tag, value.length]), value)
    }
    writeTransforTlv(0x71, Buffer.from([this.config.busType ?? 1]))  // busType (1=preview, 2=playback)
    writeTransforTlv(0x72, Buffer.from([0x03]))  // protocol flag (value=3 from capture)
    writeTransforTlv(0x75, Buffer.from([0x01]))  // flag (value=1 from capture)
    writeTransforTlv(0x7f, Buffer.from([0x0a]))  // NAT type/flag (value=0x0a from capture)
    writeTransforTlv(0x74, Buffer.from(`${localIp}:${localPort}`))  // local address
    const clientIdBuf = Buffer.alloc(4)
    clientIdBuf.writeUInt32BE(this.config.clientId)
    writeTransforTlv(0x8c, clientIdBuf)          // clientId (from iVMS-4200 RE: tag=0x8C = clientId)
    const transforData = Buffer.concat(transforParts)
    writeTlv(0xff, transforData)

    const body = Buffer.concat(parts)

    // P2P_SETUP (0x0B02) is NOT in the "important opcodes" range (0x0c02-0x0c18).
    // BuildSendMsg uses P2PServerKey (not P2PLinkKey) and NO expand header for these opcodes.
    const serverKey = this.config.p2pKey.subarray(0, 16)
    const iv = HIK_AES_IV
    const cipher = createCipheriv('aes-128-cbc', serverKey, iv)
    const encryptedBody = Buffer.concat([cipher.update(body), cipher.final()])

    // Build V3 header — NO expand header (expandHdr bit = 0)
    // P2P_SETUP uses seq=0 (from pcap capture)
    const seq = 0
    const mask = 0xda // encrypt=1, saltVer=1, saltIdx=3, expandHdr=0, is2BLen=1
    const header = Buffer.alloc(12)
    header[0] = 0xe2
    header[1] = mask
    header.writeUInt16BE(0x0b02, 2) // P2P_SETUP
    header.writeUInt32BE(seq, 4)
    header.writeUInt16BE(0x6234, 8)
    header[10] = 0x0c // headerLen=12 (no expand header)
    header[11] = 0x00

    const full = Buffer.concat([header, encryptedBody])
    full[11] = crc8(full)
    return full
  }

  private buildP2PServerRequest(): Buffer {
    // Build V3 TRANSFOR_DATA (0x0b04) for P2P servers.
    //
    // Structure (from Ghidra RE of ComposeTransfor + ComposeMsgBody + BuildSendMsg):
    //
    // Outer body = routing header (11B) + tag=0x07 (inner V3 message)
    // Inner V3 = 12B header + 48B expand header + AES-encrypted PLAY_REQUEST body
    //
    // The routing header contains the device serial fragment and is static.
    // tag=0x07 uses 2-byte big-endian length.
    //
    // Inner V3 header: magic=0xe2, mask=0xde (encrypt+expandHdr+is2BLen),
    //   msgType=0x0c02 (PLAY_REQUEST), reserved=0x6234
    //
    // Expand header (48 bytes): tag=0x00 (keyVer), tag=0x01 (userId),
    //   tag=0x02 (clientId), tag=0x03 (channel)
    //
    // PLAY_REQUEST body (AES-128-CBC encrypted with P2PLinkKey, IV="01234567\0\0\0\0\0\0\0\0"):
    //   tag=0x76 busType, tag=0x05 sessionKey, tag=0x78 streamType,
    //   tag=0x77 channel, tag=0x7e streamSession, tag=0x7d value,
    //   tag=0x7a startTime, tag=0x7b stopTime, tag=0x83 serial,
    //   tag=0xb2 UUID, tag=0xb3 timestamp

    const innerBody = this.buildPlayRequestBody()
    const innerV3 = this.buildInnerV3Message(innerBody)
    const outerBody = this.buildOuterBody(innerV3)

    // AES-128-CBC encrypt outer body with P2PServerKey
    const outerKey = this.config.p2pKey.subarray(0, 16)
    const outerIv = HIK_AES_IV
    const outerCipher = createCipheriv('aes-128-cbc', outerKey, outerIv)
    const encrypted = Buffer.concat([outerCipher.update(outerBody), outerCipher.final()])

    // Build outer V3 header
    const seq = ++this.seqNum
    const mask = 0xda // encrypt=1, saltVer=1, saltIdx=3, expandHdr=0, is2BLen=1
    const header = Buffer.alloc(12)
    header[0] = 0xe2
    header[1] = mask
    header.writeUInt16BE(Opcode.TRANSFOR_DATA, 2)
    header.writeUInt32BE(seq, 4)
    header.writeUInt16BE(0x6234, 8)
    header[10] = 0x0c
    header[11] = 0x00

    const full = Buffer.concat([header, encrypted])
    full[11] = crc8(full)
    return full
  }

  // -- Inner Body Builders --

  private buildPlayRequestBody(): Buffer {
    const serial = this.config.deviceSerial
    // Reuse the session key from P2P_SETUP — device expects matching key
    const sessionKey = this.currentSessionKey
    const busType = this.config.busType ?? 1 // 1=preview, 2=playback
    const now = new Date()

    // Format timestamps — use config times for playback, auto for preview
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const startTime = this.config.startTime ?? `${todayStr}T00:00:00`
    const nowTime = this.config.stopTime ?? `${todayStr}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

    // Build TLV attributes for PLAY_REQUEST (0x0c02)
    const attrs: Buffer[] = []
    const writeTlv = (tag: number, value: Buffer) => {
      const hdr = Buffer.alloc(2)
      hdr[0] = tag
      hdr[1] = value.length
      attrs.push(hdr, value)
    }

    writeTlv(0x76, Buffer.from([busType]))                       // busType (1=preview, 2=playback)
    writeTlv(0x05, Buffer.from(sessionKey))                      // session key
    writeTlv(0x78, Buffer.from([this.config.streamType]))        // streamType
    writeTlv(0x77, (() => { const b = Buffer.alloc(2); b.writeUInt16BE(this.config.channelNo); return b })())
    writeTlv(0x7e, (() => { const b = Buffer.alloc(4); b.writeUInt32BE(this.sessionCounter + 1); return b })())
    writeTlv(0x7d, (() => { const b = Buffer.alloc(4); b.writeUInt32BE(180); return b })())
    writeTlv(0x7a, Buffer.from(startTime))                       // start time
    writeTlv(0x7b, Buffer.from(nowTime))                         // stop time
    writeTlv(0x83, Buffer.from(serial))                          // device serial
    writeTlv(0xb2, Buffer.from(randomUUID()))                     // session UUID
    writeTlv(0xb3, Buffer.from(String(Date.now())))              // timestamp ms

    return Buffer.concat(attrs)
  }

  private buildInnerV3Message(playRequestBody: Buffer, opcode: number = Opcode.PLAY_REQUEST): Buffer {
    // Encrypt body with P2PLinkKey
    const linkKey = this.config.p2pLinkKey.subarray(0, 16)
    const innerIv = HIK_AES_IV
    const innerCipher = createCipheriv('aes-128-cbc', linkKey, innerIv)
    const encryptedBody = Buffer.concat([innerCipher.update(playRequestBody), innerCipher.final()])

    // Build expand header: keyVersion, userId, clientId, channel
    const expandAttrs: Buffer[] = []
    const writeTlv = (tag: number, value: Buffer) => {
      expandAttrs.push(Buffer.from([tag, value.length]), value)
    }
    const keyVerBuf = Buffer.alloc(2)
    keyVerBuf.writeUInt16BE(this.config.p2pKeyVersion)
    writeTlv(0x00, keyVerBuf)                                     // key version
    writeTlv(0x01, Buffer.from(this.config.userId))               // userId (32 ASCII hex chars)
    const clientIdBuf = Buffer.alloc(4)
    clientIdBuf.writeUInt32BE(this.config.clientId)
    writeTlv(0x02, clientIdBuf)                                   // client ID
    const channelBuf = Buffer.alloc(2)
    channelBuf.writeUInt16BE(this.config.channelNo)
    writeTlv(0x03, channelBuf)                                    // channel

    const expandHeader = Buffer.concat(expandAttrs)
    const headerLen = 12 + expandHeader.length

    // Build inner V3 header
    const innerSeq = ++this.seqNum
    const innerHeader = Buffer.alloc(12)
    innerHeader[0] = 0xe2
    innerHeader[1] = 0xde // encrypt=1, saltVer=1, saltIdx=3, expandHdr=1, is2BLen=1
    innerHeader.writeUInt16BE(opcode, 2)
    innerHeader.writeUInt32BE(innerSeq, 4)
    innerHeader.writeUInt16BE(0x6234, 8) // reserved
    innerHeader[10] = headerLen
    innerHeader[11] = 0x00 // CRC placeholder

    const innerFull = Buffer.concat([innerHeader, expandHeader, encryptedBody])
    innerFull[11] = crc8(innerFull)
    return innerFull
  }

  private buildOuterBody(innerV3: Buffer): Buffer {
    // Outer body for TRANSFOR_DATA (0x0B04):
    //   tag=0x00: device serial (ComposeTransfor output = just serial for routing)
    //   tag=0x07: inner V3 message (2-byte BE length)
    const serial = this.config.deviceSerial
    const serialTag = Buffer.alloc(2 + serial.length)
    serialTag[0] = 0x00 // tag
    serialTag[1] = serial.length // length
    Buffer.from(serial).copy(serialTag, 2)

    // tag=0x07 with 2-byte BE length (inner V3 message as value)
    const tag07header = Buffer.alloc(3)
    tag07header[0] = 0x07
    tag07header.writeUInt16BE(innerV3.length, 1)

    return Buffer.concat([serialTag, tag07header, innerV3])
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

    // Build session key: base64(serial) + channel + YYYYMMDDHHmmss + 5-digit random
    const now = new Date()
    const dateStr = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0')
    const rand5 = String(Math.floor(10000 + Math.random() * 90000))
    const sessionKey = b64Serial + String(this.config.channelNo) + dateStr + rand5

    // Build embedded V3 message (unencrypted, cmd 0x0c00)
    const v3 = encodeV3Message({
      msgType: 0x0c00,
      seqNum: ++this.seqNum,
      reserved: 0x6234, // Protocol version constant
      mask: defaultMask({
        saltVersion: this.config.p2pKeySaltVer,
        saltIndex: this.config.p2pKeySaltIndex,
        is2BLen: true,
      }),
      attributes: [
        { tag: 0x05, value: Buffer.from(sessionKey) },
        { tag: 0x71, value: Buffer.from([0x01]) },
        { tag: 0x82, value: Buffer.alloc(4) },
      ],
    })

    // Build 7534 packet: 28-byte header + V3 message
    const sessionId = ++this.sessionCounter
    const pkt = Buffer.alloc(28 + v3.length)
    pkt.writeUInt16BE(PktType.SESSION_SETUP, 0)
    pkt.writeUInt16BE(sessionId & 0xffff, 2)
    pkt.writeUInt16BE(0xc000, 4) // SYN flags
    pkt.writeUInt16BE(this.seqNum & 0xffff, 6)
    pkt.writeUInt32BE(timestamp32(), 8)
    pkt.writeUInt32BE(this.sourceId, 12)
    pkt[16] = 0x80
    pkt[17] = 0x7f
    // Bytes 18-27: zeros (already)
    v3.copy(pkt, 28)

    this.sendToDevice(pkt)
    setTimeout(() => this.sendToDevice(pkt), 200)
    setTimeout(() => this.sendToDevice(pkt), 500)
  }

  // -- Connection Control (0x8000) --

  // sendConnectionControl replaced by SRT handshake (handleSrtInduction/handleSrtConclusion)

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

  // -- Packet Handler --

  private handlePacket(buf: Buffer, _fromAddr: string, _fromPort: number): void {
    console.log(`[P2P] recv ${buf.length}B from ${_fromAddr}:${_fromPort} type=0x${buf.length >= 2 ? buf.readUInt16BE(0).toString(16) : '??'}`)

    if (buf.length < 2) return

    // V3 messages from P2P servers (magic byte upper nibble = 0xE)
    if ((buf[0] >> 4) === 0xe && buf.length >= 12) {
      this.handleV3Response(buf, _fromAddr, _fromPort)
      return
    }

    const type = buf.readUInt16BE(0)

    // Known control types
    // SRT keepalive (0x8001) — respond with SRT keepalive
    if (type === 0x8001) {
      // SRT keepalive: echo back with our socket ID
      const resp = Buffer.alloc(16)
      resp.writeUInt16BE(0x8001, 0) // F=1, type=1 (keepalive)
      resp.writeUInt16BE(0, 2)
      resp.writeUInt32BE(0, 4)
      resp.writeUInt32BE(timestamp32(), 8)
      resp.writeUInt32BE(this.srtPeerSocketId ?? 0, 12)
      this.sendToDevice(resp)
      return
    }

    // Custom keepalive (0x8001 from our PktType)
    if (type === PktType.KEEPALIVE && type !== 0x8001) {
      this.sendKeepalive()
      return
    }

    // SRT ACK (0x8002), light ACK (0x8005), ACK2 (0x8006) — no action needed
    if (type === 0x8002 || type === 0x8005 || type === 0x8006) {
      return
    }

    // SRT NAK (0x8003) — device requesting retransmission (we can't retransmit, just log)
    if (type === 0x8003) {
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

    // SRT data packet: first bit = 0 (not control), 16+ bytes, from device
    // SRT data header: seqNum(4B) + msgNo(4B) + timestamp(4B) + destSocketId(4B)
    if (buf.length >= 16 && (buf[0] & 0x80) === 0 && this.dataSessionId !== 0) {
      this.handleSrtDataPacket(buf)
      return
    }

    // Unknown packet — log for debugging
    if (buf.length > 4) {
      console.log(`[P2P] Unhandled packet ${buf.length}B type=0x${type.toString(16)} first16=${buf.subarray(0, Math.min(16, buf.length)).toString('hex')}`)
    }
  }

  private handleV3Response(buf: Buffer, fromAddr: string, fromPort: number): void {
    // Check encrypt bit (byte 1, bit 7) to decide decryption
    const isEncrypted = (buf[1] & 0x80) !== 0
    let msg: V3Message | null = null
    try {
      msg = isEncrypted
        ? decodeV3Message(buf, this.config.p2pKey)
        : decodeV3Message(buf)
    } catch (err) {
      console.log(`[P2P] V3 decode error: ${err instanceof Error ? err.message : err}`)
      return
    }

    console.log(`[P2P] V3 response from ${fromAddr}:${fromPort} cmd=0x${msg.msgType.toString(16)} attrs=${msg.attributes.length}`)
    for (const attr of msg.attributes) {
      console.log(`  attr tag=0x${attr.tag.toString(16)} len=${attr.value.length} val=${attr.value.toString('hex')}`)
    }

    // Handle device hole-punch request (0x0C00)
    if (msg.msgType === Opcode.PUNCH_REQUEST) {
      this.handlePunchRequest(msg, fromAddr, fromPort)
      return
    }

    // Handle device punch response (0x0C01)
    if (msg.msgType === Opcode.PUNCH_RESPONSE) {
      console.log(`[P2P] Received punch response from ${fromAddr}:${fromPort}`)
      return
    }

    this.emit('v3message', msg)
  }

  private handlePunchRequest(msg: V3Message, fromAddr: string, fromPort: number): void {
    console.log(`[P2P] Device punch request (0x0C00) from ${fromAddr}:${fromPort}`)

    // Update device peer address to the actual source of the punch
    this.devicePeerIp = fromAddr
    this.devicePeerPort = fromPort

    // Send punch response (0x0C01) back to device — 10 times for reliability
    // From iVMS-4200 RE: CCasP2PClient::HandlePunchReqPackage sends 10x
    const response = this.buildPunchResponse(msg)
    for (let i = 0; i < 10; i++) {
      this.sendTo(response, fromPort, fromAddr)
    }
    console.log(`[P2P] Sent 10x punch response (0x0C01) to ${fromAddr}:${fromPort}`)

    // Mark punch as complete
    this.punchComplete = true
    this.emit('punchComplete')
  }

  private buildPunchResponse(_punchRequest: V3Message): Buffer {
    // Build 0x0C01 punch response — send our session key to confirm the match.
    // From iVMS-4200 RE: the response is an unencrypted V3 message.
    // The native code verifies the session UUID matches, then sends a response
    // with the client's own session key and status.
    return encodeV3Message({
      msgType: Opcode.PUNCH_RESPONSE,
      seqNum: ++this.seqNum,
      reserved: 0x6234,
      mask: defaultMask({
        saltVersion: this.config.p2pKeySaltVer,
        saltIndex: this.config.p2pKeySaltIndex,
        is2BLen: true,
      }),
      attributes: [
        { tag: 0x05, value: Buffer.from(this.currentSessionKey) },
        { tag: 0x71, value: Buffer.from([0x01]) }, // busType=1 (preview)
      ],
    })
  }

  private buildDirectPlayRequest(): Buffer {
    // Build PLAY_REQUEST (0x0C02) for direct device communication.
    // This is the inner V3 message only (no TRANSFOR_DATA wrapper).
    // Uses P2PLinkKey encryption + expand header.
    const innerBody = this.buildPlayRequestBody()
    return this.buildInnerV3Message(innerBody)
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
    if (buf.length < 64) return

    // This is an SRT handshake packet (0x8000 = SRT control, type 0 = handshake)
    // SRT header: 16 bytes (F+type, subtype, typeInfo, timestamp, destSocketId)
    // SRT handshake body: 48 bytes starting at offset 16
    const srtVersion = buf.readUInt32BE(16)
    const srtExtension = buf.readUInt16BE(22)
    const initSeq = buf.readUInt32BE(24)
    const mtu = buf.readUInt32BE(28)
    const window = buf.readUInt32BE(32)
    const hsType = buf.readUInt32BE(36)
    const peerSocketId = buf.readUInt32BE(40)
    const synCookie = buf.readUInt32BE(44)

    console.log(`[SRT] Handshake: version=${srtVersion} ext=${srtExtension} type=${hsType} socketId=0x${peerSocketId.toString(16)} cookie=0x${synCookie.toString(16)} mtu=${mtu} window=${window}`)

    if (hsType === 1 && srtVersion === 4) {
      // SRT INDUCTION handshake — respond with our induction response
      this.handleSrtInduction(buf, peerSocketId, initSeq, mtu, window)
      return
    }

    if (hsType === 0xFFFFFFFF) {
      // SRT CONCLUSION handshake — connection established!
      this.handleSrtConclusion(buf, peerSocketId)
      return
    }

    // For other handshake types, log and extract data session
    console.log(`[SRT] Unhandled handshake type: ${hsType}`)
    if (initSeq !== 0 && this.dataSessionId === 0) {
      this.dataSessionId = initSeq
      this.emit('dataSessionEstablished', initSeq)
    }
  }

  private handleSrtInduction(buf: Buffer, peerSocketId: number, initSeq: number, mtu: number, window: number): void {
    // Generate a SYN cookie based on peer info
    const synCookie = (this.sourceId ^ peerSocketId ^ timestamp32()) >>> 0

    // Build SRT induction response
    const pkt = Buffer.alloc(64)
    // SRT control header
    pkt.writeUInt16BE(0x8000, 0)     // F=1, control type=0 (handshake)
    pkt.writeUInt16BE(0, 2)          // subtype
    pkt.writeUInt32BE(0, 4)          // type-specific info
    pkt.writeUInt32BE(timestamp32(), 8) // timestamp
    pkt.writeUInt32BE(peerSocketId, 12) // destination socket ID

    // SRT handshake body
    pkt.writeUInt32BE(5, 16)         // Version: 5 (SRT)
    pkt.writeUInt16BE(0, 20)         // Encryption: none
    pkt.writeUInt16BE(0x4a17, 22)    // Extension: SRT magic 0x4A17
    pkt.writeUInt32BE(initSeq, 24)   // Initial sequence number (echo back)
    pkt.writeUInt32BE(mtu, 28)       // MTU
    pkt.writeUInt32BE(window, 32)    // Window
    pkt.writeUInt32BE(1, 36)         // Handshake type: INDUCTION (response)
    pkt.writeUInt32BE(this.sourceId, 40) // Our socket ID
    pkt.writeUInt32BE(synCookie, 44) // SYN cookie

    this.srtSynCookie = synCookie
    this.srtPeerSocketId = peerSocketId

    this.sendToDevice(pkt)
    console.log(`[SRT] Sent induction response, cookie=0x${synCookie.toString(16)}, ourSocketId=0x${this.sourceId.toString(16)}`)
  }

  private handleSrtConclusion(_buf: Buffer, peerSocketId: number): void {
    console.log(`[SRT] CONCLUSION received (${_buf.length}B)`)

    // The SRT connection is now established
    // Set data session from the initial sequence number
    const initSeq = _buf.readUInt32BE(24)
    if (this.dataSessionId === 0) {
      this.dataSessionId = initSeq
      this.emit('dataSessionEstablished', initSeq)
    }

    // Send our conclusion response with SRT extension
    // The device's CONCLUSION includes ext type=1 (SRT_CMD_HSREQ) with SRT version
    // We need to include ext type=2 (SRT_CMD_HSRSP) in our response
    const pkt = Buffer.alloc(80) // 16 header + 48 body + 16 extension
    pkt.writeUInt16BE(0x8000, 0)
    pkt.writeUInt16BE(0, 2)
    pkt.writeUInt32BE(0, 4)
    pkt.writeUInt32BE(timestamp32(), 8)
    pkt.writeUInt32BE(peerSocketId, 12)

    pkt.writeUInt32BE(5, 16)         // Version: 5 (SRT)
    pkt.writeUInt16BE(0, 20)         // Encryption: none
    pkt.writeUInt16BE(1, 22)         // Extension: 1 (extensions present)
    pkt.writeUInt32BE(initSeq, 24)   // Initial sequence number
    pkt.writeUInt32BE(1500, 28)      // MTU
    pkt.writeUInt32BE(32, 32)        // Window
    pkt.writeUInt32BE(0xFFFFFFFF, 36) // Handshake type: CONCLUSION
    pkt.writeUInt32BE(this.sourceId, 40) // Our socket ID
    pkt.writeUInt32BE(this.srtSynCookie ?? 0, 44) // SYN cookie
    // Peer IP: zeros (or our IP)
    // bytes 48-63: peer IP (zeros)

    // SRT extension: SRT_CMD_HSRSP (type=2)
    pkt.writeUInt16BE(2, 64)         // Extension type: SRT_CMD_HSRSP
    pkt.writeUInt16BE(3, 66)         // Extension length: 3 (32-bit words)
    pkt.writeUInt32BE(0x00010401, 68) // SRT version 1.4.1 (matching device)
    pkt.writeUInt32BE(0x000000b4, 72) // Flags (matching device)
    pkt.writeUInt32BE(0, 76)         // Reserved

    this.sendToDevice(pkt)
    console.log(`[SRT] Sent conclusion response with extensions`)
  }

  private srtDataCount = 0
  private srtTotalBytes = 0

  private lastAckSeq = 0
  private srtAckInterval: ReturnType<typeof setInterval> | null = null
  private srtAckNumber = 1

  private startSrtAckTimer(): void {
    if (this.srtAckInterval) return
    // SRT spec: ACK every 10ms
    this.srtAckInterval = setInterval(() => {
      if (this.lastAckSeq > 0) {
        this.sendSrtAck(this.lastAckSeq)
      }
    }, 10)
  }

  private stopSrtAckTimer(): void {
    if (this.srtAckInterval) {
      clearInterval(this.srtAckInterval)
      this.srtAckInterval = null
    }
  }

  private handleSrtDataPacket(buf: Buffer): void {
    // SRT data packet format (16-byte header + payload):
    // Bytes 0-3:  F(1) + seqNum(31)  — F=0 for data
    // Bytes 4-7:  PP(2) + O(1) + KK(2) + R(1) + msgNum(26)
    // Bytes 8-11: Timestamp (microseconds)
    // Bytes 12-15: Destination Socket ID
    // Bytes 16+: Payload
    const seqNum = buf.readUInt32BE(0) & 0x7fffffff
    const payload = buf.subarray(16)

    this.srtDataCount++
    this.srtTotalBytes += payload.length

    if (this.srtDataCount <= 5 || this.srtDataCount % 100 === 0) {
      console.log(`[SRT-DATA] #${this.srtDataCount} seq=${seqNum} payload=${payload.length}B total=${this.srtTotalBytes}B first16=${payload.subarray(0, Math.min(16, payload.length)).toString('hex')}`)
    }

    // Track highest received sequence for ACK timer
    this.lastAckSeq = seqNum

    // Start the ACK timer on first data packet
    this.startSrtAckTimer()

    // Emit the payload for processing
    this.emit('data', payload)
  }

  private sendSrtAck(lastRecvSeq: number): void {
    // SRT ACK control packet (type=2)
    // From SRT spec: ACK informs sender about received data
    const pkt = Buffer.alloc(44) // Full ACK with 7 fields (28 bytes of ACK data)
    pkt.writeUInt16BE(0x8002, 0) // F=1, control type=2 (ACK)
    pkt.writeUInt16BE(0, 2)      // subtype
    pkt.writeUInt32BE(this.srtAckNumber++, 4) // ACK number (increments each ACK)
    pkt.writeUInt32BE(timestamp32(), 8) // timestamp
    pkt.writeUInt32BE(this.srtPeerSocketId ?? 0, 12) // dest socket ID

    // ACK data (from SRT spec section 3.2.2):
    pkt.writeUInt32BE((lastRecvSeq + 1) & 0x7fffffff, 16) // Last ACK'd seq + 1
    pkt.writeUInt32BE(8000, 20)  // RTT (microseconds) — reasonable estimate
    pkt.writeUInt32BE(1000, 24)  // RTT variance (microseconds)
    pkt.writeUInt32BE(8192, 28)  // Available buffer size (packets)
    pkt.writeUInt32BE(1000, 32)  // Packets receiving rate (per second)
    pkt.writeUInt32BE(100000, 36) // Estimated link capacity (packets/s)
    pkt.writeUInt32BE(0, 40)     // Receiving rate (bytes/s) — optional

    this.sendToDevice(pkt)
  }

  // -- Helpers --

  private sendToDevice(data: Buffer): void {
    if (!this.socket) return
    // Prefer punched peer address (from 0x0C00) over config address
    const ip = this.devicePeerIp ?? this.config.devicePublicIp
    const port = this.devicePeerPort ?? this.config.devicePublicPort
    console.log(`[P2P] send ${data.length}B to ${ip}:${port} type=0x${data.length >= 2 ? data.readUInt16BE(0).toString(16) : '??'}`)
    this.socket.send(data, port, ip)
  }

  private sendTo(data: Buffer, port: number, host: string): void {
    if (!this.socket) return
    console.log(`[P2P] send ${data.length}B to ${host}:${port}`)
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
