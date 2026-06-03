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

/**
 * Global singleton — lives for the lifetime of the Node.js process.
 *
 * Pinned to globalThis because Next.js bundles each route handler separately:
 * the login route imports this via the `@/lib/hikconnect` barrel while other
 * routes import `./session` directly, so a plain `new SessionStore()` gets
 * instantiated once per bundle (login wrote to one instance, /api/devices read
 * an empty other → 401). globalThis is shared across every bundle in the
 * process and survives HMR, guaranteeing one instance.
 */
const globalForSession = globalThis as unknown as { __hikSessionStore?: SessionStore }
export const sessionStore = globalForSession.__hikSessionStore ?? new SessionStore()
globalForSession.__hikSessionStore = sessionStore
