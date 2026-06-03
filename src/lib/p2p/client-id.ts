/**
 * clientId for the PLAY_REQUEST expand header (tag 0x02).
 *
 * Verified empirically (scripts/diag-stream-reliability.ts): this value is NOT
 * validated by the device/P2P server — it is a client-side correlation id only.
 * Random values stream fine, so we mint a fresh non-zero uint32 per session
 * rather than hardcoding the app's captured value.
 */
export function randomClientId(): number {
  return (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0
}
