import type { StreamSession } from '@/lib/p2p/stream-session'

/**
 * In-memory session store. Lives for the lifetime of the server process.
 * Keyed by sessionId (e.g. "L38239367-1-1710700000000").
 */
export const sessions = new Map<string, StreamSession>()
