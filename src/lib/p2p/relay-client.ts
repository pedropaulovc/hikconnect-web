/**
 * Relay Client — TCP streaming via Hikvision relay servers.
 *
 * Alternative to direct P2P/SRT when NAT traversal fails.
 * Protocol reverse-engineered from libCASClient.dll (iVMS-4200) via Ghidra:
 *   CRelayProto::BuildHeader, CRelayProto::ParseMsgBody, CRelayClient::SendClnConnectReq
 *
 * Flow:
 * 1. TCP connect to relay server (from API: /v3/streaming/query/relay/{serial}/{channel})
 * 2. Send ClnConnectReq with device serial, ticket, session key
 * 3. Receive ClnConnectRsp (confirms stream, may redirect)
 * 4. Receive video data as Hik-RTP frames (12B header + payload)
 * 5. Emit 'data' events with raw video payload
 */

import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import {
  generateKeyPair,
  deriveSharedSecret,
  ecdhDeriveSessionKey,
  buildEcdhReqPacket,
  spkiPublicKeyToRaw,
} from './crypto'

// -- Relay Protocol Constants --

const RELAY_MAGIC = 0x24 // '$'
const RELAY_HEADER_LEN = 12

/** Relay command bytes (from Ghidra CRelayProto::BuildHeader) */
const RelayCmd = {
  CLN_CONNECT_REQ: 0x0a,
  CLN_CONNECT_RSP: 0x0a, // same cmd, direction distinguishes
  KEEPALIVE: 0x05,
  DATA: 0xff,            // video data frames
  DEV_CLOSE: 0x0b,
} as const

/** Relay TLV tags (from Ghidra CRelayProto::ParseMsgBody) */
const RelayTag = {
  DEVICE_SERIAL: 0x01,
  TICKET: 0x02,
  SESSION_KEY: 0x03,
  FIELD_04: 0x04,
  CLIENT_TYPE: 0x05,
  PORT: 0x06,
  SEND_RATE: 0x07,
  FIELD_09: 0x09,
  FIELD_0A: 0x0a,
  FIELD_0B: 0x0b,
  RELAY_HOST: 0x0c,
  FIELD_0F: 0x0f,
  FIELD_10: 0x10,
} as const

// -- TLV Encoding/Decoding --

function encodeTlv(tag: number, value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value
  const header = Buffer.alloc(3)
  header[0] = tag
  header.writeUInt16BE(data.length, 1)
  return Buffer.concat([header, data])
}

function encodeIntTlv(tag: number, value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeInt32BE(value)
  return encodeTlv(tag, buf)
}

type TlvAttribute = { tag: number; value: Buffer }

function decodeTlvs(buf: Buffer): TlvAttribute[] {
  const attrs: TlvAttribute[] = []
  let offset = 0
  while (offset + 3 <= buf.length) {
    const tag = buf[offset]
    const len = buf.readUInt16BE(offset + 1)
    if (offset + 3 + len > buf.length) break
    attrs.push({ tag, value: buf.subarray(offset + 3, offset + 3 + len) })
    offset += 3 + len
  }
  return attrs
}

// -- Relay Frame Encoding/Decoding --

function encodeRelayFrame(cmd: number, seq: number, body: Buffer, encrypt = 0): Buffer {
  const header = Buffer.alloc(RELAY_HEADER_LEN)
  header[0] = RELAY_MAGIC
  header[1] = cmd
  header.writeUInt16BE(body.length, 2) // body length (first occurrence)
  header.writeUInt32BE(seq, 4)         // sequence number
  header.writeUInt16BE(body.length, 8) // body length (second occurrence)
  header[10] = 0x01                    // constant
  header[11] = encrypt                 // encryption flag
  return Buffer.concat([header, body])
}

type RelayFrame = {
  cmd: number
  seq: number
  bodyLen: number
  encrypt: number
  body: Buffer
  totalLen: number
}

function decodeRelayFrame(buf: Buffer): RelayFrame | null {
  if (buf.length < RELAY_HEADER_LEN) return null
  if (buf[0] !== RELAY_MAGIC) return null

  const cmd = buf[1]
  const bodyLen = buf.readUInt16BE(2)
  const seq = buf.readUInt32BE(4)
  const encrypt = buf[11]
  const totalLen = RELAY_HEADER_LEN + bodyLen

  if (buf.length < totalLen) return null

  return {
    cmd,
    seq,
    bodyLen,
    encrypt,
    body: buf.subarray(RELAY_HEADER_LEN, totalLen),
    totalLen,
  }
}

// -- Relay Client --

export type RelayClientConfig = {
  host: string
  port: number
  deviceSerial: string
  ticket: string
  sessionKey: string
  clientType?: number       // default: 55 (Hik-Connect mobile)
  serverPublicKey?: string  // Base64-encoded SPKI/DER P-256 public key from API
}

type RelayState = 'disconnected' | 'connecting' | 'connected' | 'streaming'

export class RelayClient extends EventEmitter {
  private socket: Socket | null = null
  private recvBuf = Buffer.alloc(0)
  private state: RelayState = 'disconnected'
  private seqNum = 0
  private config: RelayClientConfig
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null
  private ecdhSessionKey: Buffer | null = null

  constructor(config: RelayClientConfig) {
    super()
    this.config = config
  }

  get relayState(): RelayState {
    return this.state
  }

  async connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this.state}`)
    }
    this.state = 'connecting'

    return new Promise((resolve, reject) => {
      const socket = new Socket()
      this.socket = socket

      const timeout = setTimeout(() => {
        socket.destroy()
        this.state = 'disconnected'
        reject(new Error('Relay connection timeout'))
      }, 10_000)

      socket.once('connect', () => {
        clearTimeout(timeout)
        this.state = 'connected'
        console.log(`[Relay] Connected to ${this.config.host}:${this.config.port}`)
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
        this.stopKeepalive()
        this.state = 'disconnected'
        this.socket = null
        this.recvBuf = Buffer.alloc(0)
        this.emit('close')
      })

      socket.connect(this.config.port, this.config.host)
    })
  }

  /**
   * Send ClnConnectReq — initiates streaming through the relay.
   * From Ghidra: "RELAY_CMD_ClnConnectReq, DevSerial:%s, token:%.5s, clienttype:%d, sessionkey:%s"
   *
   * If serverPublicKey is configured, uses ECDH encryption (required by relay servers).
   */
  sendConnectReq(): void {
    const body = Buffer.concat([
      encodeTlv(RelayTag.DEVICE_SERIAL, this.config.deviceSerial),
      encodeTlv(RelayTag.TICKET, this.config.ticket),
      encodeTlv(RelayTag.SESSION_KEY, this.config.sessionKey),
      encodeIntTlv(RelayTag.CLIENT_TYPE, this.config.clientType ?? 55),
    ])

    if (this.config.serverPublicKey) {
      this.sendEcdhConnectReq(body)
      return
    }

    // Unencrypted fallback (may not work with modern relay servers)
    const frame = encodeRelayFrame(RelayCmd.CLN_CONNECT_REQ, ++this.seqNum, body)
    this.sendRaw(frame)
    console.log(`[Relay] Sent ClnConnectReq unencrypted (${body.length}B body, serial=${this.config.deviceSerial})`)
  }

  private sendEcdhConnectReq(body: Buffer): void {
    // 1. Parse server public key
    const serverPubKeyDer = Buffer.from(this.config.serverPublicKey!, 'base64')
    let serverPubKeyRaw: Buffer
    if (serverPubKeyDer.length === 91) {
      serverPubKeyRaw = spkiPublicKeyToRaw(serverPubKeyDer)
    } else if (serverPubKeyDer.length === 65) {
      serverPubKeyRaw = serverPubKeyDer
    } else {
      throw new Error(`Unexpected server public key length: ${serverPubKeyDer.length}`)
    }

    // 2. Generate ephemeral client key pair
    const clientKp = generateKeyPair()
    console.log(`[Relay] Client ECDH pubkey: ${clientKp.publicKey.toString('hex').substring(0, 40)}...`)

    // 3. Compute ECDH shared secret (master key)
    const masterKey = deriveSharedSecret(clientKp.privateKey, serverPubKeyRaw)
    console.log(`[Relay] ECDH master key: ${masterKey.toString('hex').substring(0, 20)}...`)

    // 4. Derive session key via AES-ECB counter KDF
    const sessionKey = ecdhDeriveSessionKey(masterKey, 32)
    console.log(`[Relay] Session key: ${sessionKey.toString('hex').substring(0, 20)}...`)

    // 5. Build ECDH encrypted request packet
    // From native code: local_200 = 9 (clientType) is used as channelId byte
    const packet = buildEcdhReqPacket({
      sessionKey,
      masterKey,
      clientPublicKey: clientKp.publicKey,
      channelId: this.config.clientType ?? 55,
      bodyLength: body.length,
      body,
      seqNum: ++this.seqNum,
    })

    // Store session key for decrypting responses
    this.ecdhSessionKey = sessionKey

    this.sendRaw(packet)
    console.log(`[Relay] Sent ECDH ClnConnectReq (${packet.length}B total, ${body.length}B body, serial=${this.config.deviceSerial})`)
  }

  sendKeepalive(): void {
    const frame = encodeRelayFrame(RelayCmd.KEEPALIVE, ++this.seqNum, Buffer.alloc(0))
    this.sendRaw(frame)
  }

  disconnect(): void {
    this.stopKeepalive()
    this.socket?.destroy()
    this.socket = null
    this.state = 'disconnected'
    this.recvBuf = Buffer.alloc(0)
  }

  private sendRaw(data: Buffer): void {
    if (!this.socket || this.state === 'disconnected') {
      throw new Error('Not connected')
    }
    this.socket.write(data)
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepaliveInterval = setInterval(() => {
      try { this.sendKeepalive() } catch { /* ignore if disconnected */ }
    }, 30_000)
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval)
      this.keepaliveInterval = null
    }
  }

  private onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk])
    this.drain()
  }

  private drain(): void {
    while (this.recvBuf.length >= RELAY_HEADER_LEN) {
      // Check for relay frame magic
      if (this.recvBuf[0] !== RELAY_MAGIC) {
        // Not a relay frame — might be raw video data after streaming starts
        if (this.state === 'streaming') {
          this.emit('data', Buffer.from(this.recvBuf))
          this.recvBuf = Buffer.alloc(0)
        } else {
          // Skip byte and try again
          this.recvBuf = this.recvBuf.subarray(1)
        }
        continue
      }

      const frame = decodeRelayFrame(this.recvBuf)
      if (!frame) break // need more data

      this.recvBuf = this.recvBuf.subarray(frame.totalLen)
      this.handleFrame(frame)
    }
  }

  private handleFrame(frame: RelayFrame): void {
    console.log(`[Relay] Frame cmd=0x${frame.cmd.toString(16)} seq=${frame.seq} bodyLen=${frame.bodyLen} body=${frame.body.toString('hex')}`)

    // Accept any command as ConnectRsp while we're waiting for connection confirmation
    if (this.state === 'connected') {
      this.handleConnectRsp(frame)
      return
    }

    if (frame.cmd === RelayCmd.KEEPALIVE) {
      // Server keepalive — respond
      this.sendKeepalive()
      return
    }

    if (frame.cmd === RelayCmd.DATA || this.state === 'streaming') {
      // Video data — emit for processing
      this.emit('data', frame.body)
      return
    }

    console.log(`[Relay] Unhandled frame cmd=0x${frame.cmd.toString(16)} body=${frame.body.toString('hex').substring(0, 80)}`)
  }

  private handleConnectRsp(frame: RelayFrame): void {
    const attrs = decodeTlvs(frame.body)
    let relayHost = ''
    let relayPort = 0
    let sendRate = 0
    let errorCode = 0
    let streamId = ''

    for (const attr of attrs) {
      switch (attr.tag) {
        case RelayTag.RELAY_HOST:
          relayHost = attr.value.toString('utf8')
          break
        case RelayTag.PORT:
          relayPort = attr.value.length >= 2 ? attr.value.readInt16BE(0) : 0
          break
        case RelayTag.SEND_RATE: {
          // From Ghidra ConvertRelayServerError: values >= 0x2712 are error codes
          const val = attr.value.length >= 4 ? attr.value.readInt32BE(0) : 0
          if (val >= 0x2712) {
            errorCode = val
          } else {
            sendRate = val
          }
          break
        }
        case RelayTag.FIELD_09:
          errorCode = attr.value.length >= 4 ? attr.value.readInt32BE(0) : 0
          break
        case RelayTag.DEVICE_SERIAL:
          streamId = attr.value.toString('utf8')
          break
        default:
          console.log(`[Relay] ConnectRsp attr tag=0x${attr.tag.toString(16)} len=${attr.value.length} val=${attr.value.toString('hex')}`)
      }
    }

    console.log(`[Relay] ConnectRsp: host=${relayHost} port=${relayPort} sendRate=${sendRate} error=${errorCode} streamId=${streamId}`)

    if (errorCode !== 0) {
      // Known relay error codes from Ghidra ConvertRelayServerError
      const errorNames: Record<number, string> = {
        0x2712: 'redirect',
        0x2715: 'auth_failed_or_body_decryption_error',
        0x2716: 'device_busy',
        0x17D7: 'device_no_relay_resource',
      }
      const name = errorNames[errorCode] ?? `unknown_${errorCode}`
      console.log(`[Relay] Error ${errorCode} (0x${errorCode.toString(16)}): ${name}`)
      this.emit('error', new Error(`Relay error: ${name} (${errorCode})`))
      return
    }

    this.state = 'streaming'
    this.startKeepalive()
    this.emit('streaming', { relayHost, relayPort, sendRate })
  }
}
