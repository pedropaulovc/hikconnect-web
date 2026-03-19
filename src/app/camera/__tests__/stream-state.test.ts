import { describe, it, expect } from 'vitest'
import {
  LIVE_STATES,
  PLAYBACK_STATES,
  type LiveState,
  type PlaybackState,
} from '../stream-states'

describe('Stream state machines', () => {
  describe('LiveState', () => {
    it('has exactly 4 states', () => {
      expect(LIVE_STATES).toHaveLength(4)
    })

    it('includes idle', () => {
      expect(LIVE_STATES).toContain('idle')
    })

    it('includes starting', () => {
      expect(LIVE_STATES).toContain('starting')
    })

    it('includes streaming', () => {
      expect(LIVE_STATES).toContain('streaming')
    })

    it('includes stopping', () => {
      expect(LIVE_STATES).toContain('stopping')
    })

    it('does not use boolean-like names', () => {
      for (const s of LIVE_STATES) {
        expect(s).not.toMatch(/^(true|false|is|has|loading)/)
      }
    })
  })

  describe('PlaybackState', () => {
    it('has exactly 5 states', () => {
      expect(PLAYBACK_STATES).toHaveLength(5)
    })

    it('includes idle', () => {
      expect(PLAYBACK_STATES).toContain('idle')
    })

    it('includes loading-recordings', () => {
      expect(PLAYBACK_STATES).toContain('loading-recordings')
    })

    it('includes starting', () => {
      expect(PLAYBACK_STATES).toContain('starting')
    })

    it('includes playing', () => {
      expect(PLAYBACK_STATES).toContain('playing')
    })

    it('includes stopping', () => {
      expect(PLAYBACK_STATES).toContain('stopping')
    })

    it('does not use boolean-like names', () => {
      for (const s of PLAYBACK_STATES) {
        expect(s).not.toMatch(/^(true|false|is|has|loading$)/)
      }
    })
  })
})
