/**
 * Hik-RTP frame extractor — converts SRT/P2P data payloads into H.265 Annex B stream.
 *
 * Format (from pcap + VPS capture analysis):
 * - Data payload starts with 12-byte Hik-RTP header (first 2 bytes = 0x8060/0x8050)
 * - After header: 13-byte sub-frame header (0x0d + 4B + 8B sync pattern)
 * - After sub-header: NAL unit data
 *   - VPS/SPS/PPS (NAL types 32-34): parameter sets
 *   - Slice data (NAL types 0-21): video frames
 *   - Length-prefixed frames (0x00 NN 00 LL [data]): Hikvision metadata
 *
 * NAL type 49 = HEVC Fragmentation Unit (FU) per RFC 7798:
 * - Structure: [2B PayloadHdr (type=49)] [1B FU header] [FU payload]
 * - FU header: S(1) | E(1) | FuType(6)
 *   - S=1: start of fragmented NAL, FuType = original NAL type
 *   - E=1: end of fragmented NAL
 *   - S=0,E=0: continuation fragment
 * - NAL header reconstructed from PayloadHdr + FuType on start fragment
 * - Each FU (S=1...E=1) produces one reassembled NAL unit
 * - Large IDR frames split into multiple slice segments, each in its own FU
 */

import { EventEmitter } from 'node:events'

const HIK_RTP_HEADER_LEN = 12
const SUB_HEADER_LEN = 13 // 0x0d + 4 bytes + 8 bytes sync
const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])
const FU_NAL_TYPE = 49

export class HikRtpExtractor extends EventEmitter {
  private nalCount = 0
  private fuFragments: Buffer[] = []
  private fuNalHeader: Buffer | null = null

  /** Flush any accumulated FU fragments as a complete NAL. */
  flush(): void {
    if (this.fuFragments.length > 0 && this.fuNalHeader) {
      const assembled = Buffer.concat([this.fuNalHeader, ...this.fuFragments])
      this.fuFragments = []
      this.fuNalHeader = null
      this.emitNal(assembled)
      return
    }
    this.fuFragments = []
    this.fuNalHeader = null
  }

  /**
   * Process a raw data payload (the 'data' event from P2PSession).
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

    // Flush accumulated FU fragments when ANY non-FU NAL arrives
    if (nalType !== FU_NAL_TYPE && this.fuNalHeader) {
      this.flush()
    }

    // Length-prefixed format: 00 NN 00 LL [LL bytes of NAL data]
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

    // Standard HEVC NAL types: slices (0-21), VPS (32), SPS (33), PPS (34), SEI (35, 39-40)
    if (nalType <= 21 || (nalType >= 32 && nalType <= 35) || nalType === 39 || nalType === 40) {
      this.emitNal(data)
      return
    }

    // NAL type 49: HEVC Fragmentation Unit (FU) per RFC 7798.
    // Structure: [2B PayloadHdr] [1B FU header: S|E|FuType] [FU payload]
    // Each FU (S=1 start ... E=1 end) reassembles into one NAL unit.
    if (nalType === FU_NAL_TYPE && data.length >= 3) {
      const fuHeader = data[2]
      const isStart = (fuHeader >> 7) & 1
      const isEnd = (fuHeader >> 6) & 1
      const fuType = fuHeader & 0x3f

      if (isStart) {
        // Start of new FU — flush any previous incomplete one
        this.flush()
        // Reconstruct original NAL header: preserve forbidden_zero_bit and nuh_layer_id
        // from PayloadHdr, substitute NAL type from FU header
        const origFirstByte = (data[0] & 0x81) | ((fuType << 1) & 0x7e)
        this.fuNalHeader = Buffer.from([origFirstByte, data[1]])
        this.fuFragments = [data.subarray(3)]
      } else {
        // Continuation/end: strip 3 bytes (2B PayloadHdr + 1B FU header)
        this.fuFragments.push(data.subarray(3))
      }

      if (isEnd) {
        this.flush()
      }
      return
    }

    // Other NAL types in 48-63 range: pass through
    if (nalType >= 48) {
      this.emitNal(data)
      return
    }
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
