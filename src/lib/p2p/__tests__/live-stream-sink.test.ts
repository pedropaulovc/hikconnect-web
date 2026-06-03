/**
 * Task 1 (export-footage plan): LiveStream must be sink-pluggable.
 *
 * These tests drive the *public seam* only:
 *  - the `VideoSink` type/module exists with start/write/stop,
 *  - `LiveStream`'s constructor takes a second arg `sinkFactory(config) => VideoSink`,
 *  - the factory is invoked (with the config) during start(), its sink started,
 *    the decoded stream written to it, and it is stopped on stop(),
 *  - the default factory (no second arg) still wires an HLS pipe so the existing
 *    live + playback routes keep working (playlistPath populated).
 *
 * We never reach a live NVR: P2PSession.start/stop are stubbed and we emit real
 * `'data'` events on the captured session instance to exercise the data path the
 * same way the device would.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LiveStream, type LiveStreamConfig } from '../live-stream'
import type { VideoSink } from '../../hls/video-sink'
import { P2PSession } from '../p2p-session'

type SpySink = VideoSink & {
  writes: Buffer[]
  started: number
  stopped: number
}

function fakeSink(): SpySink {
  const s = {
    writes: [] as Buffer[],
    started: 0,
    stopped: 0,
    start() {
      s.started += 1
    },
    write(b: Buffer) {
      s.writes.push(b)
    },
    stop() {
      s.stopped += 1
    },
  }
  return s
}

/** Minimal config; the stubbed P2PSession ignores the network-y fields. */
function makeConfig(over: Partial<LiveStreamConfig> = {}): LiveStreamConfig {
  return {
    deviceSerial: 'DS-TEST',
    deviceIp: '1.2.3.4',
    devicePort: 6000,
    p2pServers: [{ host: '9.9.9.9', port: 6000 }],
    p2pKey: Buffer.alloc(32),
    p2pLinkKey: Buffer.alloc(32),
    p2pKeyVersion: 1,
    p2pKeySaltIndex: 0,
    p2pKeySaltVer: 1,
    sessionToken: 'tok',
    userId: 'u1',
    clientId: 1,
    channelNo: 1,
    streamType: 0,
    busType: 1,
    hls: { outputDir: '/tmp/hik-test-sink' },
    ...over,
  }
}

/**
 * Stub P2PSession network lifecycle and capture every instance LiveStream
 * constructs so the test can emit `'data'` events on it exactly like the device.
 */
let sessions: P2PSession[] = []
let startSpy: ReturnType<typeof vi.spyOn>
let stopSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  sessions = []
  // Record each constructed session. The constructor still runs (it's an
  // EventEmitter); we just neuter the network methods.
  const origStart = P2PSession.prototype.start
  startSpy = vi.spyOn(P2PSession.prototype, 'start').mockImplementation(function (
    this: P2PSession,
  ) {
    sessions.push(this)
    return Promise.resolve()
  })
  // keep a ref to avoid unused-var lint while documenting intent
  void origStart
  stopSpy = vi
    .spyOn(P2PSession.prototype, 'stop')
    .mockImplementation(function (this: P2PSession) {
      return Promise.resolve()
    })
})

afterEach(() => {
  startSpy.mockRestore()
  stopSpy.mockRestore()
})

/** A playback (busType=2) Hik-RTP packet: 12B header (0x8050) + PS payload. */
function playbackPacket(psBody: Buffer): Buffer {
  const pkt = Buffer.alloc(12 + psBody.length)
  pkt.writeUInt16BE(0x8050, 0)
  psBody.copy(pkt, 12)
  return pkt
}

/** A live (busType=1) 0x8060 video packet carrying a single VPS NAL (no sub-header). */
function liveVpsPacket(): Buffer {
  const pkt = Buffer.alloc(12 + 4)
  pkt.writeUInt16BE(0x8060, 0)
  pkt[12] = 0x40 // VPS NAL type (32 << 1)
  pkt[13] = 0x01
  pkt[14] = 0x0c
  pkt[15] = 0x01
  return pkt
}

describe('LiveStream pluggable sink', () => {
  it('accepts a sinkFactory and calls it with the config, then starts that sink', async () => {
    const sink = fakeSink()
    const factory = vi.fn((_c: LiveStreamConfig) => sink)
    const config = makeConfig()
    const stream = new LiveStream(config, factory)

    await stream.start()

    expect(factory).toHaveBeenCalledTimes(1)
    // Factory receives the LiveStream config (so MP4 sink can read start/stop time etc.)
    expect(factory.mock.calls[0][0]).toBe(config)
    expect(sink.started).toBe(1)
    expect(stream.state).toBe('streaming')

    await stream.stop()
  })

  it('exposes the injected sink via getSink() (export route reads MP4 progress through it)', async () => {
    const sink = fakeSink()
    const stream = new LiveStream(makeConfig(), () => sink)

    // Before start the sink may be null; after start it must be the injected one.
    await stream.start()
    expect(stream.getSink()).toBe(sink)

    await stream.stop()
  })

  it('writes the playback (busType=2) PS payload — header stripped — to the injected sink', async () => {
    const sink = fakeSink()
    const config = makeConfig({ busType: 2 })
    const stream = new LiveStream(config, () => sink)
    await stream.start()

    expect(sessions.length).toBe(1)
    const psBody = Buffer.from([0x00, 0x00, 0x01, 0xba, 0xaa, 0xbb, 0xcc, 0xdd])
    sessions[0].emit('data', playbackPacket(psBody))

    // Exactly the 12-byte-stripped PS bytes reach the sink — not the raw packet,
    // and not Annex-B NALs (that would mean it ran the live extractor by mistake).
    expect(sink.writes.length).toBe(1)
    expect(sink.writes[0]).toEqual(psBody)

    await stream.stop()
  })

  it('writes live (busType=1) Annex-B HEVC NALs from the extractor to the injected sink', async () => {
    const sink = fakeSink()
    const config = makeConfig({ busType: 1 })
    const stream = new LiveStream(config, () => sink)
    await stream.start()

    expect(sessions.length).toBe(1)
    sessions[0].emit('data', liveVpsPacket())

    expect(sink.writes.length).toBe(1)
    const nal = sink.writes[0]
    // Live path must reassemble to an Annex-B NAL (start code + VPS), proving it
    // went through HikRtpExtractor and not the playback passthrough.
    expect(nal.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01]))
    expect((nal[4] >> 1) & 0x3f).toBe(32) // VPS

    await stream.stop()
  })

  it('ignores control/non-video packets but still forwards real video on the same sink', async () => {
    const sink = fakeSink()
    const stream = new LiveStream(makeConfig({ busType: 2 }), () => sink)
    await stream.start()

    const control = Buffer.alloc(64)
    control.writeUInt16BE(0x807f, 0) // control sub-session keepalive, not video
    sessions[0].emit('data', control)
    // Not vacuous: prove the sink IS wired by following with a real video packet —
    // only the video payload (1 write) must land, the control packet dropped.
    const psBody = Buffer.from([0x00, 0x00, 0x01, 0xba, 0x11, 0x22])
    sessions[0].emit('data', playbackPacket(psBody))

    expect(sink.writes.length).toBe(1)
    expect(sink.writes[0]).toEqual(psBody)
    await stream.stop()
  })

  it('stops the injected sink on stop()', async () => {
    const sink = fakeSink()
    const stream = new LiveStream(makeConfig(), () => sink)
    await stream.start()
    expect(sink.stopped).toBe(0)

    await stream.stop()

    expect(sink.stopped).toBe(1)
    expect(stream.state).toBe('stopped')
  })

  it('stop() is idempotent — does not stop the sink twice', async () => {
    const sink = fakeSink()
    const stream = new LiveStream(makeConfig(), () => sink)
    await stream.start()

    await stream.stop()
    await stream.stop()

    expect(sink.stopped).toBe(1)
  })

  it('does not write to the sink after stop()', async () => {
    const sink = fakeSink()
    const stream = new LiveStream(makeConfig({ busType: 2 }), () => sink)
    await stream.start()
    const session = sessions[0]

    // Not vacuous: one real write lands BEFORE stop, then none after teardown.
    session.emit('data', playbackPacket(Buffer.from([0x00, 0x00, 0x01, 0xba])))
    expect(sink.writes.length).toBe(1)

    await stream.stop()

    // Late device packet after teardown must not reach a stopped sink.
    session.emit('data', playbackPacket(Buffer.from([0xde, 0xad, 0xbe, 0xef])))
    expect(sink.writes.length).toBe(1)
  })
})

describe('LiveStream default sink (HLS) — existing routes keep working', () => {
  it('without a sinkFactory, falls back to an HLS pipe and exposes playlistPath', async () => {
    const config = makeConfig({ hls: { outputDir: '/tmp/hik-test-default-hls' } })
    const stream = new LiveStream(config)

    await stream.start()

    // The live + playback routes read stream.playlistPath; the default HLS sink
    // must populate it (ends in the m3u8 under the configured outputDir).
    expect(stream.playlistPath).toBe('/tmp/hik-test-default-hls/stream.m3u8')

    await stream.stop()
  })
})

describe('VideoSink contract surface', () => {
  it('FfmpegHlsPipe implements the VideoSink shape', async () => {
    const { FfmpegHlsPipe } = await import('../../hls/ffmpeg-pipe')
    const pipe = new FfmpegHlsPipe({ outputDir: '/tmp/hik-test-iface' })
    const sink: VideoSink = pipe // must be assignable to VideoSink
    expect(typeof sink.start).toBe('function')
    expect(typeof sink.write).toBe('function')
    expect(typeof sink.stop).toBe('function')
  })
})
