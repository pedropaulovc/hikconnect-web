import type { LiveStream } from '@/lib/p2p/live-stream'

/**
 * In-memory session store. Lives for the lifetime of the server process.
 * Keyed by sessionId (e.g. "L38239367-1-1710700000000").
 */
export const sessions = new Map<string, LiveStream>()

/**
 * Tracks when each device serial last had a session stopped.
 * Used to enforce a cooldown period between sessions — the NVR needs time
 * to release P2P stream slots after teardown.
 */
export const deviceLastStop = new Map<string, number>()

/** Minimum ms between stopping one session and starting the next for the same device. */
export const DEVICE_COOLDOWN_MS = 5_000
