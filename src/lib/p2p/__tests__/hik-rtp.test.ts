import { describe, it, expect, vi } from 'vitest'
import { createHash, createCipheriv } from 'node:crypto'
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

    function buildEncryptedNalPacket(originalNalBody: Buffer): Buffer {
      // Build a type-49 wrapped NAL:
      // [2B type-49 header 0x62 0x01] [16B encrypted(orig_hdr + data)] [plaintext rest]
      const type49Header = Buffer.from([0x62, 0x01]) // NAL type 49
      const bodyToEncrypt = originalNalBody.subarray(0, 16)
      const plaintextRest = originalNalBody.subarray(16)
      const encrypted = encryptBlock(bodyToEncrypt)
      const nal = Buffer.concat([type49Header, encrypted, plaintextRest])

      // Wrap in Hik-RTP: [12B header] [NAL data]
      const packet = Buffer.alloc(12 + nal.length)
      packet.writeUInt16BE(0x8060, 0)
      nal.copy(packet, 12)
      return packet
    }

    it('decrypts NAL type 49 to restore original NAL type', () => {
      const extractor = new HikRtpExtractor(VERIFICATION_CODE)
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      // Original NAL: type 1 (TRAIL_R) slice, 32 bytes total
      const originalNal = Buffer.alloc(32)
      originalNal[0] = 0x02 // NAL type 1 (TRAIL_R): (1 << 1) = 0x02
      originalNal[1] = 0x01 // temporal_id = 1
      originalNal.fill(0xaa, 2) // fake slice data

      const packet = buildEncryptedNalPacket(originalNal)
      extractor.processPacket(packet)

      expect(nals.length).toBe(1)
      // After Annex B start code (4 bytes), the NAL type should be restored
      const nalType = (nals[0][4] >> 1) & 0x3f
      expect(nalType).toBe(1) // TRAIL_R, not 49
    })

    it('decrypts first 16 bytes and preserves plaintext rest', () => {
      const extractor = new HikRtpExtractor(VERIFICATION_CODE)
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      // Original NAL: 48 bytes (2B header + 46B payload)
      const originalNal = Buffer.alloc(48)
      originalNal[0] = 0x26 // NAL type 19 (IDR_W_RADL): (19 << 1) = 0x26
      originalNal[1] = 0x01
      for (let i = 2; i < 48; i++) originalNal[i] = i & 0xff

      const packet = buildEncryptedNalPacket(originalNal)
      extractor.processPacket(packet)

      expect(nals.length).toBe(1)
      const emitted = nals[0].subarray(4) // skip Annex B start code

      // First 16 bytes should match original (decrypted)
      expect(emitted.subarray(0, 16)).toEqual(originalNal.subarray(0, 16))
      // Bytes 16+ should also match (plaintext passthrough)
      expect(emitted.subarray(16)).toEqual(originalNal.subarray(16))
    })

    it('passes through NAL type 49 without decryption when no key', () => {
      const extractor = new HikRtpExtractor() // no verification code
      const nals: Buffer[] = []
      extractor.on('nalUnit', (nal: Buffer) => nals.push(nal))

      const fakeNal = Buffer.alloc(32)
      fakeNal[0] = 0x62 // NAL type 49
      fakeNal[1] = 0x01

      const packet = Buffer.alloc(12 + 32)
      packet.writeUInt16BE(0x8060, 0)
      fakeNal.copy(packet, 12)
      extractor.processPacket(packet)

      expect(nals.length).toBe(1)
      // Should still be type 49 (passed through, not decrypted)
      const nalType = (nals[0][4] >> 1) & 0x3f
      expect(nalType).toBe(49)
    })
  })
})
