/** datetime-local value ("YYYY-MM-DDTHH:mm[:ss]") -> filter API format "yyyy-MM-dd HH:mm:ss". */
export function datetimeLocalToServer(local: string): string {
  const withSeconds = local.length === 16 ? `${local}:00` : local
  return withSeconds.replace('T', ' ')
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Format local wall-clock components as a datetime-local input value (no seconds). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Default filter window: last 24h ending at `now`, as datetime-local input values. */
export function defaultAlarmRange(now: Date): { from: string; to: string } {
  const from = new Date(now.getTime() - 24 * 3600 * 1000)
  return { from: toLocalInput(from), to: toLocalInput(now) }
}

/**
 * Build a playback window around an alarm in playback format "YYYY-MM-DDTHH:MM:SS"
 * (device wall-clock, no timezone). We parse alarmStartTimeStr as UTC and format UTC
 * components so the arithmetic never drifts by the runner's local timezone.
 */
export function eventToPlaybackWindow(
  event: { alarmStartTimeStr: string; preTime: number; delayTime: number },
): { begin: string; end: string } {
  const base = Date.parse(`${event.alarmStartTimeStr.replace(' ', 'T')}Z`)
  const fmt = (ms: number) => {
    const d = new Date(ms)
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  }
  return {
    begin: fmt(base - (event.preTime ?? 0) * 1000),
    end: fmt(base + (event.delayTime ?? 0) * 1000),
  }
}
