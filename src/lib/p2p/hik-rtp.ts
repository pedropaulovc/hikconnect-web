/**
 * Hik-RTP frame extractor — converts SRT data payloads into H.265 Annex B stream.
 *
 * Format (from VPS capture analysis):
 * - SRT data payload starts with 12-byte Hik-RTP header
 * - After header: 13-byte sub-frame header (0x0d + 4B + sync pattern a7 6d 4e 7e 55 66 77 88)
 * - After sub-header: NAL unit data
 *   - VPS/SPS/PPS (NAL types 32-34): plaintext
 *   - Slice data: AES-128-ECB encrypted with MD5(verificationCode)
 *   - Length-prefixed frames (0x00 0x01/0x02 + 2B length): SPS info
 */

import { createHash, createDecipheriv } from 'node:crypto'
import { EventEmitter } from 'node:events'

const HIK_RTP_HEADER_LEN = 12
const SUB_HEADER_SYNC = Buffer.from([0xa7, 0x6d, 0x4e, 0x7e, 0x55, 0x66, 0x77, 0x88])
const SUB_HEADER_LEN = 13 // 0x0d + 4 bytes + 8 bytes sync
const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

export class HikRtpExtractor extends EventEmitter {
  private aesKey: Buffer
  private nalCount = 0
  private fragmentBuffer: Buffer[] = []
  private inFragment = false

  constructor(verificationCode: string) {
    super()
    this.aesKey = createHash('md5').update(verificationCode).digest()
  }

  /**
   * Process a raw SRT data payload (the 'data' event from P2PSession).
   * Emits 'nalUnit' events with Annex B formatted H.265 data.
   */
  processPacket(payload: Buffer): void {
    const type = payload.readUInt16BE(0)

    // Only process video data packets (0x8060, 0x8050, 0x8051)
    if (type !== 0x8060 && type !== 0x8050 && type !== 0x8051) {
      return
    }

    // Strip 12-byte Hik-RTP header
    if (payload.length <= HIK_RTP_HEADER_LEN) return
    const rtpPayload = payload.subarray(HIK_RTP_HEADER_LEN)

    // Strip 13-byte Hik-RTP sub-header (starts with 0x0d)
    if (rtpPayload[0] !== 0x0d || rtpPayload.length <= SUB_HEADER_LEN) return

    const subType = rtpPayload[1] // 0x90=first, 0x80=middle, 0xa0=last fragment
    const nalData = rtpPayload.subarray(SUB_HEADER_LEN)

    // Fragment reassembly based on sub-type byte:
    // 0x90: first fragment of a frame (may also be complete if only one packet)
    // 0x80: middle fragment (continuation)
    // 0xa0: last fragment
    // 0xd0: standalone single-packet frame?

    // Each sub-frame's data may contain one or more NAL units.
    // Don't try fragment reassembly — just pass each packet's data through.
    // The H.265 Annex B start codes in processNalUnit will handle framing.
    this.processNalUnit(nalData)
  }

  private processInitPacket(payload: Buffer): void {
    // The 0x0100 packet has: Hik-RTP extended header + IMKH header + padding + initial NALs
    // Find sub-frame headers within the packet
    for (let i = HIK_RTP_HEADER_LEN; i < payload.length - SUB_HEADER_LEN; i++) {
      if (payload[i] === 0x0d && payload.subarray(i + 5, i + 13).equals(SUB_HEADER_SYNC)) {
        // Find next sub-frame header
        let end = payload.length
        for (let j = i + SUB_HEADER_LEN; j < payload.length - SUB_HEADER_LEN; j++) {
          if (payload[j] === 0x0d && payload.subarray(j + 5, j + 13).equals(SUB_HEADER_SYNC)) {
            end = j
            break
          }
        }
        const nalData = payload.subarray(i + SUB_HEADER_LEN, end)
        this.processNalUnit(nalData)
      }
    }
  }

  private processNalUnit(data: Buffer): void {
    if (data.length < 2) return

    const firstByte = data[0]
    const nalType = (firstByte >> 1) & 0x3f

    // Length-prefixed format: 2-byte type prefix + 2-byte length + NAL data
    if (firstByte === 0x00 && data[1] <= 0x02 && data.length > 4) {
      const dataLen = data.readUInt16BE(2)
      if (dataLen > 0 && dataLen <= data.length - 4) {
        this.emitNal(data.subarray(4, 4 + dataLen))
        return
      }
    }

    // Plaintext VPS (32), SPS (33), PPS (34)
    if (nalType >= 32 && nalType <= 34) {
      this.emitNal(data)
      return
    }

    // Encrypted slice data — AES-128-ECB decrypt first block only (partial encryption)
    // Hikvision uses partial encryption: first 16 bytes of each slice
    if (data.length >= 16) {
      const decrypted = this.decryptSlice(data)
      const decNalType = (decrypted[0] >> 1) & 0x3f
      // If decrypted NAL type is valid H.265 (0-40), use decrypted data
      if (decNalType <= 40) {
        this.emitNal(decrypted)
        return
      }
    }
    // Not encrypted or decryption didn't help — emit raw
    this.emitNal(data)
  }

  private decryptSlice(data: Buffer): Buffer {
    // Full AES-128-ECB decryption of all complete 16-byte blocks
    const blockSize = 16
    if (data.length < blockSize) return data

    const fullBlocks = Math.floor(data.length / blockSize) * blockSize
    const decipher = createDecipheriv('aes-128-ecb', this.aesKey, null)
    decipher.setAutoPadding(false)
    const decrypted = decipher.update(data.subarray(0, fullBlocks))

    if (fullBlocks === data.length) return decrypted
    return Buffer.concat([decrypted, data.subarray(fullBlocks)])
  }

  private emitNal(data: Buffer): void {
    if (data.length === 0) return
    this.nalCount++

    // Emit with Annex B start code prefix
    const annexB = Buffer.concat([ANNEX_B_START_CODE, data])
    this.emit('nalUnit', annexB)

    // Also emit raw for analysis
    const nalType = (data[0] >> 1) & 0x3f
    if (this.nalCount <= 10 || this.nalCount % 500 === 0) {
      const names: Record<number, string> = {
        0: 'TRAIL_N', 1: 'TRAIL_R', 19: 'IDR_W_RADL', 20: 'IDR_N_LP',
        21: 'CRA_NUT', 32: 'VPS', 33: 'SPS', 34: 'PPS',
      }
      console.log(`[H265] NAL #${this.nalCount}: type=${nalType} (${names[nalType] ?? '?'}) size=${data.length}B`)
    }
  }
}
