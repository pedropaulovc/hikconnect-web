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
 * Hikvision type-49 NAL wrapper (from Ghidra RE of libPlayCtrl.so IDMXAESDEcrpytFrameCom):
 * - NAL type 49 = Hik proprietary wrapper around standard HEVC slices
 * - Structure: [2B type-49 hdr] [ext: original NAL type + length] [1B flag] [HEVC slice data]
 * - Extension byte 0: top 2 bits = extra byte count, bottom 6 bits = original NAL type
 * - Video data is plaintext (NOT AES-encrypted for this device with udpEcdh=0)
 * - AES decryption only applies when "stream encryption" is enabled on the NVR
 */

import { EventEmitter } from 'node:events'

const HIK_RTP_HEADER_LEN = 12
// SUB_HEADER_SYNC varies per session — not used for matching anymore
const SUB_HEADER_LEN = 13 // 0x0d + 4 bytes + 8 bytes sync
const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])
const HIK_ENCRYPTED_NAL_TYPE = 49


/**
 * Unwrap a Hikvision type-49 NAL unit.
 * Type-49 is a proprietary wrapper — NOT AES-encrypted (for default device config).
 * Structure: [2B type-49 hdr] [ext header] [1B flag] [HEVC slice data]
 * Extension byte 0: top 2 bits = extra byte count, bottom 6 bits = original NAL type
 * The original HEVC NAL header is reconstructed from the extension's NAL type field.
 */
function unwrapType49Nal(data: Buffer): Buffer {
  if (data.length < 4) return data

  // Read extension at byte 2 (after 2-byte NAL header)
  const extByte = data[2]
  const extraBytes = (extByte >> 6) & 3  // top 2 bits: 0-3 extra bytes
  const originalNalType = extByte & 0x3f // bottom 6 bits: original NAL type

  // Total header: 2 (NAL hdr) + 1 + extraBytes (extension) + 1 (flag byte)
  const headerLen = 2 + 1 + extraBytes + 1
  if (data.length <= headerLen) return data

  // Reconstruct original HEVC NAL header: type in bits 1-6 of first byte
  const originalFirstByte = (originalNalType << 1) & 0x7e // forbidden_zero=0, nuh_layer_id_high=0
  const originalSecondByte = 0x01 // nuh_temporal_id_plus1 = 1

  // Build result: [original 2B NAL header] [slice data from after wrapper header]
  const sliceData = data.subarray(headerLen)
  const result = Buffer.alloc(2 + sliceData.length)
  result[0] = originalFirstByte
  result[1] = originalSecondByte
  sliceData.copy(result, 2)

  return result
}

export class HikRtpExtractor extends EventEmitter {
  private nalCount = 0
  private inEncryptedNal = false
  private type49Fragments: Buffer[] = []

  /** Flush any accumulated type-49 fragments as a complete NAL. */
  flush(): void {
    if (this.type49Fragments.length > 0) {
      const assembled = Buffer.concat(this.type49Fragments)
      this.type49Fragments = []
      this.inEncryptedNal = false
      this.emitNal(assembled)
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
    // Sub-header byte 1 high nibble = type (0x80/0x90/0xa0/0xd0)
    // Sub-header bytes 2-3 = stream identifier (video vs audio)
    let dataStart = 0
    if (rtpPayload[0] === 0x0d && rtpPayload.length > SUB_HEADER_LEN) {
      const subHigh = rtpPayload[1] & 0xf0
      if (subHigh === 0x80 || subHigh === 0x90 || subHigh === 0xa0 || subHigh === 0xd0) {
        // Skip audio stream packets (sub-header byte 2 = 0x88 indicates audio)
        if (rtpPayload[2] === 0x88) return
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

    // Flush accumulated type-49 fragments when ANY non-type-49 NAL arrives
    if (nalType !== HIK_ENCRYPTED_NAL_TYPE && this.inEncryptedNal) {
      this.flush()
    }

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

    // Valid H.265 NAL types: slices (0-21), VPS (32), SPS (33), PPS (34), SEI (35, 39-40)
    // Types 22-31 and 36-38 are reserved/unused — skip to avoid passing audio as video
    if (nalType <= 21 || (nalType >= 32 && nalType <= 35) || nalType === 39 || nalType === 40) {
      this.emitNal(data)
      return
    }

    // NAL type 49: Hikvision proprietary wrapper around HEVC slices.
    // Large NALs are fragmented across SRT packets. Each fragment repeats the
    // type-49 header (0x62 0x01). First fragment has extension with original NAL type.
    // We accumulate ALL fragments and emit the complete reassembled NAL to avoid
    // spurious start code splits within fragment data.
    if (nalType === HIK_ENCRYPTED_NAL_TYPE) {
      if (!this.inEncryptedNal) {
        // First fragment: unwrap to get original NAL header + body
        this.inEncryptedNal = true
        this.type49Fragments = [unwrapType49Nal(data)]
      } else {
        // Continuation fragment: strip type-49 wrapper + extension (NO flag byte)
        // Only the first fragment has the flag byte; continuations are just wrapper+ext+data
        const contHdrLen = 2 + 1 + ((data[2] >> 6) & 3) // 2B hdr + ext bytes
        this.type49Fragments.push(data.subarray(contHdrLen))
      }
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
