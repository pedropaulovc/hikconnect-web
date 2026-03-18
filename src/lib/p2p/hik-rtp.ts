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
  private initialized = false
  private nalCount = 0

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

    // Skip non-video packets
    // Known Hik-RTP types from Ghidra HandleVideoStream:
    // 0x0100/0x0200: session init, 0x8060/0x8050/0x8051: video data, 0x807f: control
    if (type !== 0x8060 && type !== 0x8050 && type !== 0x8051 &&
        type !== 0x0100 && type !== 0x0200 && type !== 0x807f) {
      if (this.nalCount === 0) {
        console.log(`[HikRTP] Skipping packet type=0x${type.toString(16)} size=${payload.length}B`)
      }
      return
    }

    // Session init packet (0x0100): contains IMKH header + initial NALs
    if (type === 0x0100 || type === 0x0200) {
      this.processInitPacket(payload)
      return
    }

    // Video data packet (0x8060 etc): strip Hik-RTP header
    if (payload.length <= HIK_RTP_HEADER_LEN) return
    const rtpPayload = payload.subarray(HIK_RTP_HEADER_LEN)

    // Check for sub-frame header (0x0d + sync pattern at offset 5)
    if (rtpPayload[0] === 0x0d && rtpPayload.length > SUB_HEADER_LEN &&
        rtpPayload.subarray(5, 13).equals(SUB_HEADER_SYNC)) {
      const nalData = rtpPayload.subarray(SUB_HEADER_LEN)
      this.processNalUnit(nalData)
    } else {
      // No sub-header — raw continuation data
      this.processNalUnit(rtpPayload)
    }
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
    this.initialized = true
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

    // Encrypted slice data — AES-128-ECB decrypt
    if (data.length >= 16) {
      const decrypted = this.decryptSlice(data)
      this.emitNal(decrypted)
      return
    }

    // Small unrecognized NAL — emit as-is
    this.emitNal(data)
  }

  private decryptSlice(data: Buffer): Buffer {
    const blockSize = 16
    const fullBlocks = Math.floor(data.length / blockSize) * blockSize

    if (fullBlocks === 0) return data

    const decipher = createDecipheriv('aes-128-ecb', this.aesKey, null)
    decipher.setAutoPadding(false)
    const decrypted = decipher.update(data.subarray(0, fullBlocks))

    if (fullBlocks === data.length) {
      return decrypted
    }

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
