/**
 * LiveStream — end-to-end live streaming from device to HLS.
 *
 * Connects via P2P to the device, receives video data,
 * extracts H.265 NAL units via Hik-RTP framing, pipes to FFmpeg
 * for HLS segmentation.
 */

import { EventEmitter } from 'node:events'
import { P2PSession, type P2PServer } from './p2p-session'
import { FfmpegHlsPipe, type HlsConfig } from '../hls/ffmpeg-pipe'
import { HikRtpExtractor } from './hik-rtp'

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
  /** Server's public IP for P2P registration */
  localPublicIp?: string
  /** Business type: 1=live preview (default), 2=playback */
  busType?: number
  /** Playback start time (YYYY-MM-DDTHH:MM:SS) */
  startTime?: string
  /** Playback stop time (YYYY-MM-DDTHH:MM:SS) */
  stopTime?: string
  /** Device verification code for video decryption (e.g. "ABCDEF") */
  verificationCode?: string
  /** HLS output configuration */
  hls: HlsConfig
}

export type LiveStreamState = 'idle' | 'connecting' | 'streaming' | 'stopped' | 'error'

export class LiveStream extends EventEmitter {
  private config: LiveStreamConfig
  private p2pSession: P2PSession | null = null
  private hlsPipe: FfmpegHlsPipe | null = null
  private _state: LiveStreamState = 'idle'
  private bytesReceived = 0

  constructor(config: LiveStreamConfig) {
    super()
    this.config = config
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
        localPublicIp: this.config.localPublicIp,
        busType: this.config.busType,
        startTime: this.config.startTime,
        stopTime: this.config.stopTime,
      })

      // Wire P2P data → HikRTP extractor → H.265 NALs → FFmpeg
      const extractor = new HikRtpExtractor(this.config.verificationCode)
      extractor.on('nalUnit', (nal: Buffer) => {
        this.bytesReceived += nal.length
        this.hlsPipe?.write(nal)
      })
      this.p2pSession.on('data', (payload: Buffer) => {
        extractor.processPacket(payload)
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
