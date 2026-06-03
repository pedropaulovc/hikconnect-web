import type { LiveStream } from '@/lib/p2p/live-stream'

/**
 * In-memory session stores. Live for the lifetime of the server process.
 *
 * Pinned to globalThis: Next.js bundles each route handler separately, so a
 * plain module-level Map gets duplicated per route bundle — /stream/start
 * would write to one Map and /stream/stop read an empty other. globalThis is
 * shared across every bundle in the process and survives HMR.
 */
const g = globalThis as unknown as {
  __hikSessions?: Map<string, LiveStream>
  __hikDeviceLastStop?: Map<string, number>
}

/** Keyed by sessionId (e.g. "L38239367-1-1710700000000"). */
export const sessions = (g.__hikSessions ??= new Map<string, LiveStream>())

/**
 * Tracks when each device serial last had a session stopped.
 * Used to enforce a cooldown period between sessions — the NVR needs time
 * to release P2P stream slots after teardown.
 */
export const deviceLastStop = (g.__hikDeviceLastStop ??= new Map<string, number>())

/** Minimum ms between stopping one session and starting the next for the same device. */
export const DEVICE_COOLDOWN_MS = 5_000
