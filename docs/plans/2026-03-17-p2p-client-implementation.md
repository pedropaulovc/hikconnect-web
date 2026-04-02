# P2P Streaming Client — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build a TypeScript P2P streaming client in the existing Next.js app that streams live video and playback from a Hikvision NVR to a web browser via HLS.

**Architecture:** The client connects to the CAS broker (V3 binary protocol over TCP), performs STUN NAT traversal, establishes a UDP P2P tunnel to the NVR, receives ChaCha20-encrypted video, decrypts it, demuxes MPEG-PS to H.264, and pipes through FFmpeg to produce HLS segments served by Next.js API routes.

**Tech Stack:** TypeScript, Node.js `crypto` (ChaCha20, ECDH P-256, HMAC-SHA256), Node.js `dgram` (UDP), Node.js `net` (TCP), FFmpeg (HLS), Next.js API routes

---

## Protocol Summary (from Phase A RE)

### Two protocol layers:
1. **CAS/P2P V3 Protocol** — binary TLV format via `CV3Protocol::BuildMessage/ParseMessage`
   - Used for: session setup, P2P negotiation, play/teardown/control requests
   - Transport: TCP to CAS broker → then UDP P2P to NVR
   - Key classes: `CP2PV3Client`, `CP2PTransfer`, `CTransferClient`

2. **VTDU/ETP Protocol** — protobuf via `VtduEtpConn::send_msg`
   - Used for: stream info exchange, keepalive, seek, pause, resume, speed change
   - Messages: `StreamInfoReq/Rsp`, `StopStreamReq/Rsp`, `StreamSeekReq/Rsp`, `StreamPauseReq/Rsp`, `StreamResumeReq/Rsp`, `StreamKeepAliveReq`, `StreamModifySpeedReq/Rsp`
   - Transport: over the P2P tunnel (ETP = EZVIZ Transport Protocol)

### Encryption:
- **ChaCha20** with 32-byte key, 12-byte nonce (seqnum + zeros)
- **HMAC-SHA256** with 32-byte key, appended to packet
- **ECDH P-256** for key exchange
- Packet: 11-byte header (`$\x02` + len + seqnum) + encrypted payload + 32-byte HMAC

---

### Task 1: Crypto Module — ChaCha20 + HMAC-SHA256

**Files:**
- Create: `src/lib/p2p/crypto.ts`
- Test: `src/lib/p2p/__tests__/crypto.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/p2p/__tests__/crypto.test.ts
import { describe, it, expect } from 'vitest'
import { encryptPacket, decryptPacket, generateKeyPair, deriveSharedSecret } from '../crypto'

describe('ChaCha20 encryption', () => {
  it('encrypts and decrypts a payload round-trip', () => {
    const key = Buffer.alloc(32, 0xab)
    const hmacKey = Buffer.alloc(32, 0xcd)
    const plaintext = Buffer.from('Hello NVR')
    const seqNum = 1

    const encrypted = encryptPacket(key, hmacKey, plaintext, seqNum)
    // 11 header + 9 payload + 32 HMAC = 52
    expect(encrypted.length).toBe(52)
    expect(encrypted[0]).toBe(0x24) // '$'
    expect(encrypted[1]).toBe(0x02) // type

    const decrypted = decryptPacket(key, hmacKey, encrypted)
    expect(decrypted).toEqual(plaintext)
  })

  it('rejects tampered HMAC', () => {
    const key = Buffer.alloc(32, 0xab)
    const hmacKey = Buffer.alloc(32, 0xcd)
    const encrypted = encryptPacket(key, hmacKey, Buffer.from('test'), 1)
    encrypted[encrypted.length - 1] ^= 0xff // flip last HMAC byte
    expect(() => decryptPacket(key, hmacKey, encrypted)).toThrow('HMAC')
  })
})

describe('ECDH P-256', () => {
  it('derives matching shared secrets', () => {
    const alice = generateKeyPair()
    const bob = generateKeyPair()

    const secretA = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const secretB = deriveSharedSecret(bob.privateKey, alice.publicKey)

    expect(secretA).toEqual(secretB)
    expect(secretA.length).toBe(32)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/p2p/__tests__/crypto.test.ts`
Expected: FAIL with "Cannot find module '../crypto'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/p2p/crypto.ts
import { createCipheriv, createDecipheriv, createHmac, createECDH, randomBytes } from 'crypto'

export function encryptPacket(
  encKey: Buffer,
  hmacKey: Buffer,
  plaintext: Buffer,
  seqNum: number,
): Buffer {
  const header = Buffer.alloc(11)
  header[0] = 0x24 // '$'
  header[1] = 0x02 // data type
  header[2] = 0x00 // padding
  header.writeUInt16BE(plaintext.length, 3)
  header.writeUInt16BE(0, 5) // reserved
  header.writeUInt32BE(seqNum, 7)

  // ChaCha20 nonce: 4-byte LE seqnum + 8 zero bytes
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32LE(seqNum, 0)

  const cipher = createCipheriv('chacha20', encKey, nonce)
  const ciphertext = cipher.update(plaintext)

  const hmac = createHmac('sha256', hmacKey)
  hmac.update(header)
  hmac.update(ciphertext)
  const mac = hmac.digest()

  return Buffer.concat([header, ciphertext, mac])
}

export function decryptPacket(
  encKey: Buffer,
  hmacKey: Buffer,
  packet: Buffer,
): Buffer {
  const header = packet.subarray(0, 11)
  const payloadLen = header.readUInt16BE(3)
  const seqNum = header.readUInt32BE(7)
  const ciphertext = packet.subarray(11, 11 + payloadLen)
  const receivedMac = packet.subarray(11 + payloadLen, 11 + payloadLen + 32)

  // Verify HMAC
  const hmac = createHmac('sha256', hmacKey)
  hmac.update(header)
  hmac.update(ciphertext)
  const expectedMac = hmac.digest()

  if (!receivedMac.equals(expectedMac)) {
    throw new Error('HMAC verification failed')
  }

  // Decrypt ChaCha20
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32LE(seqNum, 0)
  const decipher = createDecipheriv('chacha20', encKey, nonce)
  return decipher.update(ciphertext)
}

export type KeyPair = { publicKey: Buffer; privateKey: Buffer }

export function generateKeyPair(): KeyPair {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey(),
    privateKey: ecdh.getPrivateKey(),
  }
}

export function deriveSharedSecret(privateKey: Buffer, peerPublicKey: Buffer): Buffer {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(privateKey)
  return ecdh.computeSecret(peerPublicKey)
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/p2p/__tests__/crypto.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/p2p/crypto.ts src/lib/p2p/__tests__/crypto.test.ts
git commit -m "feat(p2p): add ChaCha20 + HMAC-SHA256 + ECDH P-256 crypto module"
```

---

### Task 2: Packet Framing Module

**Files:**
- Create: `src/lib/p2p/packet.ts`
- Test: `src/lib/p2p/__tests__/packet.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/p2p/__tests__/packet.test.ts
import { describe, it, expect } from 'vitest'
import { encodeHeader, decodeHeader, PacketType } from '../packet'

describe('packet framing', () => {
  it('encodes a data packet header', () => {
    const header = encodeHeader({ type: PacketType.DATA, payloadLength: 256, seqNum: 42 })
    expect(header.length).toBe(11)
    expect(header[0]).toBe(0x24)
    expect(header[1]).toBe(0x02)
    expect(header.readUInt16BE(3)).toBe(256)
    expect(header.readUInt32BE(7)).toBe(42)
  })

  it('round-trips encode/decode', () => {
    const original = { type: PacketType.DATA as const, payloadLength: 1400, seqNum: 999 }
    const header = encodeHeader(original)
    const decoded = decodeHeader(header)
    expect(decoded.type).toBe(original.type)
    expect(decoded.payloadLength).toBe(original.payloadLength)
    expect(decoded.seqNum).toBe(original.seqNum)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/p2p/__tests__/packet.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/lib/p2p/packet.ts

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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/p2p/__tests__/packet.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/p2p/packet.ts src/lib/p2p/__tests__/packet.test.ts
git commit -m "feat(p2p): add packet header framing (11-byte header encode/decode)"
```

---

### Task 3: STUN Client

**Files:**
- Create: `src/lib/p2p/stun-client.ts`
- Test: `src/lib/p2p/__tests__/stun-client.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/p2p/__tests__/stun-client.test.ts
import { describe, it, expect } from 'vitest'
import { buildBindingRequest, parseBindingResponse, STUN_MAGIC_COOKIE } from '../stun-client'

describe('STUN message building', () => {
  it('builds a valid binding request', () => {
    const msg = buildBindingRequest()
    // STUN header: 20 bytes minimum
    expect(msg.length).toBeGreaterThanOrEqual(20)
    // Type: 0x0001 (Binding Request)
    expect(msg.readUInt16BE(0)).toBe(0x0001)
    // Magic cookie
    expect(msg.readUInt32BE(4)).toBe(STUN_MAGIC_COOKIE)
  })

  it('parses a binding response with XOR-MAPPED-ADDRESS', () => {
    // Craft a minimal STUN response with XOR-MAPPED-ADDRESS
    const txId = Buffer.alloc(12, 0xaa)
    const resp = Buffer.alloc(32)
    resp.writeUInt16BE(0x0101, 0) // Binding Response
    resp.writeUInt16BE(12, 2) // message length
    resp.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
    txId.copy(resp, 8)
    // XOR-MAPPED-ADDRESS attribute
    resp.writeUInt16BE(0x0020, 20) // type
    resp.writeUInt16BE(8, 22) // length
    resp[24] = 0x00 // reserved
    resp[25] = 0x01 // IPv4
    resp.writeUInt16BE(0x1234 ^ (STUN_MAGIC_COOKIE >> 16), 26) // XOR'd port
    resp.writeUInt32BE(0xC0A80001 ^ STUN_MAGIC_COOKIE, 28) // XOR'd IP

    const result = parseBindingResponse(resp)
    expect(result.address).toBe('192.168.0.1')
    expect(result.port).toBe(0x1234)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/p2p/__tests__/stun-client.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/lib/p2p/stun-client.ts
import { randomBytes } from 'crypto'
import { createSocket } from 'dgram'

export const STUN_MAGIC_COOKIE = 0x2112A442

export function buildBindingRequest(transactionId?: Buffer): Buffer {
  const txId = transactionId ?? randomBytes(12)
  const msg = Buffer.alloc(20)
  msg.writeUInt16BE(0x0001, 0) // Binding Request
  msg.writeUInt16BE(0, 2) // message length (no attributes)
  msg.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  txId.copy(msg, 8)
  return msg
}

export type StunResult = { address: string; port: number }

export function parseBindingResponse(buf: Buffer): StunResult {
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
        port ^= (STUN_MAGIC_COOKIE >> 16)
        ip ^= STUN_MAGIC_COOKIE
      }

      const address = [
        (ip >> 24) & 0xff,
        (ip >> 16) & 0xff,
        (ip >> 8) & 0xff,
        ip & 0xff,
      ].join('.')

      return { address, port }
    }

    offset += 4 + attrLen
    if (attrLen % 4 !== 0) offset += 4 - (attrLen % 4) // padding
  }

  throw new Error('No MAPPED-ADDRESS found in STUN response')
}

export async function stunBind(stunHost: string, stunPort: number): Promise<StunResult> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('STUN binding timeout'))
    }, 3000)

    socket.on('message', (msg) => {
      clearTimeout(timeout)
      socket.close()
      resolve(parseBindingResponse(msg))
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      socket.close()
      reject(err)
    })

    const req = buildBindingRequest()
    socket.send(req, stunPort, stunHost)
  })
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/p2p/__tests__/stun-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/p2p/stun-client.ts src/lib/p2p/__tests__/stun-client.test.ts
git commit -m "feat(p2p): add RFC 5389 STUN client with binding request/response"
```

---

### Task 4: V3 Protocol Message Builder/Parser

**Files:**
- Create: `src/lib/p2p/v3-protocol.ts`
- Test: `src/lib/p2p/__tests__/v3-protocol.test.ts`

This is the binary TLV protocol used by the CAS broker and P2P layer. From the RE:
- `CV3Protocol::ReadAttribute` reads: 1-byte type tag, 2-byte length, N-byte value
- `CV3Protocol::WriteAttribute` writes the same
- `CV3Protocol::ComposeMsgBody` builds a complete message from `tag_V3Attribute`
- `CV3Protocol::ParseMsgBody` parses a message into `tag_V3Attribute`

**Step 1: Write the failing test**

```typescript
// src/lib/p2p/__tests__/v3-protocol.test.ts
import { describe, it, expect } from 'vitest'
import { V3Message, encodeV3Message, decodeV3Message } from '../v3-protocol'

describe('V3 protocol', () => {
  it('round-trips a message with string and int attributes', () => {
    const msg: V3Message = {
      msgType: 0x0001,
      attributes: [
        { tag: 0x01, value: Buffer.from('L38239367') },
        { tag: 0x02, value: Buffer.from([0x00, 0x00, 0x23, 0x28]) }, // port 9000
      ],
    }
    const encoded = encodeV3Message(msg)
    const decoded = decodeV3Message(encoded)
    expect(decoded.msgType).toBe(msg.msgType)
    expect(decoded.attributes.length).toBe(2)
    expect(decoded.attributes[0].value.toString()).toBe('L38239367')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/p2p/__tests__/v3-protocol.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/lib/p2p/v3-protocol.ts

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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/p2p/__tests__/v3-protocol.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/p2p/v3-protocol.ts src/lib/p2p/__tests__/v3-protocol.test.ts
git commit -m "feat(p2p): add V3 binary TLV protocol encoder/decoder"
```

---

### Task 5: CAS Broker TCP Client

**Files:**
- Create: `src/lib/p2p/cas-client.ts`
- Test: `src/lib/p2p/__tests__/cas-client.test.ts`

This task creates the TCP client that connects to the CAS broker. The exact message opcodes and attribute tags need dynamic validation, so this task implements the framing and connection logic. The specific message building will be refined in Task 8 with real traffic.

**Step 1: Write the failing test**

```typescript
// src/lib/p2p/__tests__/cas-client.test.ts
import { describe, it, expect } from 'vitest'
import { CasClient } from '../cas-client'

describe('CAS client', () => {
  it('constructs with config', () => {
    const client = new CasClient({
      host: '34.194.209.167',
      port: 6500,
      deviceSerial: 'L38239367',
      sessionToken: 'test-jwt',
    })
    expect(client).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/p2p/__tests__/cas-client.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/lib/p2p/cas-client.ts
import { Socket } from 'net'
import { encodeV3Message, decodeV3Message, V3Message } from './v3-protocol'

export type CasConfig = {
  host: string
  port: number
  deviceSerial: string
  sessionToken: string
  channelNumber?: number
  streamType?: number
}

type CasState = 'disconnected' | 'connecting' | 'connected' | 'session_created' | 'error'

export class CasClient {
  private socket: Socket | null = null
  private state: CasState = 'disconnected'
  private recvBuf = Buffer.alloc(0)

  constructor(private config: CasConfig) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = 'connecting'
      this.socket = new Socket()
      this.socket.setTimeout(5000)

      this.socket.on('connect', () => {
        this.state = 'connected'
        resolve()
      })

      this.socket.on('data', (data) => {
        this.recvBuf = Buffer.concat([this.recvBuf, data])
        this.processRecvBuf()
      })

      this.socket.on('error', (err) => {
        this.state = 'error'
        reject(err)
      })

      this.socket.on('timeout', () => {
        this.state = 'error'
        this.socket?.destroy()
        reject(new Error('CAS connection timeout'))
      })

      this.socket.connect(this.config.port, this.config.host)
    })
  }

  private sendMessage(msg: V3Message): void {
    if (!this.socket) throw new Error('Not connected')
    this.socket.write(encodeV3Message(msg))
  }

  private processRecvBuf(): void {
    // Need at least 4 bytes for header
    while (this.recvBuf.length >= 4) {
      const bodyLen = this.recvBuf.readUInt16BE(2)
      const totalLen = 4 + bodyLen
      if (this.recvBuf.length < totalLen) break

      const msgBuf = this.recvBuf.subarray(0, totalLen)
      this.recvBuf = this.recvBuf.subarray(totalLen)
      const msg = decodeV3Message(msgBuf)
      this.handleMessage(msg)
    }
  }

  private handleMessage(_msg: V3Message): void {
    // TODO: dispatch based on msgType
    // Will be implemented with real CAS opcodes in Task 8
  }

  disconnect(): void {
    this.socket?.destroy()
    this.socket = null
    this.state = 'disconnected'
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/p2p/__tests__/cas-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/p2p/cas-client.ts src/lib/p2p/__tests__/cas-client.test.ts
git commit -m "feat(p2p): add CAS broker TCP client with V3 protocol framing"
```

---

### Task 6: P2P Tunnel — UDP Socket with Hole Punching

**Files:**
- Create: `src/lib/p2p/p2p-tunnel.ts`
- Test: `src/lib/p2p/__tests__/p2p-tunnel.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/p2p/__tests__/p2p-tunnel.test.ts
import { describe, it, expect } from 'vitest'
import { P2PTunnel } from '../p2p-tunnel'

describe('P2P tunnel', () => {
  it('constructs with peer info', () => {
    const tunnel = new P2PTunnel({
      peerAddress: '24.35.64.195',
      peerPort: 9020,
      encKey: Buffer.alloc(32),
      hmacKey: Buffer.alloc(32),
    })
    expect(tunnel).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/p2p/__tests__/p2p-tunnel.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/lib/p2p/p2p-tunnel.ts
import { createSocket, Socket as UdpSocket } from 'dgram'
import { EventEmitter } from 'events'
import { decryptPacket } from './crypto'
import { decodeHeader, HEADER_SIZE, HMAC_SIZE } from './packet'

export type P2PConfig = {
  peerAddress: string
  peerPort: number
  encKey: Buffer
  hmacKey: Buffer
}

export class P2PTunnel extends EventEmitter {
  private socket: UdpSocket | null = null
  private seqNum = 0

  constructor(private config: P2PConfig) {
    super()
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createSocket('udp4')

      this.socket.on('message', (msg) => {
        this.handlePacket(msg)
      })

      this.socket.on('error', (err) => {
        this.emit('error', err)
        reject(err)
      })

      this.socket.bind(0, () => {
        // Send initial punch-through packets
        this.sendPunch()
        resolve()
      })
    })
  }

  private sendPunch(): void {
    if (!this.socket) return
    // Send empty UDP packets for hole-punching
    const punch = Buffer.alloc(1)
    for (let i = 0; i < 3; i++) {
      this.socket.send(punch, this.config.peerPort, this.config.peerAddress)
    }
  }

  sendRaw(data: Buffer): void {
    if (!this.socket) throw new Error('Tunnel not open')
    this.socket.send(data, this.config.peerPort, this.config.peerAddress)
  }

  private handlePacket(buf: Buffer): void {
    if (buf.length < HEADER_SIZE + HMAC_SIZE) return
    if (buf[0] !== 0x24) return // not our protocol

    try {
      const plaintext = decryptPacket(this.config.encKey, this.config.hmacKey, buf)
      this.emit('data', plaintext)
    } catch {
      this.emit('error', new Error('Packet decryption failed'))
    }
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/p2p/__tests__/p2p-tunnel.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/p2p/p2p-tunnel.ts src/lib/p2p/__tests__/p2p-tunnel.test.ts
git commit -m "feat(p2p): add UDP P2P tunnel with hole-punching and decryption"
```

---

### Task 7: FFmpeg HLS Pipe

**Files:**
- Create: `src/lib/hls/ffmpeg-pipe.ts`
- Test: `src/lib/hls/__tests__/ffmpeg-pipe.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/hls/__tests__/ffmpeg-pipe.test.ts
import { describe, it, expect } from 'vitest'
import { FfmpegHlsPipe } from '../ffmpeg-pipe'

describe('FFmpeg HLS pipe', () => {
  it('constructs with output directory', () => {
    const pipe = new FfmpegHlsPipe({ outputDir: '/tmp/hls-test', segmentDuration: 2 })
    expect(pipe).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/hls/__tests__/ffmpeg-pipe.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/lib/hls/ffmpeg-pipe.ts
import { spawn, ChildProcess } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'

export type HlsConfig = {
  outputDir: string
  segmentDuration?: number
}

export class FfmpegHlsPipe {
  private process: ChildProcess | null = null
  private playlistPath: string

  constructor(private config: HlsConfig) {
    this.playlistPath = join(config.outputDir, 'stream.m3u8')
  }

  start(): void {
    mkdirSync(this.config.outputDir, { recursive: true })

    const segDuration = this.config.segmentDuration ?? 2

    this.process = spawn('ffmpeg', [
      '-i', 'pipe:0',           // stdin input
      '-c:v', 'copy',           // copy video codec (no re-encode)
      '-f', 'hls',
      '-hls_time', String(segDuration),
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', join(this.config.outputDir, 'seg_%03d.ts'),
      this.playlistPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.on('error', (err) => {
      console.error('FFmpeg error:', err)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      // FFmpeg logs to stderr
      const line = data.toString().trim()
      if (line) console.log('[ffmpeg]', line)
    })
  }

  write(data: Buffer): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('FFmpeg not running')
    }
    this.process.stdin.write(data)
  }

  stop(): void {
    this.process?.stdin?.end()
    this.process?.kill('SIGTERM')
    this.process = null
  }

  getPlaylistPath(): string {
    return this.playlistPath
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/hls/__tests__/ffmpeg-pipe.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/hls/ffmpeg-pipe.ts src/lib/hls/__tests__/ffmpeg-pipe.test.ts
git commit -m "feat(hls): add FFmpeg stdin-to-HLS pipe"
```

---

### Task 8: Dynamic Validation — Capture CAS Protocol with Hetzner VM

This task is the bridge between static RE and live implementation. **Only needed if Tasks 1-7 unit tests pass but end-to-end connection to the NVR fails.**

**Prerequisite:** Tasks 1-7 complete. Attempt end-to-end connection. If CAS protocol specifics are wrong (opcodes, attribute tags), provision a Hetzner CAX11 for Frida capture.

**Files:**
- Modify: `src/lib/p2p/cas-client.ts` (update with real opcodes)
- Modify: `src/lib/p2p/v3-protocol.ts` (update with real attribute tags)

**Step 1: Provision Hetzner CAX11 with security hardening**

Follow the security requirements in `docs/plans/2026-03-16-status-update.md#security-requirements-for-redroid-deployment`:
```bash
hcloud server create --name hikconnect-re --type cax11 --image ubuntu-24.04 --ssh-key <key>
# Then SSH in and:
ufw default deny incoming && ufw default allow outgoing && ufw allow 22/tcp && ufw enable
```

**Step 2: Install redroid + Frida with ADB bound to localhost only**

```bash
docker run -d --privileged -p 127.0.0.1:5555:5555 redroid/redroid:14.0.0-latest
iptables -I DOCKER-USER -p tcp --dport 5555 -j DROP
iptables -I DOCKER-USER -p tcp --dport 5555 -s 127.0.0.1 -j ACCEPT
ss -tlnp | grep 5555  # MUST show 127.0.0.1:5555
```

**Step 3: Capture CAS traffic with tcpdump**

```bash
tcpdump -i any -w /tmp/cas-capture.pcap 'host 34.194.209.167 and port 6500'
```

**Step 4: Analyze with tshark locally**

```bash
scp root@<server>:/tmp/cas-capture.pcap /tmp/
tshark -r /tmp/cas-capture.pcap -T fields -e data.data
```

**Step 5: Update CAS client with real opcodes and commit**

---

### Task 9: End-to-End Integration — Stream Orchestrator

**Files:**
- Create: `src/lib/p2p/stream-session.ts`
- Test: manual end-to-end test

**Step 1: Write the stream orchestrator**

```typescript
// src/lib/p2p/stream-session.ts
import { CasClient, CasConfig } from './cas-client'
import { stunBind } from './stun-client'
import { P2PTunnel } from './p2p-tunnel'
import { generateKeyPair, deriveSharedSecret } from './crypto'
import { FfmpegHlsPipe } from '../hls/ffmpeg-pipe'

export type StreamConfig = {
  cas: CasConfig
  stunHost: string
  stunPort: number
  hlsOutputDir: string
}

type SessionState = 'idle' | 'connecting' | 'streaming' | 'error' | 'stopped'

export class StreamSession {
  private cas: CasClient
  private tunnel: P2PTunnel | null = null
  private ffmpeg: FfmpegHlsPipe
  private state: SessionState = 'idle'

  constructor(private config: StreamConfig) {
    this.cas = new CasClient(config.cas)
    this.ffmpeg = new FfmpegHlsPipe({
      outputDir: config.hlsOutputDir,
      segmentDuration: 2,
    })
  }

  async start(): Promise<string> {
    this.state = 'connecting'

    // 1. STUN binding — get our public address
    const stunResult = await stunBind(this.config.stunHost, this.config.stunPort)

    // 2. Generate ECDH key pair
    const keyPair = generateKeyPair()

    // 3. Connect to CAS broker
    await this.cas.connect()

    // 4. Create CAS session, exchange keys, get peer info
    // TODO: implement with real CAS opcodes from Task 8
    // const peerInfo = await this.cas.createSession(...)

    // 5. Derive shared secret
    // const sharedSecret = deriveSharedSecret(keyPair.privateKey, peerInfo.publicKey)

    // 6. Open P2P tunnel
    // this.tunnel = new P2PTunnel({
    //   peerAddress: peerInfo.address,
    //   peerPort: peerInfo.port,
    //   encKey: sharedSecret.subarray(0, 32),
    //   hmacKey: sharedSecret, // TODO: verify key split
    // })
    // await this.tunnel.open()

    // 7. Start FFmpeg HLS pipe
    this.ffmpeg.start()

    // 8. Wire tunnel data to FFmpeg
    // this.tunnel.on('data', (data) => this.ffmpeg.write(data))

    this.state = 'streaming'
    return this.ffmpeg.getPlaylistPath()
  }

  stop(): void {
    this.state = 'stopped'
    this.tunnel?.close()
    this.ffmpeg.stop()
    this.cas.disconnect()
  }

  getState(): SessionState {
    return this.state
  }
}
```

**Step 2: Commit**

```bash
git add src/lib/p2p/stream-session.ts
git commit -m "feat(p2p): add stream session orchestrator (skeleton for end-to-end)"
```

---

### Task 10: Next.js API Routes for HLS

**Files:**
- Create: `src/app/api/stream/start/route.ts`
- Create: `src/app/api/stream/[...path]/route.ts`
- Create: `src/app/api/stream/stop/route.ts`

**Step 1: Write start route**

```typescript
// src/app/api/stream/start/route.ts
import { NextResponse } from 'next/server'
import { StreamSession } from '@/lib/p2p/stream-session'
import { join } from 'path'
import { tmpdir } from 'os'

const sessions = new Map<string, StreamSession>()

export async function POST(req: Request) {
  const body = await req.json()
  const { deviceSerial, channel = 1 } = body

  const sessionId = `${deviceSerial}-${channel}-${Date.now()}`
  const hlsDir = join(tmpdir(), 'hls', sessionId)

  const session = new StreamSession({
    cas: {
      host: '34.194.209.167',
      port: 6500,
      deviceSerial,
      sessionToken: '', // TODO: from HikConnect auth
    },
    stunHost: '43.130.155.63',
    stunPort: 6002,
    hlsOutputDir: hlsDir,
  })

  sessions.set(sessionId, session)

  const playlistPath = await session.start()

  return NextResponse.json({
    sessionId,
    playlistUrl: `/api/stream/${sessionId}/stream.m3u8`,
  })
}
```

**Step 2: Write file serving route**

```typescript
// src/app/api/stream/[...path]/route.ts
import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const [sessionId, ...rest] = path
  const filePath = join(tmpdir(), 'hls', sessionId, ...rest)

  try {
    const data = await readFile(filePath)
    const ext = filePath.split('.').pop()
    const contentType = ext === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
    return new NextResponse(data, { headers: { 'Content-Type': contentType } })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
```

**Step 3: Write stop route**

```typescript
// src/app/api/stream/stop/route.ts
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const { sessionId } = await req.json()
  // TODO: look up session and stop it
  return NextResponse.json({ stopped: true })
}
```

**Step 4: Commit**

```bash
git add src/app/api/stream/
git commit -m "feat(api): add HLS streaming API routes (start, serve, stop)"
```

---

## Dependency Graph

```
Task 1 (Crypto) ─────┐
Task 2 (Packet) ─────┤
Task 3 (STUN) ───────┼─→ Task 9 (Orchestrator) ─→ Task 10 (API Routes)
Task 4 (V3 Proto) ───┤                    ↑
Task 5 (CAS Client) ─┤                    │
Task 6 (P2P Tunnel) ─┘                    │
Task 7 (FFmpeg HLS) ──────────────────────┘

Task 8 (Dynamic Validation) — only if end-to-end fails
```

Tasks 1-4 can run in parallel. Tasks 5-6 depend on 1-4. Task 7 is independent. Task 9 depends on all. Task 10 depends on 9.
