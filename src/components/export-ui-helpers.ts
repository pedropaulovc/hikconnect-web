/**
 * Pure conversions between the device wall-clock strings the playback/export
 * API uses and the `datetime-local` input value, kept timezone-stable: we treat
 * the string's literal Y-M-D H:M:S as wall-clock components and never route
 * through `new Date()`, so the displayed/exported time can't drift by the
 * browser's timezone (playback times are device-local with no real offset).
 */

/** Pull the literal date/time components out of a server time string. */
function parts(serverTime: string): { date: string; time: string } | null {
  // Accept "YYYY-MM-DDTHH:MM:SS", a space separator, and a trailing Z/offset.
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/.exec(serverTime)
  if (!m) return null
  return { date: m[1], time: m[3] ? `${m[2]}:${m[3]}` : m[2] }
}

/** Server time ("YYYY-MM-DDTHH:MM:SS[Z]") → datetime-local value ("YYYY-MM-DDTHH:MM"). */
export function serverToDatetimeLocal(serverTime: string): string {
  const p = parts(serverTime)
  if (!p) return ''
  // datetime-local takes minute precision; seconds are re-added on the way back.
  return `${p.date}T${p.time.slice(0, 5)}`
}

/** datetime-local value → playback/export server format "YYYY-MM-DDTHH:MM:SS". */
export function datetimeLocalToPlayback(local: string): string {
  const p = parts(local)
  if (!p) return ''
  const time = p.time.length === 5 ? `${p.time}:00` : p.time
  return `${p.date}T${time}`
}
