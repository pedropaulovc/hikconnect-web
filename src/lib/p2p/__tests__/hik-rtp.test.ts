import { describe, it, expect, vi } from 'vitest'
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto'
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

  describe('NAL type 49 decryption', () => {
    const VERIFICATION_CODE = 'ABCDEF'
    const aesKey = createHash('md5').update(VERIFICATION_CODE).digest()

    function encryptBlock(plaintext: Buffer): Buffer {
      const cipher = createCipheriv('aes-128-ecb', aesKey, null)
      cipher.setAutoPadding(false)
      return Buffer.concat([cipher.update(plaintext), cipher.final()])
    }

    /** Build a Hik-RTP packet containing an encrypted NAL (type 49).
     *  Encrypts first 16 bytes of originalNal. The encrypted result's first byte
     *  must parse as NAL type 49 for our extractor to recognize it — we find such
     *  a plaintext by constructing one whose AES-ECB ciphertext starts with 0x62. */
    function buildType49Packet(encryptedNalData: Buffer): Buffer {
      const packet = Buffer.alloc(12 + encryptedNalData.length)
      packet.writeUInt16BE(0x8060, 0)
      encryptedNalData.copy(packet, 12)
      return packet
    }

    it('unwraps type-49 NAL to restore original NAL type from extension', () => {
      const extractor = new HikRtpExtractor()
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      // Build a type-49 NAL with extension encoding original type 19 (IDR_W_RADL)
      // Extension byte: top 2 bits = 0 (no extra bytes), bottom 6 bits = 19
      const type49Nal = Buffer.alloc(32)
      type49Nal[0] = 0x62  // NAL type 49
      type49Nal[1] = 0x01
      type49Nal[2] = 0x13  // extension: type 19, 0 extra bytes
      type49Nal[3] = 0x00  // flag byte
      type49Nal.fill(0xaa, 4) // slice data

      const packet = Buffer.alloc(12 + type49Nal.length)
      packet.writeUInt16BE(0x8060, 0)
      type49Nal.copy(packet, 12)
      extractor.processPacket(packet)
      extractor.flush() // flush accumulated fragments

      expect(nals.length).toBe(1)
      const nalType = (nals[0][4] >> 1) & 0x3f
      expect(nalType).toBe(19) // IDR_W_RADL
    })

    it('accumulates type-49 fragments and emits on non-49 boundary', () => {
      const extractor = new HikRtpExtractor()
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      // First type-49 fragment (with extension: type 19)
      const frag1 = Buffer.alloc(20)
      frag1[0] = 0x62; frag1[1] = 0x01
      frag1[2] = 0x13 // type 19, 0 extra bytes
      frag1[3] = 0x00 // flag
      frag1.fill(0xbb, 4)
      const pkt1 = Buffer.alloc(12 + 20); pkt1.writeUInt16BE(0x8060, 0); frag1.copy(pkt1, 12)

      // Second type-49 fragment (continuation)
      const frag2 = Buffer.alloc(16)
      frag2[0] = 0x62; frag2[1] = 0x01
      frag2.fill(0xcc, 2)
      const pkt2 = Buffer.alloc(12 + 16); pkt2.writeUInt16BE(0x8060, 0); frag2.copy(pkt2, 12)

      // Non-type-49 packet (PPS) triggers flush
      const pps = Buffer.alloc(12 + 4)
      pps.writeUInt16BE(0x8060, 0)
      pps[12] = 0x44; pps[13] = 0x01; pps[14] = 0xe0; pps[15] = 0x76 // PPS

      extractor.processPacket(pkt1)
      extractor.processPacket(pkt2)
      expect(nals.length).toBe(0) // not flushed yet

      extractor.processPacket(pps)
      expect(nals.length).toBe(2) // flushed type-49 + PPS

      // First emitted NAL should be assembled type-49 with type 19
      const assembledType = (nals[0][4] >> 1) & 0x3f
      expect(assembledType).toBe(19)
      // Second is PPS
      const ppsType = (nals[1][4] >> 1) & 0x3f
      expect(ppsType).toBe(34)
    })
  })
})
