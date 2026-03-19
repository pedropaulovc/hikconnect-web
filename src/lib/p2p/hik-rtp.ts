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
 * Encryption (from Ghidra RE of libPlayCtrl.so IDMXAESDEcrpytFrameCom):
 * - NAL type 49 = Hikvision encrypted NAL wrapper
 * - Key = MD5(verification_code), e.g. MD5("ABCDEF") for default code
 * - Structure: [2B NAL hdr] [3B extension] [1B flag] [16B 3-round AES encrypted] [plaintext]
 * - Uses custom 3-round AES-128, NOT standard 10-round AES (IDMX_AES_decrypt_128 param4=3)
 * - Decrypt offset = 6 (2B header + 3B ext + 1B flag)
 */

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'

const HIK_RTP_HEADER_LEN = 12
// SUB_HEADER_SYNC varies per session — not used for matching anymore
const SUB_HEADER_LEN = 13 // 0x0d + 4 bytes + 8 bytes sync
const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])
const HIK_ENCRYPTED_NAL_TYPE = 49

function deriveAesKey(verificationCode: string): Buffer {
  return createHash('md5').update(verificationCode).digest()
}

// --- 3-round AES-128 (Hikvision IDMX_AES_decrypt_128) ---
// Standard AES uses 10 rounds; Hikvision uses only 3 for H.265 video performance.
// Same S-box, ShiftRows, MixColumns — just fewer rounds.

// prettier-ignore
const SBOX = [0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16]
const INV_SBOX = new Array(256)
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]

function gmul(a: number, b: number): number {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const h = a & 0x80
    a = (a << 1) & 0xff
    if (h) a ^= 0x1b
    b >>= 1
  }
  return p
}

function aes3RoundDecrypt(block: Buffer, key: Buffer): Buffer {
  const Nr = 3
  // Key expansion (Nr+1 round keys as flat bytes)
  const W = new Uint32Array((Nr + 1) * 4)
  for (let i = 0; i < 4; i++) W[i] = key.readUInt32BE(i * 4)
  for (let i = 4; i < (Nr + 1) * 4; i++) {
    let t = W[i - 1]
    if (i % 4 === 0)
      t = ((SBOX[(t >> 16) & 0xff] << 24) | (SBOX[(t >> 8) & 0xff] << 16) |
        (SBOX[t & 0xff] << 8) | SBOX[(t >> 24) & 0xff]) ^ (RCON[i / 4 - 1] << 24)
    W[i] = W[i - 4] ^ t
  }
  // Expand round keys to flat bytes
  const rk = Buffer.alloc((Nr + 1) * 16)
  for (let i = 0; i < (Nr + 1) * 4; i++) rk.writeUInt32BE(W[i], i * 4)

  // IDMX uses row-major state (flat 16-byte array, no column-major transpose)
  const s = Buffer.from(block)

  // AddRoundKey(Nr)
  for (let i = 0; i < 16; i++) s[i] ^= rk[Nr * 16 + i]

  // Middle rounds (Nr-1 down to 1)
  for (let round = Nr - 1; round >= 1; round--) {
    // InvShiftRows (row-major: rows are at indices [0-3], [4-7], [8-11], [12-15])
    let t = s[7]; s[7] = s[6]; s[6] = s[5]; s[5] = s[4]; s[4] = t  // row 1: shift right 1
    t = s[8]; s[8] = s[10]; s[10] = t; t = s[9]; s[9] = s[11]; s[11] = t  // row 2: shift right 2
    t = s[12]; s[12] = s[13]; s[13] = s[14]; s[14] = s[15]; s[15] = t  // row 3: shift right 3
    // InvSubBytes
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]
    // AddRoundKey
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i]
    // InvMixColumns (row-major: columns are at indices [0,4,8,12], [1,5,9,13], etc.)
    for (let c = 0; c < 4; c++) {
      const a = s[c], b = s[c + 4], cc = s[c + 8], d = s[c + 12]
      s[c] = gmul(a, 14) ^ gmul(b, 11) ^ gmul(cc, 13) ^ gmul(d, 9)
      s[c + 4] = gmul(a, 9) ^ gmul(b, 14) ^ gmul(cc, 11) ^ gmul(d, 13)
      s[c + 8] = gmul(a, 13) ^ gmul(b, 9) ^ gmul(cc, 14) ^ gmul(d, 11)
      s[c + 12] = gmul(a, 11) ^ gmul(b, 13) ^ gmul(cc, 9) ^ gmul(d, 14)
    }
  }

  // Final round: InvShiftRows + InvSubBytes + AddRoundKey(0)
  let tf = s[7]; s[7] = s[6]; s[6] = s[5]; s[5] = s[4]; s[4] = tf
  tf = s[8]; s[8] = s[10]; s[10] = tf; tf = s[9]; s[9] = s[11]; s[11] = tf
  tf = s[12]; s[12] = s[13]; s[13] = s[14]; s[14] = s[15]; s[15] = tf
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]
  for (let i = 0; i < 16; i++) s[i] ^= rk[i]

  return s
}

// Encrypted NAL offset: [2B NAL hdr] [3B extension] [1B flag] = 6 bytes before encrypted data
const ENCRYPT_OFFSET = 6

/**
 * Decrypt a Hikvision type-49 encrypted NAL unit.
 * Uses 3-round AES-128-ECB (IDMX_AES_decrypt_128) at offset 6.
 * Decrypted bytes at offset 6 contain the original NAL header + initial slice data.
 */
function decryptNal(data: Buffer, aesKey: Buffer): Buffer {
  const AES_BLOCK_SIZE = 16

  if (data.length < ENCRYPT_OFFSET + AES_BLOCK_SIZE) {
    return data.subarray(ENCRYPT_OFFSET) // too short, strip header only
  }

  const result = Buffer.from(data)
  const encrypted = result.subarray(ENCRYPT_OFFSET, ENCRYPT_OFFSET + AES_BLOCK_SIZE)
  const decrypted = aes3RoundDecrypt(encrypted, aesKey)
  decrypted.copy(result, ENCRYPT_OFFSET)

  // Return from offset 6: [decrypted original NAL hdr(2)] [payload(14)] [plaintext rest...]
  return result.subarray(ENCRYPT_OFFSET)
}

export class HikRtpExtractor extends EventEmitter {
  private nalCount = 0
  private aesKey: Buffer | null = null
  private inEncryptedNal = false

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

    // NAL type 49: Hikvision encrypted NAL — decrypt if key available
    // Large NALs are fragmented across SRT packets. Each fragment repeats the
    // type-49 header (0x62 0x01), but only the FIRST fragment has encrypted bytes.
    // Track state: first type-49 after a non-49 packet = first fragment (decrypt).
    // Subsequent type-49 packets = continuations (strip wrapper, emit raw body).
    if (nalType === HIK_ENCRYPTED_NAL_TYPE && this.aesKey) {
      if (!this.inEncryptedNal) {
        // First fragment of a new encrypted NAL — decrypt
        this.inEncryptedNal = true
        const decrypted = decryptNal(data, this.aesKey)
        this.emitNal(decrypted)
      } else {
        // Continuation fragment: strip type-49 wrapper, emit raw body (no start code)
        this.emit('nalUnit', data.subarray(2))
      }
      return
    }

    // Any non-type-49 NAL resets the encrypted fragment state
    this.inEncryptedNal = false

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
