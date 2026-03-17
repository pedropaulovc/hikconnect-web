import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamSession, type StreamSessionConfig, type StreamSessionDeps, type SessionState } from '../stream-session'

// -- Helpers ------------------------------------------------------------------

function stubDeps(overrides?: Partial<StreamSessionDeps>): StreamSessionDeps {
  return {
    stunBind: vi.fn().mockResolvedValue({ address: '1.2.3.4', port: 5000 }),
    generateKeyPair: vi.fn().mockReturnValue({
      publicKey: Buffer.from('pub'),
      privateKey: Buffer.from('priv'),
    }),
    createCasClient: vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      sendPlayRequest: vi.fn(),
      disconnect: vi.fn(),
    }),
    createHlsPipe: vi.fn().mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      write: vi.fn(),
      getPlaylistPath: vi.fn().mockReturnValue('/tmp/hls/stream.m3u8'),
    }),
    ...overrides,
  }
}

const baseConfig: StreamSessionConfig = {
  stunHost: 'stun.example.com',
  stunPort: 3478,
  cas: { host: 'cas.example.com', port: 6500 },
  play: {
    busType: 1,
    sessionKey: 'test-key',
    streamType: 0,
    channelNo: 1,
    streamSession: 42,
  },
  hls: { outputDir: '/tmp/hls' },
}

// -- Tests --------------------------------------------------------------------

describe('StreamSession', () => {
  describe('construction', () => {
    it('starts in idle state', () => {
      const session = new StreamSession(baseConfig, stubDeps())
      expect(session.state).toBe('idle')
    })

    it('has no public address or key pair initially', () => {
      const session = new StreamSession(baseConfig, stubDeps())
      expect(session.getPublicAddress()).toBeNull()
      expect(session.getKeyPair()).toBeNull()
    })
  })

  describe('start()', () => {
    it('transitions idle → connecting → streaming', async () => {
      const deps = stubDeps()
      const session = new StreamSession(baseConfig, deps)
      const transitions: Array<{ from: SessionState; to: SessionState }> = []
      session.on('stateChange', (t) => transitions.push(t))

      await session.start()

      expect(transitions).toEqual([
        { from: 'idle', to: 'connecting' },
        { from: 'connecting', to: 'streaming' },
      ])
      expect(session.state).toBe('streaming')
    })

    it('returns the HLS playlist path', async () => {
      const session = new StreamSession(baseConfig, stubDeps())
      const path = await session.start()
      expect(path).toBe('/tmp/hls/stream.m3u8')
    })

    it('calls STUN bind with correct params', async () => {
      const deps = stubDeps()
      const session = new StreamSession(baseConfig, deps)
      await session.start()

      expect(deps.stunBind).toHaveBeenCalledWith('stun.example.com', 3478)
    })

    it('generates an ECDH key pair', async () => {
      const deps = stubDeps()
      const session = new StreamSession(baseConfig, deps)
      await session.start()

      expect(deps.generateKeyPair).toHaveBeenCalledOnce()
      expect(session.getKeyPair()).toEqual({
        publicKey: Buffer.from('pub'),
        privateKey: Buffer.from('priv'),
      })
    })

    it('stores discovered public address', async () => {
      const deps = stubDeps()
      const session = new StreamSession(baseConfig, deps)
      await session.start()

      expect(session.getPublicAddress()).toEqual({ address: '1.2.3.4', port: 5000 })
    })

    it('connects to CAS and sends PLAY_REQUEST', async () => {
      const deps = stubDeps()
      const session = new StreamSession(baseConfig, deps)
      await session.start()

      const casClient = (deps.createCasClient as ReturnType<typeof vi.fn>).mock.results[0].value
      expect(casClient.connect).toHaveBeenCalledOnce()
      expect(casClient.sendPlayRequest).toHaveBeenCalledWith(baseConfig.play)
    })

    it('starts the FFmpeg HLS pipe', async () => {
      const deps = stubDeps()
      const session = new StreamSession(baseConfig, deps)
      await session.start()

      const pipe = (deps.createHlsPipe as ReturnType<typeof vi.fn>).mock.results[0].value
      expect(pipe.start).toHaveBeenCalledOnce()
    })

    it('rejects when already streaming', async () => {
      const session = new StreamSession(baseConfig, stubDeps())
      await session.start()

      await expect(session.start()).rejects.toThrow('Cannot start: state is streaming')
    })

    it('rejects when stopped', async () => {
      const session = new StreamSession(baseConfig, stubDeps())
      await session.start()
      session.stop()

      await expect(session.start()).rejects.toThrow('Cannot start: state is stopped')
    })
  })

  describe('start() error handling', () => {
    it('transitions to error state when STUN fails', async () => {
      const deps = stubDeps({
        stunBind: vi.fn().mockRejectedValue(new Error('STUN timeout')),
      })
      const session = new StreamSession(baseConfig, deps)

      await expect(session.start()).rejects.toThrow('STUN timeout')
      expect(session.state).toBe('error')
    })

    it('transitions to error state when CAS connect fails', async () => {
      const deps = stubDeps({
        createCasClient: vi.fn().mockReturnValue({
          connect: vi.fn().mockRejectedValue(new Error('CAS refused')),
          sendPlayRequest: vi.fn(),
          disconnect: vi.fn(),
        }),
      })
      const session = new StreamSession(baseConfig, deps)

      await expect(session.start()).rejects.toThrow('CAS refused')
      expect(session.state).toBe('error')
    })

    it('cleans up CAS client on error', async () => {
      const mockCas = {
        connect: vi.fn().mockResolvedValue(undefined),
        sendPlayRequest: vi.fn().mockImplementation(() => { throw new Error('send fail') }),
        disconnect: vi.fn(),
      }
      const deps = stubDeps({
        createCasClient: vi.fn().mockReturnValue(mockCas),
      })
      const session = new StreamSession(baseConfig, deps)

      await expect(session.start()).rejects.toThrow('send fail')
      expect(mockCas.disconnect).toHaveBeenCalledOnce()
    })
  })

  describe('stop()', () => {
    it('transitions streaming → stopped', async () => {
      const session = new StreamSession(baseConfig, stubDeps())
      await session.start()

      session.stop()
      expect(session.state).toBe('stopped')
    })

    it('disconnects CAS and stops HLS pipe', async () => {
      const deps = stubDeps()
      const session = new StreamSession(baseConfig, deps)
      await session.start()

      const casClient = (deps.createCasClient as ReturnType<typeof vi.fn>).mock.results[0].value
      const pipe = (deps.createHlsPipe as ReturnType<typeof vi.fn>).mock.results[0].value

      session.stop()

      expect(casClient.disconnect).toHaveBeenCalledOnce()
      expect(pipe.stop).toHaveBeenCalledOnce()
    })

    it('is idempotent when already stopped', async () => {
      const session = new StreamSession(baseConfig, stubDeps())
      await session.start()
      session.stop()
      session.stop() // should not throw
      expect(session.state).toBe('stopped')
    })

    it('is a no-op when idle', () => {
      const session = new StreamSession(baseConfig, stubDeps())
      session.stop() // should not throw
      expect(session.state).toBe('idle')
    })
  })

  describe('state transitions emit events', () => {
    it('emits stateChange for the full lifecycle', async () => {
      const deps = stubDeps()
      const session = new StreamSession(baseConfig, deps)
      const transitions: Array<{ from: SessionState; to: SessionState }> = []
      session.on('stateChange', (t) => transitions.push(t))

      await session.start()
      session.stop()

      expect(transitions).toEqual([
        { from: 'idle', to: 'connecting' },
        { from: 'connecting', to: 'streaming' },
        { from: 'streaming', to: 'stopped' },
      ])
    })
  })
})
