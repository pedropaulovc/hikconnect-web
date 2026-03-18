import { describe, it, expect, vi } from 'vitest'
import { HikRtpExtractor } from '../hik-rtp'

describe('HikRtpExtractor', () => {
  it('ignores non-video packet types', () => {
    const extractor = new HikRtpExtractor('ABCDEF')
    const onNal = vi.fn()
    extractor.on('nalUnit', onNal)

    // 0x807f = control packet (not video)
    const controlPacket = Buffer.alloc(64)
    controlPacket.writeUInt16BE(0x807f, 0)
    extractor.processPacket(controlPacket)

    expect(onNal).not.toHaveBeenCalled()
  })

  it('processes 0x8060 video packets', () => {
    const extractor = new HikRtpExtractor('ABCDEF')
    const nals: Buffer[] = []
    extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

    // Build a minimal 0x8060 packet:
    // 12B Hik-RTP header + 13B sub-header + NAL data
    const packet = Buffer.alloc(12 + 13 + 8)
    packet.writeUInt16BE(0x8060, 0)  // Hik-RTP type
    packet[12] = 0x0d               // sub-header marker
    // Bytes 13-24: sub-header padding
    // Bytes 25+: NAL data
    packet[25] = 0x40  // VPS NAL type
    packet[26] = 0x01
    packet[27] = 0x0c
    packet[28] = 0x01

    extractor.processPacket(packet)
    expect(nals.length).toBe(1)
    // NAL should have Annex B start code prefix
    expect(nals[0].subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]))
  })

  it('emits VPS/SPS/PPS as plaintext', () => {
    const extractor = new HikRtpExtractor('ABCDEF')
    const nals: Buffer[] = []
    extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

    // VPS (type 32): first byte = 0x40 (32 << 1 = 64 = 0x40)
    const vpsPacket = Buffer.alloc(12 + 13 + 4)
    vpsPacket.writeUInt16BE(0x8060, 0)
    vpsPacket[12] = 0x0d
    vpsPacket[25] = 0x40  // VPS
    vpsPacket[26] = 0x01

    extractor.processPacket(vpsPacket)
    expect(nals.length).toBe(1)

    // Check the NAL type after start code
    const nalType = (nals[0][4] >> 1) & 0x3f
    expect(nalType).toBe(32) // VPS
  })

  it('handles length-prefixed NAL format', () => {
    const extractor = new HikRtpExtractor('ABCDEF')
    const nals: Buffer[] = []
    extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

    // Length-prefixed: 00 01 00 04 [4 bytes of VPS]
    const packet = Buffer.alloc(12 + 13 + 8)
    packet.writeUInt16BE(0x8060, 0)
    packet[12] = 0x0d
    // After 13-byte sub-header (offset 25):
    packet[25] = 0x00  // type prefix
    packet[26] = 0x01  // type prefix
    packet[27] = 0x00  // length high
    packet[28] = 0x04  // length low (4 bytes)
    packet[29] = 0x40  // VPS data start
    packet[30] = 0x0e
    packet[31] = 0x48
    packet[32] = 0x4b

    extractor.processPacket(packet)
    expect(nals.length).toBe(1)
    // Should emit the 4-byte VPS data with start code
    expect(nals[0].length).toBe(4 + 4) // 4 start code + 4 data
  })
})
