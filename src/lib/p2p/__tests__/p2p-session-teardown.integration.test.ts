/**
 * Integration tests for P2P TEARDOWN (0x0C04) on session stop.
 *
 * Spec: v3-protocol-opcodes.md — TEARDOWN attrs: 0x05 (sessionKey),
 *   0x76 (busType), 0x77 (channelNo), 0x78 (streamType), 0x84 (deviceSession)
 *
 * These tests drive P2PSession through a full handshake against a fake
 * UDP device, then verify TEARDOWN behavior on stop().
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { createSocket, type Socket } from 'node:dgram'
import { P2PSession, type P2PSessionConfig } from '../p2p-session'
import {
  encodeV3Message, decodeV3Message, defaultMask,
  Opcode, AttrTag,
  getStringAttr, getIntAttr,
} from '../v3-protocol'

// --- Test keys (deterministic, for packet decryption) ---

const TEST_P2P_KEY = Buffer.from(
  'e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5', 'hex',
)
const TEST_LINK_KEY = Buffer.from('abcdefgh12345678abcdefgh12345678') // 32 ASCII bytes

const SRT_INIT_SEQ = 12345 // Fake SRT initial sequence → becomes dataSessionId
const DEVICE_SOCKET_ID = 0xabcd1234

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// --- Fake Device: minimal P2P protocol simulator ---

/**
 * Simulates just enough of the P2P + SRT protocol to get P2PSession
 * to 'streaming' state:
 *   P2P_SETUP → punch (0x0C00) → PLAY_REQUEST → SRT induction → SRT conclusion
 */
class FakeDevice {
  readonly socket: Socket
  readonly received: Buffer[] = []
  port = 0

  private clientPort = 0
  private clientAddr = '127.0.0.1'
  private srtStarted = false

  constructor() {
    this.socket = createSocket('udp4')
  }

  async start(): Promise<void> {
    await new Promise<void>(resolve => {
      this.socket.bind(0, '127.0.0.1', () => {
        this.port = this.socket.address().port
        resolve()
      })
    })
    this.socket.on('message', (msg, rinfo) => {
      this.received.push(Buffer.from(msg))
      this.clientPort = rinfo.port
      this.clientAddr = rinfo.address
      this.route(msg)
    })
  }

  close(): void {
    try { this.socket.close() } catch { /* already closed */ }
  }

  // --- Protocol handlers ---

  private route(msg: Buffer): void {
    if (msg.length < 2) return

    // V3 message (magic nibble 0xE)
    if (msg.length >= 12 && (msg[0] >> 4) === 0xe) {
      const opcode = msg.readUInt16BE(2)
      if (opcode === Opcode.P2P_SETUP) {
        setTimeout(() => this.sendPunch(), 20)
      } else if (opcode === Opcode.TRANSFOR_DATA && !this.srtStarted) {
        // First TRANSFOR_DATA = PLAY_REQUEST relay → start SRT handshake
        this.srtStarted = true
        setTimeout(() => this.sendSrtInduction(), 50)
      }
      return
    }

    // SRT handshake response (0x8000)
    if (msg.length >= 64 && msg.readUInt16BE(0) === 0x8000) {
      const version = msg.readUInt32BE(16)
      const hsType = msg.readUInt32BE(36)
      if (version === 5 && hsType === 1) {
        const clientSocketId = msg.readUInt32BE(40)
        const synCookie = msg.readUInt32BE(44)
        setTimeout(() => this.sendSrtConclusion(clientSocketId, synCookie), 20)
      }
    }
  }

  private send(buf: Buffer): void {
    this.socket.send(buf, this.clientPort, this.clientAddr)
  }

  private sendPunch(): void {
    this.send(encodeV3Message({
      msgType: Opcode.PUNCH_REQUEST,
      seqNum: 1,
      reserved: 0x6234,
      mask: defaultMask(),
      attributes: [{ tag: AttrTag.SESSION_KEY, value: Buffer.from('fake-key') }],
    }))
  }

  private sendSrtInduction(): void {
    const pkt = Buffer.alloc(64)
    pkt.writeUInt16BE(0x8000, 0) // SRT handshake control
    pkt.writeUInt32BE(4, 16)     // version=4 (triggers induction path)
    pkt.writeUInt32BE(SRT_INIT_SEQ, 24)
    pkt.writeUInt32BE(1500, 28)  // MTU
    pkt.writeUInt32BE(32, 32)    // window
    pkt.writeUInt32BE(1, 36)     // hsType=INDUCTION
    pkt.writeUInt32BE(DEVICE_SOCKET_ID, 40)
    this.send(pkt)
  }

  private sendSrtConclusion(destSocketId: number, synCookie: number): void {
    const pkt = Buffer.alloc(64)
    pkt.writeUInt16BE(0x8000, 0)
    pkt.writeUInt32BE(destSocketId, 12)
    pkt.writeUInt32BE(5, 16)           // version=5 (SRT)
    pkt.writeUInt16BE(1, 22)           // extension present
    pkt.writeUInt32BE(SRT_INIT_SEQ, 24)
    pkt.writeUInt32BE(1500, 28)
    pkt.writeUInt32BE(32, 32)
    pkt.writeUInt32BE(0xffffffff, 36)  // hsType=CONCLUSION
    pkt.writeUInt32BE(DEVICE_SOCKET_ID, 40)
    pkt.writeUInt32BE(synCookie, 44)
    this.send(pkt)
  }
}

// --- Packet analysis helpers ---

type TeardownResult = {
  found: boolean
  attrs: Array<{ tag: number; value: Buffer }>
}

/**
 * Search packets for TEARDOWN (0x0C04), either sent directly or
 * wrapped in TRANSFOR_DATA (0x0B04).
 */
function findTeardown(
  packets: Buffer[],
  p2pKey: Buffer,
  linkKey: Buffer,
): TeardownResult {
  for (const pkt of packets) {
    if (pkt.length < 12 || (pkt[0] >> 4) !== 0xe) continue
    const opcode = pkt.readUInt16BE(2)

    // Case 1: direct TEARDOWN (opcode = 0x0C04)
    if (opcode === Opcode.TEARDOWN) {
      const msg = tryDecode(pkt, linkKey)
      if (msg) return { found: true, attrs: msg.attributes }
    }

    // Case 2: TEARDOWN wrapped in TRANSFOR_DATA (opcode = 0x0B04)
    if (opcode === Opcode.TRANSFOR_DATA) {
      const outer = tryDecode(pkt, p2pKey)
      if (!outer) continue

      const innerAttr = outer.attributes.find(a => a.tag === AttrTag.LARGE_DATA)
      if (!innerAttr || innerAttr.value.length < 12) continue

      const innerOpcode = innerAttr.value.readUInt16BE(2)
      if (innerOpcode !== Opcode.TEARDOWN) continue

      const inner = tryDecode(innerAttr.value, linkKey)
      if (inner) return { found: true, attrs: inner.attributes }
    }
  }
  return { found: false, attrs: [] }
}

function tryDecode(buf: Buffer, key: Buffer) {
  try { return decodeV3Message(buf, key) } catch {}
  try { return decodeV3Message(buf) } catch {}
  return null
}

/** Index of first packet that looks like TEARDOWN or TRANSFOR_DATA (during stop). */
function teardownPacketIndex(packets: Buffer[]): number {
  return packets.findIndex(pkt => {
    if (pkt.length < 12 || (pkt[0] >> 4) !== 0xe) return false
    const op = pkt.readUInt16BE(2)
    return op === Opcode.TEARDOWN || op === Opcode.TRANSFOR_DATA
  })
}

/** Index of first SRT shutdown (control type 5, 0x8005). */
function srtShutdownIndex(packets: Buffer[]): number {
  return packets.findIndex(pkt =>
    pkt.length >= 16 && pkt.readUInt16BE(0) === 0x8005,
  )
}

// --- Test config factory ---

function makeConfig(fakePort: number): P2PSessionConfig {
  return {
    deviceSerial: 'L38239367',
    devicePublicIp: '127.0.0.1',
    devicePublicPort: fakePort,
    p2pServers: [{ host: '127.0.0.1', port: fakePort }],
    p2pKey: TEST_P2P_KEY,
    p2pLinkKey: TEST_LINK_KEY,
    p2pKeyVersion: 101,
    p2pKeySaltIndex: 3,
    p2pKeySaltVer: 1,
    sessionToken: 'test-token',
    userId: 'fcfaec90a55f4a61b4e7211152a2d805',
    clientId: 12345,
    channelNo: 1,
    streamType: 1,
    streamTokens: ['token1', 'token2'],
    localPublicIp: '127.0.0.1',
    busType: 1,
  }
}

// --- Tests ---

describe('P2PSession TEARDOWN on stop() — integration', () => {
  let device: FakeDevice
  let session: P2PSession | null = null

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    device = new FakeDevice()
    await device.start()
  })

  afterEach(() => {
    try { session?.stop() } catch { /* safe cleanup */ }
    session = null
    device.close()
    vi.restoreAllMocks()
  })

  it('sends TEARDOWN (0x0C04) when stop() is called on a streaming session', { timeout: 30_000 }, async () => {
    session = new P2PSession(makeConfig(device.port))
    await session.start()
    expect(session.sessionState).toBe('streaming')

    const before = device.received.length
    session.stop()
    await delay(200) // let queued UDP sends arrive

    const stopPackets = device.received.slice(before)
    const { found } = findTeardown(stopPackets, TEST_P2P_KEY, TEST_LINK_KEY)

    expect(found).toBe(true)
  })

  it('TEARDOWN contains all required attributes per v3-protocol-opcodes.md spec', { timeout: 30_000 }, async () => {
    const config = makeConfig(device.port)
    session = new P2PSession(config)
    await session.start()

    const before = device.received.length
    session.stop()
    await delay(200)

    const stopPackets = device.received.slice(before)
    const { found, attrs } = findTeardown(stopPackets, TEST_P2P_KEY, TEST_LINK_KEY)
    expect(found).toBe(true)

    // Spec: TEARDOWN attrs = 0x05 (session key), 0x76 (busType, 1B),
    //   0x77 (channelNo, 2B BE), 0x78 (streamType, 1B), 0x84 (deviceSession, 4B)

    const sessionKey = getStringAttr(attrs, AttrTag.SESSION_KEY)
    expect(sessionKey).toBeTruthy()
    expect(sessionKey!.length).toBeGreaterThan(0)

    expect(getIntAttr(attrs, AttrTag.BUS_TYPE)).toBe(config.busType)
    expect(getIntAttr(attrs, AttrTag.CHANNEL_NO)).toBe(config.channelNo)
    expect(getIntAttr(attrs, AttrTag.STREAM_TYPE)).toBe(config.streamType)

    // deviceSession comes from SRT initSeq (our fake sends SRT_INIT_SEQ = 12345)
    const deviceSession = getIntAttr(attrs, AttrTag.DEVICE_SESSION)
    expect(deviceSession).toBe(SRT_INIT_SEQ)
  })

  it('sends TEARDOWN before SRT shutdown (0x8005)', { timeout: 30_000 }, async () => {
    session = new P2PSession(makeConfig(device.port))
    await session.start()

    const before = device.received.length
    session.stop()
    await delay(200)

    const stopPackets = device.received.slice(before)

    const tdIdx = teardownPacketIndex(stopPackets)
    const sdIdx = srtShutdownIndex(stopPackets)

    // Both must be present
    expect(tdIdx).toBeGreaterThanOrEqual(0)
    expect(sdIdx).toBeGreaterThanOrEqual(0)

    // TEARDOWN must precede SRT shutdown
    expect(tdIdx).toBeLessThan(sdIdx)
  })

  it('stop() is idempotent — second call sends no additional packets', { timeout: 30_000 }, async () => {
    session = new P2PSession(makeConfig(device.port))
    await session.start()

    session.stop()
    await delay(200)
    const countAfterFirst = device.received.length

    session.stop() // must not throw or send anything
    await delay(200)

    expect(device.received.length).toBe(countAfterFirst)
    expect(session.sessionState).toBe('stopped')
  })

  it('TEARDOWN attributes reflect actual config — not hardcoded values', { timeout: 30_000 }, async () => {
    // Use NON-DEFAULT config values to catch hardcoded implementations
    const config: P2PSessionConfig = {
      ...makeConfig(device.port),
      channelNo: 3,
      streamType: 0,
      busType: 2,
    }
    session = new P2PSession(config)
    await session.start()

    const before = device.received.length
    session.stop()
    await delay(200)

    const stopPackets = device.received.slice(before)
    const { found, attrs } = findTeardown(stopPackets, TEST_P2P_KEY, TEST_LINK_KEY)
    expect(found).toBe(true)

    // These MUST match the non-default config, not channel=1/streamType=1/busType=1
    expect(getIntAttr(attrs, AttrTag.BUS_TYPE)).toBe(2)
    expect(getIntAttr(attrs, AttrTag.CHANNEL_NO)).toBe(3)
    expect(getIntAttr(attrs, AttrTag.STREAM_TYPE)).toBe(0)
  })

  it('TEARDOWN sessionKey matches the key used in P2P_SETUP (not a fresh random key)', { timeout: 30_000 }, async () => {
    session = new P2PSession(makeConfig(device.port))
    await session.start()

    // Capture PLAY_REQUEST sessionKey from start() packets
    const startPackets = device.received.slice()
    // Extract sessionKey from any TRANSFOR_DATA sent during start (PLAY_REQUEST)
    let playSessionKey: string | undefined
    for (const pkt of startPackets) {
      if (pkt.length < 12 || (pkt[0] >> 4) !== 0xe) continue
      if (pkt.readUInt16BE(2) !== Opcode.TRANSFOR_DATA) continue
      const outer = tryDecode(pkt, TEST_P2P_KEY)
      if (!outer) continue
      const innerAttr = outer.attributes.find(a => a.tag === AttrTag.LARGE_DATA)
      if (!innerAttr || innerAttr.value.length < 12) continue
      if (innerAttr.value.readUInt16BE(2) === Opcode.PLAY_REQUEST) {
        const inner = tryDecode(innerAttr.value, TEST_LINK_KEY)
        if (inner) {
          playSessionKey = getStringAttr(inner.attributes, AttrTag.SESSION_KEY)
          break
        }
      }
    }
    expect(playSessionKey).toBeTruthy()

    // Now stop and extract TEARDOWN sessionKey
    const before = device.received.length
    session.stop()
    await delay(200)

    const stopPackets = device.received.slice(before)
    const { found, attrs } = findTeardown(stopPackets, TEST_P2P_KEY, TEST_LINK_KEY)
    expect(found).toBe(true)

    const teardownSessionKey = getStringAttr(attrs, AttrTag.SESSION_KEY)
    expect(teardownSessionKey).toBe(playSessionKey)
  })

  it('stop() does not throw on an idle session (no device session established)', () => {
    session = new P2PSession(makeConfig(device.port))

    // Session is idle — no start(), no deviceSessionId, no socket
    expect(() => session!.stop()).not.toThrow()
  })
})
