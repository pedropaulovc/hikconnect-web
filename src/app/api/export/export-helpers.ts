/**
 * Pure helpers for the export flow. Times are device wall-clock ISO
 * (YYYY-MM-DDTHH:MM:SS, no Z) — the same form /api/stream/playback uses.
 */

/** Length of the requested range in seconds; clamped to 0 for an empty/reversed range. */
export function durationSeconds(startTime: string, stopTime: string): number {
  return Math.max(0, (Date.parse(stopTime) - Date.parse(startTime)) / 1000)
}

/** Floored percent of the requested duration ffmpeg has output, clamped to [0, 100]. */
export function exportPercent(progressSec: number, totalSec: number): number {
  if (totalSec <= 0) return 0
  return Math.min(100, Math.floor((progressSec / totalSec) * 100))
}

/** Filesystem-safe, descriptive download name: cam<ch>_<date>_<HHMMSS>.mp4 */
export function exportFilename(channel: number, startTime: string): string {
  const stamp = startTime.replace('T', '_').replace(/:/g, '')
  return `cam${channel}_${stamp}.mp4`
}
