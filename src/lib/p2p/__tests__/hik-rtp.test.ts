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
})
