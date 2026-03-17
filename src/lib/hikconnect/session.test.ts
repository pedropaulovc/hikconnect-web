// src/lib/hikconnect/session.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SessionStore } from './session'

describe('SessionStore', () => {
  let store: SessionStore

  beforeEach(() => {
    store = new SessionStore()
  })

  it('starts with no session', () => {
    expect(store.get()).toBeNull()
  })

  it('stores and retrieves a session', () => {
    const session = {
      sessionId: 'sess1',
      refreshSessionId: 'rf1',
      apiDomain: 'https://api.hik-connect.com',
      expiresAt: Date.now() + 3600000,
    }
    store.set(session)
    expect(store.get()).toEqual(session)
  })

  it('reports expired sessions', () => {
    store.set({
      sessionId: 'sess1',
      refreshSessionId: 'rf1',
      apiDomain: 'https://api.hik-connect.com',
      expiresAt: Date.now() - 1000,
    })
    expect(store.isExpired()).toBe(true)
  })

  it('reports non-expired sessions', () => {
    store.set({
      sessionId: 'sess1',
      refreshSessionId: 'rf1',
      apiDomain: 'https://api.hik-connect.com',
      expiresAt: Date.now() + 3600000,
    })
    expect(store.isExpired()).toBe(false)
  })

  it('clear removes the session', () => {
    store.set({
      sessionId: 'sess1',
      refreshSessionId: 'rf1',
      apiDomain: 'https://api.hik-connect.com',
      expiresAt: Date.now() + 3600000,
    })
    store.clear()
    expect(store.get()).toBeNull()
  })
})
