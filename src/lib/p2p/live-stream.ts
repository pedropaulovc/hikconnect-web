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
import type { VideoSink } from '../hls/video-sink'
import { HikRtpExtractor, extractPlaybackPayload } from './hik-rtp'

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

/** Builds the sink that consumes the decoded video for a given stream config. */
export type SinkFactory = (config: LiveStreamConfig) => VideoSink

/**
 * Default sink: an HLS pipe for browser playback. Playback (busType=2) is an
 * MPEG-PS container; live preview is a raw H.265 elementary stream — the
 * demuxer must match (`-f mpeg` vs `-f hevc`). The export path injects an MP4
 * sink instead via the constructor's `sinkFactory` arg.
 */
const defaultHlsSinkFactory: SinkFactory = (config) =>
  new FfmpegHlsPipe({ ...config.hls, inputFormat: config.busType === 2 ? 'mpeg' : 'hevc' })

export class LiveStream extends EventEmitter {
  private config: LiveStreamConfig
  private sinkFactory: SinkFactory
  private p2pSession: P2PSession | null = null
  private sink: VideoSink | null = null
  private _state: LiveStreamState = 'idle'
  private bytesReceived = 0

  constructor(config: LiveStreamConfig, sinkFactory: SinkFactory = defaultHlsSinkFactory) {
    super()
    this.config = config
    this.sinkFactory = sinkFactory
  }

  get state(): LiveStreamState {
    return this._state
  }

  /** The active sink (e.g. the export route reads MP4 progress through it). */
  getSink(): VideoSink | null {
    return this.sink
  }

  /** HLS playlist path — empty unless the sink is an HLS pipe (live/playback view). */
  get playlistPath(): string {
    if (this.sink instanceof FfmpegHlsPipe) return this.sink.getPlaylistPath()
    return ''
  }

  async start(): Promise<string> {
    if (this._state !== 'idle') {
      throw new Error(`Cannot start: state is ${this._state}`)
    }

    this.transition('connecting')

    try {
      // Build the injected sink (HLS by default; MP4 for export) and start it.
      this.sink = this.sinkFactory(this.config)
      this.sink.start()

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
        localPublicIp: this.config.localPublicIp,
        busType: this.config.busType,
        startTime: this.config.startTime,
        stopTime: this.config.stopTime,
      })

      this.wireDataPath()

      this.p2pSession.on('error', (err: Error) => {
        this.emit('error', err)
      })

      this.p2pSession.on('stateChange', ({ to }: { from: string; to: string }) => {
        if (to === 'error') this.transition('error')
      })

      await this.p2pSession.start()
      this.transition('streaming')

      return this.playlistPath
    } catch (err) {
      this.transition('error')
      this.cleanup()
      throw err
    }
  }

  /**
   * Wire P2P data → FFmpeg. The two bus types deliver different containers:
   * playback (busType=2) is MPEG-PS (pass the bytes through, `-f mpeg`), live
   * preview is raw H.265 NALs that need Hik-RTP reassembly (`-f hevc`).
   */
  private wireDataPath(): void {
    if (this.config.busType === 2) {
      this.p2pSession!.on('data', (payload: Buffer) => {
        const ps = extractPlaybackPayload(payload)
        if (!ps) return
        this.bytesReceived += ps.length
        this.sink?.write(ps)
      })
      return
    }

    const extractor = new HikRtpExtractor()
    extractor.on('nalUnit', (nal: Buffer) => {
      this.bytesReceived += nal.length
      this.sink?.write(nal)
    })
    this.p2pSession!.on('data', (payload: Buffer) => {
      extractor.processPacket(payload)
    })
  }

  async stop(): Promise<void> {
    if (this._state === 'stopped') return
    await this.cleanup()
    this.transition('stopped')
  }

  private transition(next: LiveStreamState): void {
    const prev = this._state
    this._state = next
    this.emit('stateChange', { from: prev, to: next })
  }

  private async cleanup(): Promise<void> {
    await this.p2pSession?.stop()
    this.p2pSession = null
    await this.sink?.stop()
    this.sink = null
  }
}
