// src/lib/hikconnect/session.ts
import type { Session } from './types'

export class SessionStore {
  private session: Session | null = null

  get(): Session | null {
    return this.session
  }

  set(session: Session) {
    this.session = session
  }

  clear() {
    this.session = null
  }

  isExpired(): boolean {
    if (!this.session) return true
    return Date.now() >= this.session.expiresAt
  }
}

/** Global singleton — lives for the lifetime of the Node.js process */
export const sessionStore = new SessionStore()
