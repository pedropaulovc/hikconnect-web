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
  private _localPort = 0
  // Device peer address — updated when device punches through (0x0C00)
  private devicePeerIp: string | null = null
  private devicePeerPort: number | null = null
  private punchComplete = false
  // Session key shared between P2P_SETUP and PLAY_REQUEST
  private currentSessionKey: string = ''

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
    writeTransforTlv(0x71, Buffer.from([0x01]))  // busType=1 (preview)
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
    const now = new Date()

    // Format timestamps
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const startTime = `${todayStr}T00:00:00`
    const nowTime = `${todayStr}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

    // Build TLV attributes for PLAY_REQUEST (0x0c02)
    const attrs: Buffer[] = []
    const writeTlv = (tag: number, value: Buffer) => {
      const hdr = Buffer.alloc(2)
      hdr[0] = tag
      hdr[1] = value.length
      attrs.push(hdr, value)
    }

    writeTlv(0x76, Buffer.from([0x01]))                          // busType=1 (live preview)
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

  private buildInnerV3Message(playRequestBody: Buffer): Buffer {
    // Encrypt PLAY_REQUEST body with P2PLinkKey
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
    innerHeader.writeUInt16BE(0x0c02, 2) // PLAY_REQUEST (handles both live + playback)
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

  private buildTeardownRequest(): Buffer {
    // Build TEARDOWN (0x0c04) wrapped in TRANSFOR_DATA, same structure as PLAY_REQUEST
    // Reuse the session key from P2P_SETUP (same session)
    const attrs: Buffer[] = []
    const writeTlv = (tag: number, value: Buffer) => {
      attrs.push(Buffer.from([tag, value.length]), value)
    }
    writeTlv(0x05, Buffer.from(this.currentSessionKey))
    writeTlv(0x76, Buffer.from([0x01]))  // busType=1 (preview)
    writeTlv(0x77, (() => { const b = Buffer.alloc(2); b.writeUInt16BE(this.config.channelNo); return b })())
    writeTlv(0x78, Buffer.from([this.config.streamType]))
    writeTlv(0x84, Buffer.alloc(4))  // deviceSession=0

    const teardownBody = Buffer.concat(attrs)

    // Encrypt with P2PLinkKey
    const linkKey = this.config.p2pLinkKey.subarray(0, 16)
    const innerIv = Buffer.from('30313233343536370000000000000000', 'hex')
    const innerCipher = createCipheriv('aes-128-cbc', linkKey, innerIv)
    const encryptedBody = Buffer.concat([innerCipher.update(teardownBody), innerCipher.final()])

    // Build expand header
    const expandAttrs: Buffer[] = []
    const writeExpTlv = (tag: number, value: Buffer) => {
      expandAttrs.push(Buffer.from([tag, value.length]), value)
    }
    const keyVerBuf = Buffer.alloc(2)
    keyVerBuf.writeUInt16BE(this.config.p2pKeyVersion)
    writeExpTlv(0x00, keyVerBuf)
    writeExpTlv(0x01, Buffer.from(this.config.userId))
    const clientIdBuf = Buffer.alloc(4)
    clientIdBuf.writeUInt32BE(this.config.clientId)
    writeExpTlv(0x02, clientIdBuf)
    const channelBuf = Buffer.alloc(2)
    channelBuf.writeUInt16BE(this.config.channelNo)
    writeExpTlv(0x03, channelBuf)

    const expandHeader = Buffer.concat(expandAttrs)
    const headerLen = 12 + expandHeader.length

    // Inner V3 header with TEARDOWN opcode
    const innerSeq = ++this.seqNum
    const innerHeader = Buffer.alloc(12)
    innerHeader[0] = 0xe2
    innerHeader[1] = 0xde
    innerHeader.writeUInt16BE(0x0c04, 2) // TEARDOWN
    innerHeader.writeUInt32BE(innerSeq, 4)
    innerHeader.writeUInt16BE(0x6234, 8)
    innerHeader[10] = headerLen
    innerHeader[11] = 0x00

    const innerFull = Buffer.concat([innerHeader, expandHeader, encryptedBody])
    innerFull[11] = crc8(innerFull)

    // Wrap in outer TRANSFOR_DATA
    const outerBody = this.buildOuterBody(innerFull)
    const outerKey = this.config.p2pKey.subarray(0, 16)
    const outerIv = Buffer.from('30313233343536370000000000000000', 'hex')
    const outerCipher = createCipheriv('aes-128-cbc', outerKey, outerIv)
    const encrypted = Buffer.concat([outerCipher.update(outerBody), outerCipher.final()])

    const seq = ++this.seqNum
    const header = Buffer.alloc(12)
    header[0] = 0xe2
    header[1] = 0xda
    header.writeUInt16BE(Opcode.TRANSFOR_DATA, 2)
    header.writeUInt32BE(seq, 4)
    header.writeUInt16BE(0x6234, 8)
    header[10] = 0x0c
    header[11] = 0x00

    const full = Buffer.concat([header, encrypted])
    full[11] = crc8(full)
    return full
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
    console.log(`[P2P] recv ${buf.length}B from ${_fromAddr}:${_fromPort} type=0x${buf.length >= 2 ? buf.readUInt16BE(0).toString(16) : '??'}`)

    if (buf.length < 2) return

    // V3 messages from P2P servers (magic byte upper nibble = 0xE)
    if ((buf[0] >> 4) === 0xe && buf.length >= 12) {
      this.handleV3Response(buf, _fromAddr, _fromPort)
      return
    }

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
