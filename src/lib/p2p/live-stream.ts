/**
 * LiveStream — end-to-end live streaming from device to HLS.
 *
 * Connects via P2P to the device, receives encrypted video data,
 * decrypts and demuxes IMKH frames, pipes raw H.264/H.265 to FFmpeg
 * for HLS segmentation.
 */

import { EventEmitter } from 'node:events'
import { createHash, createDecipheriv } from 'node:crypto'
import { P2PSession, type P2PServer } from './p2p-session'
import { FfmpegHlsPipe, type HlsConfig } from '../hls/ffmpeg-pipe'

export type LiveStreamConfig = {
  /** Device serial number */
  deviceSerial: string
  /** Device public IP (from API) */
  deviceIp: string
  /** Device stream port (from API, usually a NAT-mapped port) */
  devicePort: number
  /** P2P servers list */
  p2pServers: P2PServer[]
  /** P2P encryption key (32 bytes) */
  p2pKey: Buffer
  /** P2P link key (32 bytes, for inner PLAY_REQUEST encryption) */
  p2pLinkKey: Buffer
  /** P2P key version */
  p2pKeyVersion: number
  /** P2P key salt index */
  p2pKeySaltIndex: number
  /** P2P key salt version */
  p2pKeySaltVer: number
  /** JWT session token */
  sessionToken: string
  /** User ID */
  userId: string
  /** Client ID for P2P protocol */
  clientId: number
  /** Channel number (1-based) */
  channelNo: number
  /** Stream type: 0=main, 1=sub */
  streamType: number
  /** Device verification code (6 chars, used for AES decryption) */
  verificationCode: string
  /** HLS output configuration */
  hls: HlsConfig
}

export type LiveStreamState = 'idle' | 'connecting' | 'streaming' | 'stopped' | 'error'

export class LiveStream extends EventEmitter {
  private config: LiveStreamConfig
  private p2pSession: P2PSession | null = null
  private hlsPipe: FfmpegHlsPipe | null = null
  private _state: LiveStreamState = 'idle'
  private aesKey: Buffer
  private receivedInit = false
  private bytesReceived = 0

  constructor(config: LiveStreamConfig) {
    super()
    this.config = config
    // Derive AES key from verification code: MD5 of the code
    this.aesKey = createHash('md5').update(config.verificationCode).digest()
  }

  get state(): LiveStreamState {
    return this._state
  }

  get playlistPath(): string {
    return this.hlsPipe?.getPlaylistPath() ?? ''
  }

  async start(): Promise<string> {
    if (this._state !== 'idle') {
      throw new Error(`Cannot start: state is ${this._state}`)
    }

    this.transition('connecting')

    try {
      // Start FFmpeg HLS pipe
      this.hlsPipe = new FfmpegHlsPipe(this.config.hls)
      this.hlsPipe.start()

      // Start P2P session
      this.p2pSession = new P2PSession({
        deviceSerial: this.config.deviceSerial,
        devicePublicIp: this.config.deviceIp,
        devicePublicPort: this.config.devicePort,
        p2pServers: this.config.p2pServers,
        p2pKey: this.config.p2pKey,
        p2pLinkKey: this.config.p2pLinkKey,
        p2pKeyVersion: this.config.p2pKeyVersion,
        p2pKeySaltIndex: this.config.p2pKeySaltIndex,
        p2pKeySaltVer: this.config.p2pKeySaltVer,
        sessionToken: this.config.sessionToken,
        userId: this.config.userId,
        clientId: this.config.clientId,
        channelNo: this.config.channelNo,
        streamType: this.config.streamType,
        streamTokens: [],
      })

      this.p2pSession.on('data', (payload: Buffer) => {
        this.onStreamData(payload)
      })

      this.p2pSession.on('error', (err: Error) => {
        this.emit('error', err)
      })

      this.p2pSession.on('stateChange', ({ to }: { from: string; to: string }) => {
        if (to === 'error') this.transition('error')
      })

      await this.p2pSession.start()
      this.transition('streaming')

      return this.hlsPipe.getPlaylistPath()
    } catch (err) {
      this.transition('error')
      this.cleanup()
      throw err
    }
  }

  stop(): void {
    if (this._state === 'stopped') return
    this.cleanup()
    this.transition('stopped')
  }

  private onStreamData(payload: Buffer): void {
    this.bytesReceived += payload.length

    // Skip the init data packet (01000101 header with device serial + IMKH header)
    if (!this.receivedInit && payload.length >= 4) {
      const header = payload.readUInt32BE(0)
      if (header === 0x01000101) {
        this.receivedInit = true
        // The init packet contains IMKH header info but no actual video data
        // Parse it for codec info
        const imkhOffset = payload.indexOf(Buffer.from('IMKH'))
        if (imkhOffset >= 0) {
          const codecType = payload[imkhOffset + 8]
          this.emit('codecInfo', {
            video: codecType === 5 ? 'h265' : 'h264',
            imkhOffset,
          })
        }
        return
      }
    }

    // Try to decrypt and pass to FFmpeg
    try {
      const decrypted = this.decryptFrameData(payload)
      this.hlsPipe?.write(decrypted)
    } catch {
      // If decryption fails, try passing raw data
      // (some frames may not be encrypted)
      this.hlsPipe?.write(payload)
    }
  }

  /**
   * Decrypt frame data using AES-128-ECB with the verification code key.
   * Hikvision uses partial encryption: only the first 16 bytes of each
   * frame may be encrypted, or the entire frame depending on device config.
   */
  private decryptFrameData(data: Buffer): Buffer {
    if (data.length < 16) return data

    // Try full AES-128-ECB decryption
    try {
      const decipher = createDecipheriv('aes-128-ecb', this.aesKey, null)
      decipher.setAutoPadding(false)

      // Align to 16-byte blocks
      const alignedLen = Math.floor(data.length / 16) * 16
      if (alignedLen === 0) return data

      const aligned = data.subarray(0, alignedLen)
      const decrypted = Buffer.concat([decipher.update(aligned)])
      const remainder = data.subarray(alignedLen)

      return Buffer.concat([decrypted, remainder])
    } catch {
      return data
    }
  }

  private transition(next: LiveStreamState): void {
    const prev = this._state
    this._state = next
    this.emit('stateChange', { from: prev, to: next })
  }

  private cleanup(): void {
    this.p2pSession?.stop()
    this.p2pSession = null
    this.hlsPipe?.stop()
    this.hlsPipe = null
  }
}
