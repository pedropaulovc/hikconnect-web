// IMKH Parser - Hikvision proprietary media container format
// Reverse-engineered from P2P video stream wire captures

import { createHash, createDecipheriv } from 'node:crypto'
import { EventEmitter } from 'node:events'

// --- Constants ---

export const IMKH_MAGIC = 0x494d4b48
export const IMKH_HEADER_LEN = 16
export const FRAME_HEADER_LEN = 16

// --- Codec types ---

export const VideoCodec = {
  UNKNOWN: 0x00,
  MJPEG: 0x01,
  MPEG4: 0x02,
  H264: 0x04,
  H265: 0x05,
} as const

export const AudioCodec = {
  NONE: 0x00,
  G711_ULAW: 0x01,
  G711_ALAW: 0x02,
  G726: 0x05,
  AAC: 0x0a,
  PCM: 0x10,
} as const

// --- Frame types ---

export const ImkhFrameType = {
  VIDEO_I: 0x01,
  VIDEO_P: 0x02,
  VIDEO_B: 0x03,
  AUDIO: 0x08,
  INFO: 0xfc,
} as const

export type ImkhFrameTypeValue = (typeof ImkhFrameType)[keyof typeof ImkhFrameType]

// --- Encryption mode ---

export const EncryptionMode = {
  NONE: 'none',
  PARTIAL: 'partial',
  FULL: 'full',
} as const

export type EncryptionModeValue = (typeof EncryptionMode)[keyof typeof EncryptionMode]

// --- Parsed types ---

export type ImkhHeader = {
  versionMajor: number
  versionMinor: number
  videoCodec: number
  audioCodec: number
  flags: number
  frameInfo: number
}

export type FrameHeader = {
  type: ImkhFrameTypeValue
  length: number
  timestamp: number
}

export type DemuxerEvents = {
  video: [{ type: ImkhFrameTypeValue; data: Buffer; timestamp: number }]
  audio: [{ data: Buffer; timestamp: number }]
  header: [ImkhHeader]
  error: [Error]
}

// --- IMKH header parsing ---

export function parseImkhHeader(buf: Buffer): ImkhHeader {
  if (buf.length < IMKH_HEADER_LEN) {
    throw new Error(`IMKH header too short: ${buf.length} bytes, need ${IMKH_HEADER_LEN}`)
  }

  const magic = buf.readUInt32BE(0)
  if (magic !== IMKH_MAGIC) {
    throw new Error(`Invalid IMKH magic: 0x${magic.toString(16)}, expected 0x${IMKH_MAGIC.toString(16)}`)
  }

  return {
    versionMajor: buf[4],
    versionMinor: buf[5],
    videoCodec: buf[8],
    audioCodec: buf[9],
    flags: buf.readUInt16BE(10),
    frameInfo: buf.readUInt32BE(12),
  }
}

// --- Frame header parsing ---

export function parseFrameHeader(buf: Buffer): FrameHeader {
  if (buf.length < FRAME_HEADER_LEN) {
    throw new Error(`Frame header too short: ${buf.length} bytes, need ${FRAME_HEADER_LEN}`)
  }

  const type = buf[0] as ImkhFrameTypeValue
  const length = buf.readUInt32BE(4)
  const timestamp = buf.readUInt32BE(8)

  return { type, length, timestamp }
}

// --- AES decryption ---

function deriveAesKey(verificationCode: string): Buffer {
  return createHash('md5').update(verificationCode).digest()
}

export function decryptFrame(
  frame: Buffer,
  verificationCode: string,
  mode: EncryptionModeValue = EncryptionMode.FULL,
): Buffer {
  if (mode === EncryptionMode.NONE) {
    return frame
  }

  const key = deriveAesKey(verificationCode)
  const blockSize = 16

  if (frame.length < blockSize) {
    return frame
  }

  if (mode === EncryptionMode.PARTIAL) {
    const encrypted = frame.subarray(0, blockSize)
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const result = Buffer.from(frame)
    decrypted.copy(result, 0)
    return result
  }

  // Full encryption: decrypt all complete blocks, preserve trailing partial block
  const completeLen = frame.length - (frame.length % blockSize)
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([
    decipher.update(frame.subarray(0, completeLen)),
    decipher.final(),
  ])

  if (completeLen === frame.length) {
    return decrypted
  }

  return Buffer.concat([decrypted, frame.subarray(completeLen)])
}

// --- Demuxer ---

export class ImkhDemuxer extends EventEmitter<DemuxerEvents> {
  private header: ImkhHeader | null = null
  private remainder: Buffer = Buffer.alloc(0)
  private readonly verificationCode: string
  private readonly encryptionMode: EncryptionModeValue

  constructor(verificationCode: string, encryptionMode: EncryptionModeValue = EncryptionMode.FULL) {
    super()
    this.verificationCode = verificationCode
    this.encryptionMode = encryptionMode
  }

  getHeader(): ImkhHeader | null {
    return this.header
  }

  /** Feed reassembled data into the demuxer. */
  push(data: Buffer): void {
    this.remainder = this.remainder.length > 0
      ? Buffer.concat([this.remainder, data])
      : data

    if (!this.header) {
      this.consumeHeader()
    }

    this.consumeFrames()
  }

  /** Reset internal state for a new stream. */
  reset(): void {
    this.header = null
    this.remainder = Buffer.alloc(0)
  }

  // -- Private ----------------------------------------------------------------

  private consumeHeader(): void {
    if (this.remainder.length < IMKH_HEADER_LEN) {
      return
    }

    // Scan for IMKH magic — it may not be at offset 0
    const magicOffset = this.findMagic()
    if (magicOffset < 0) {
      return
    }

    try {
      this.header = parseImkhHeader(this.remainder.subarray(magicOffset))
      this.remainder = this.remainder.subarray(magicOffset + IMKH_HEADER_LEN)
      this.emit('header', this.header)
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }

  private findMagic(): number {
    const needle = Buffer.from('IMKH')
    for (let i = 0; i <= this.remainder.length - 4; i++) {
      if (this.remainder[i] === needle[0]
        && this.remainder[i + 1] === needle[1]
        && this.remainder[i + 2] === needle[2]
        && this.remainder[i + 3] === needle[3]) {
        return i
      }
    }
    return -1
  }

  private consumeFrames(): void {
    while (this.remainder.length >= FRAME_HEADER_LEN) {
      const frameHeader = parseFrameHeader(this.remainder)
      const totalLen = FRAME_HEADER_LEN + frameHeader.length

      if (this.remainder.length < totalLen) {
        return // wait for more data
      }

      const payload = this.remainder.subarray(FRAME_HEADER_LEN, totalLen)
      this.remainder = this.remainder.subarray(totalLen)

      const decrypted = decryptFrame(payload, this.verificationCode, this.encryptionMode)
      this.emitFrame(frameHeader, decrypted)
    }
  }

  private emitFrame(header: FrameHeader, data: Buffer): void {
    const { type, timestamp } = header

    if (type === ImkhFrameType.AUDIO) {
      this.emit('audio', { data, timestamp })
      return
    }

    if (type === ImkhFrameType.VIDEO_I || type === ImkhFrameType.VIDEO_P || type === ImkhFrameType.VIDEO_B) {
      this.emit('video', { type, data, timestamp })
      return
    }

    // INFO or unknown — silently skip
  }
}
