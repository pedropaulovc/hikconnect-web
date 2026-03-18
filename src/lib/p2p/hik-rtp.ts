/**
 * Hik-RTP frame extractor — converts SRT data payloads into H.265 Annex B stream.
 *
 * Format (from VPS capture analysis):
 * - SRT data payload starts with 12-byte Hik-RTP header
 * - After header: 13-byte sub-frame header (0x0d + 4B + sync pattern a7 6d 4e 7e 55 66 77 88)
 * - After sub-header: NAL unit data
 *   - VPS/SPS/PPS (NAL types 32-34): parameter sets
 *   - Slice data (NAL types 0-21): video frames
 *   - Length-prefixed frames (0x00 0x01/0x02 + 2B length): SPS info
 *
 * Encryption (from Ghidra RE of libPlayCtrl.so IDMXAESDecryptFrame):
 * - NAL type 49 = Hikvision encrypted NAL wrapper
 * - Key = MD5(verification_code), e.g. MD5("ABCDEF") for default code
 * - For H.265: AES-128-ECB, only first 16 bytes of NAL body decrypted (partial encryption)
 * - After decryption, the original NAL header is restored from the decrypted bytes
 */

import { EventEmitter } from 'node:events'
import { createHash, createDecipheriv } from 'node:crypto'

const HIK_RTP_HEADER_LEN = 12
// SUB_HEADER_SYNC varies per session — not used for matching anymore
const SUB_HEADER_LEN = 13 // 0x0d + 4 bytes + 8 bytes sync
const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])
const HIK_ENCRYPTED_NAL_TYPE = 49

function deriveAesKey(verificationCode: string): Buffer {
  return createHash('md5').update(verificationCode).digest()
}

/**
 * Decrypt a Hikvision type-49 encrypted NAL unit.
 * Per IDMXAESDecryptFrame in libPlayCtrl.so: for H.265, only the first 16 bytes
 * of the NAL body (after 2-byte HEVC NAL header) are AES-128-ECB encrypted.
 * The decrypted bytes contain the original NAL header + initial payload.
 */
function decryptNal(data: Buffer, aesKey: Buffer): Buffer {
  // Encrypted NAL structure:
  //   [2B type-49 wrapper header] [16B encrypted block] [plaintext rest...]
  // The encrypted block contains [2B original NAL header] [14B initial payload].
  // After decryption, drop the type-49 wrapper and emit from byte 2 onward.
  const WRAPPER_LEN = 2
  const AES_BLOCK_SIZE = 16

  if (data.length < WRAPPER_LEN + AES_BLOCK_SIZE) {
    return data // too short to decrypt
  }

  const result = Buffer.from(data)

  // Decrypt first 16 bytes after the wrapper header, in-place
  const encryptedBlock = result.subarray(WRAPPER_LEN, WRAPPER_LEN + AES_BLOCK_SIZE)
  const decipher = createDecipheriv('aes-128-ecb', aesKey, null)
  decipher.setAutoPadding(false)
  const decrypted = decipher.update(encryptedBlock)
  decrypted.copy(result, WRAPPER_LEN)

  // Return from byte 2 onward: [original_hdr(2)] [decrypted_data(14)] [plaintext_rest...]
  return result.subarray(WRAPPER_LEN)
}

export class HikRtpExtractor extends EventEmitter {
  private nalCount = 0
  private aesKey: Buffer | null = null

  constructor(verificationCode?: string) {
    super()
    if (verificationCode) {
      this.aesKey = deriveAesKey(verificationCode)
    }
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

    // Find and strip sub-header (0x0d + 4 variable bytes + 8-byte sync pattern = 13 bytes)
    // The sub-header typically starts at offset 0 but scan to be safe
    let dataStart = 0
    if (rtpPayload[0] === 0x0d && rtpPayload.length > SUB_HEADER_LEN) {
      const subHigh = rtpPayload[1] & 0xf0
      if (subHigh === 0x80 || subHigh === 0x90 || subHigh === 0xa0 || subHigh === 0xd0) {
        dataStart = SUB_HEADER_LEN
      }
    }

    const nalData = rtpPayload.subarray(dataStart)
    if (nalData.length < 2) return

    this.processNalUnit(nalData)
  }

  private processNalUnit(data: Buffer): void {
    if (data.length < 2) return

    const firstByte = data[0]
    const nalType = (firstByte >> 1) & 0x3f

    // Length-prefixed format: 00 NN 00 LL [LL bytes of NAL data]
    // Multiple length-prefixed NALs can be concatenated in one fragment
    if (firstByte === 0x00 && data.length > 4) {
      let offset = 0
      while (offset + 4 <= data.length) {
        if (data[offset] !== 0x00) break
        const dataLen = data.readUInt16BE(offset + 2)
        if (dataLen <= 0 || offset + 4 + dataLen > data.length) break
        this.emitNal(data.subarray(offset + 4, offset + 4 + dataLen))
        offset += 4 + dataLen
      }
      return
    }

    // Valid H.265 NAL types (VPS=32, SPS=33, PPS=34, slices=0-21)
    if (nalType <= 40) {
      this.emitNal(data)
      return
    }

    // NAL type 49: Hikvision encrypted NAL — decrypt if key available
    if (nalType === HIK_ENCRYPTED_NAL_TYPE && this.aesKey) {
      const decrypted = decryptNal(data, this.aesKey)
      this.emitNal(decrypted)
      return
    }

    // Hikvision custom NAL types (48-63 range): pass through
    if (nalType >= 48) {
      this.emitNal(data)
      return
    }

    // Unknown type — skip to avoid corrupting the stream
  }

  private emitNal(data: Buffer): void {
    if (data.length < 2) return

    // Validate NAL type before emitting — skip obviously invalid data
    const nalType = (data[0] >> 1) & 0x3f
    // Valid H.265: types 0-40 (standard) + 48-63 (Hikvision custom/UNSPEC)
    // Skip: type 0 with second byte 0 (likely padding/zero data)
    if (nalType === 0 && data[1] === 0) return

    this.nalCount++

    // Emit with Annex B start code prefix
    const annexB = Buffer.concat([ANNEX_B_START_CODE, data])
    this.emit('nalUnit', annexB)

    if (this.nalCount <= 10 || this.nalCount % 500 === 0) {
      const names: Record<number, string> = {
        0: 'TRAIL_N', 1: 'TRAIL_R', 19: 'IDR_W_RADL', 20: 'IDR_N_LP',
        21: 'CRA_NUT', 32: 'VPS', 33: 'SPS', 34: 'PPS',
      }
      console.log(`[H265] NAL #${this.nalCount}: type=${nalType} (${names[nalType] ?? '?'}) size=${data.length}B`)
    }
  }
}
