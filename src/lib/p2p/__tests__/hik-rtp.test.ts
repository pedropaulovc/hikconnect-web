import { describe, it, expect, vi } from 'vitest'
import { HikRtpExtractor } from '../hik-rtp'

describe('HikRtpExtractor', () => {
  it('ignores non-video packet types', () => {
    const extractor = new HikRtpExtractor()
    const onNal = vi.fn()
    extractor.on('nalUnit', onNal)

    // 0x807f = control packet (not video)
    const controlPacket = Buffer.alloc(64)
    controlPacket.writeUInt16BE(0x807f, 0)
    extractor.processPacket(controlPacket)

    expect(onNal).not.toHaveBeenCalled()
  })

  it('processes 0x8060 video packets with sub-header', () => {
    const extractor = new HikRtpExtractor()
    const nals: Buffer[] = []
    extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

    // Build: 12B Hik-RTP + 13B sub-header (0x0d, 0x90 first, ...) + VPS NAL
    const packet = Buffer.alloc(12 + 13 + 4)
    packet.writeUInt16BE(0x8060, 0)  // Hik-RTP type
    packet[12] = 0x0d               // sub-header marker
    packet[13] = 0x90               // first fragment
    // Bytes 14-24: sub-header padding
    // Bytes 25-28: VPS NAL data
    packet[25] = 0x40  // VPS NAL type (32 << 1)
    packet[26] = 0x01
    packet[27] = 0x0c
    packet[28] = 0x01

    extractor.processPacket(packet)
    expect(nals.length).toBe(1)
    // NAL should have Annex B start code prefix
    expect(nals[0].subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]))
    // VPS NAL type
    expect((nals[0][4] >> 1) & 0x3f).toBe(32)
  })

  it('handles packets without sub-header', () => {
    const extractor = new HikRtpExtractor()
    const nals: Buffer[] = []
    extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

    // Build: 12B Hik-RTP + direct NAL data (no 0x0d sub-header)
    const packet = Buffer.alloc(12 + 4)
    packet.writeUInt16BE(0x8060, 0)
    packet[12] = 0x42  // SPS NAL type (33 << 1)
    packet[13] = 0x01
    packet[14] = 0x01
    packet[15] = 0x60

    extractor.processPacket(packet)
    expect(nals.length).toBe(1)
    expect((nals[0][4] >> 1) & 0x3f).toBe(33) // SPS
  })

  it('handles length-prefixed NAL format', () => {
    const extractor = new HikRtpExtractor()
    const nals: Buffer[] = []
    extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

    // Build: 12B Hik-RTP + 13B sub-header + length-prefixed NAL
    // Length-prefixed: 00 01 00 04 [4 bytes of VPS]
    const packet = Buffer.alloc(12 + 13 + 8)
    packet.writeUInt16BE(0x8060, 0)
    packet[12] = 0x0d  // sub-header
    packet[13] = 0x90  // first fragment
    // After 13-byte sub-header (offset 25):
    packet[25] = 0x00  // length prefix type
    packet[26] = 0x01  // type counter
    packet[27] = 0x00  // length high
    packet[28] = 0x04  // length low (4 bytes)
    packet[29] = 0x40  // VPS data
    packet[30] = 0x0e
    packet[31] = 0x48
    packet[32] = 0x4b

    extractor.processPacket(packet)
    expect(nals.length).toBe(1)
    // Should emit the 4-byte VPS data with start code
    expect(nals[0].length).toBe(4 + 4) // 4 start code + 4 data
    expect((nals[0][4] >> 1) & 0x3f).toBe(32) // VPS
  })

  describe('NAL type 49 FU reassembly (RFC 7798)', () => {
    /** Build a Hik-RTP packet with raw NAL data (no sub-header). */
    function buildPacket(nalData: Buffer): Buffer {
      const packet = Buffer.alloc(12 + nalData.length)
      packet.writeUInt16BE(0x8060, 0)
      nalData.copy(packet, 12)
      return packet
    }

    it('reassembles FU start+end into a complete NAL', () => {
      const extractor = new HikRtpExtractor()
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      // FU start: PayloadHdr(type=49) + FU header(S=1, E=0, fuType=19=IDR)
      const start = Buffer.alloc(20)
      start[0] = 0x62  // type 49 PayloadHdr byte 1
      start[1] = 0x01  // PayloadHdr byte 2
      start[2] = 0x93  // FU: S=1(0x80), E=0, fuType=19(0x13) → 0x93
      start.fill(0xaa, 3) // FU payload (slice data)
      extractor.processPacket(buildPacket(start))
      expect(nals.length).toBe(0) // not emitted yet

      // FU end: PayloadHdr(type=49) + FU header(S=0, E=1, fuType=19)
      const end = Buffer.alloc(12)
      end[0] = 0x62; end[1] = 0x01
      end[2] = 0x53  // FU: S=0, E=1(0x40), fuType=19(0x13) → 0x53
      end.fill(0xbb, 3)
      extractor.processPacket(buildPacket(end))

      expect(nals.length).toBe(1)
      // Reconstructed NAL type should be 19 (IDR)
      const nalType = (nals[0][4] >> 1) & 0x3f
      expect(nalType).toBe(19)
      // NAL data = reconstructed header(2B) + start payload(17B) + end payload(9B) = 28B
      expect(nals[0].length).toBe(4 + 2 + 17 + 9) // start code + header + payloads
    })

    it('accumulates start + continuation + end fragments', () => {
      const extractor = new HikRtpExtractor()
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      // Start (S=1, fuType=19)
      const start = Buffer.from([0x62, 0x01, 0x93, 0x11, 0x22, 0x33])
      extractor.processPacket(buildPacket(start))

      // Continuation (S=0, E=0)
      const cont = Buffer.from([0x62, 0x01, 0x13, 0x44, 0x55, 0x66])
      extractor.processPacket(buildPacket(cont))
      expect(nals.length).toBe(0) // still accumulating

      // End (S=0, E=1)
      const end = Buffer.from([0x62, 0x01, 0x53, 0x77, 0x88, 0x99])
      extractor.processPacket(buildPacket(end))

      expect(nals.length).toBe(1)
      const nalType = (nals[0][4] >> 1) & 0x3f
      expect(nalType).toBe(19)
      // Payload: start(3B) + cont(3B) + end(3B) = 9B data + 2B header
      expect(nals[0].subarray(4)).toEqual(Buffer.from([
        0x26, 0x01,                   // reconstructed IDR header
        0x11, 0x22, 0x33,             // start payload
        0x44, 0x55, 0x66,             // cont payload (FU header stripped)
        0x77, 0x88, 0x99,             // end payload (FU header stripped)
      ]))
    })

    it('discards incomplete FU when non-FU NAL arrives (prevents decoder corruption)', () => {
      const extractor = new HikRtpExtractor()
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      // Start fragment (no end) — incomplete FU
      const start = Buffer.from([0x62, 0x01, 0x93, 0xaa, 0xbb])
      extractor.processPacket(buildPacket(start))

      // PPS NAL triggers discard of incomplete FU
      const pps = Buffer.from([0x44, 0x01, 0xe0, 0x76])
      extractor.processPacket(buildPacket(pps))

      expect(nals.length).toBe(1) // only PPS, incomplete FU discarded
      expect((nals[0][4] >> 1) & 0x3f).toBe(34) // PPS
    })

    it('handles consecutive FUs (multiple slice segments)', () => {
      const extractor = new HikRtpExtractor()
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      // FU 1: IDR slice (fuType=19)
      extractor.processPacket(buildPacket(Buffer.from([0x62, 0x01, 0x93, 0x11]))) // S=1
      extractor.processPacket(buildPacket(Buffer.from([0x62, 0x01, 0x53, 0x22]))) // E=1

      // FU 2: TRAIL_R slice (fuType=1)
      extractor.processPacket(buildPacket(Buffer.from([0x62, 0x01, 0x81, 0x33]))) // S=1
      extractor.processPacket(buildPacket(Buffer.from([0x62, 0x01, 0x41, 0x44]))) // E=1

      expect(nals.length).toBe(2)
      expect((nals[0][4] >> 1) & 0x3f).toBe(19) // IDR
      expect((nals[1][4] >> 1) & 0x3f).toBe(1)  // TRAIL_R
    })
  })
})
