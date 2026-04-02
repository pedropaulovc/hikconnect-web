import { EventEmitter } from 'node:events'
import { rfc5389StunBind, type StunResult } from './stun-client'
import { generateKeyPair, type KeyPair } from './crypto'
import { CasClient, type CasClientConfig, type PlayRequestParams } from './cas-client'
import { FfmpegHlsPipe, type HlsConfig } from '../hls/ffmpeg-pipe'

// -- Types --------------------------------------------------------------------

export type SessionState = 'idle' | 'connecting' | 'streaming' | 'stopped' | 'error'

export type StreamSessionConfig = {
  /** STUN server hostname */
  stunHost: string
  /** STUN server port */
  stunPort: number
  /** CAS broker connection config */
  cas: CasClientConfig
  /** Parameters for the PLAY_REQUEST */
  play: PlayRequestParams
  /** HLS output config */
  hls: HlsConfig
}

// -- Deps (injectable for testing) -------------------------------------------

export type StreamSessionDeps = {
  stunBind: (host: string, port: number) => Promise<StunResult>
  generateKeyPair: () => KeyPair
  createCasClient: (config: CasClientConfig) => CasClient
  createHlsPipe: (config: HlsConfig) => FfmpegHlsPipe
}

const defaultDeps: StreamSessionDeps = {
  stunBind: rfc5389StunBind,
  generateKeyPair,
  createCasClient: (config) => new CasClient(config),
  createHlsPipe: (config) => new FfmpegHlsPipe(config),
}

// -- StreamSession ------------------------------------------------------------

export class StreamSession extends EventEmitter {
  private readonly config: StreamSessionConfig
  private readonly deps: StreamSessionDeps

  private _state: SessionState = 'idle'
  private casClient: CasClient | null = null
  private hlsPipe: FfmpegHlsPipe | null = null
  private keyPair: KeyPair | null = null
  private publicAddress: StunResult | null = null

  constructor(config: StreamSessionConfig, deps?: Partial<StreamSessionDeps>) {
    super()
    this.config = config
    this.deps = { ...defaultDeps, ...deps }
  }

  get state(): SessionState {
    return this._state
  }

  /**
   * Start the full streaming flow:
   * 1. STUN binding to discover public address
   * 2. ECDH key pair generation
   * 3. CAS broker connection + PLAY_REQUEST
   * 4. FFmpeg HLS pipe wiring
   *
   * Returns the HLS playlist path on success.
   */
  async start(): Promise<string> {
    if (this._state !== 'idle') {
      throw new Error(`Cannot start: state is ${this._state}`)
    }

    this.transition('connecting')

    try {
      // Step 1: STUN binding
      this.publicAddress = await this.deps.stunBind(
        this.config.stunHost,
        this.config.stunPort,
      )

      // Step 2: ECDH key pair
      this.keyPair = this.deps.generateKeyPair()

      // Step 3: CAS broker connection + PLAY_REQUEST
      this.casClient = this.deps.createCasClient(this.config.cas)
      await this.casClient.connect()
      this.casClient.sendPlayRequest(this.config.play)

      // Step 4: FFmpeg HLS pipe
      this.hlsPipe = this.deps.createHlsPipe(this.config.hls)
      this.hlsPipe.start()

      this.transition('streaming')
      return this.hlsPipe.getPlaylistPath()
    } catch (err) {
      this.transition('error')
      this.cleanup()
      throw err
    }
  }

  /**
   * Tear down all resources cleanly.
   */
  stop(): void {
    if (this._state === 'stopped' || this._state === 'idle') {
      return
    }

    this.cleanup()
    this.transition('stopped')
  }

  /** Get the discovered public address (available after STUN binding). */
  getPublicAddress(): StunResult | null {
    return this.publicAddress
  }

  /** Get the ECDH key pair (available after key generation). */
  getKeyPair(): KeyPair | null {
    return this.keyPair
  }

  // -- Private ----------------------------------------------------------------

  private transition(next: SessionState): void {
    const prev = this._state
    this._state = next
    this.emit('stateChange', { from: prev, to: next })
  }

  private cleanup(): void {
    if (this.casClient) {
      this.casClient.disconnect()
      this.casClient = null
    }
    if (this.hlsPipe) {
      this.hlsPipe.stop()
      this.hlsPipe = null
    }
  }
}
