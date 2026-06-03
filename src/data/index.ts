export * from './types';
export { cameras } from './cameras';
export { events } from './events';
export { recordings } from './recordings';

import { cameras } from './cameras';
import { events } from './events';
import { recordings } from './recordings';
import type { Camera, DetectionEvent, Recording } from './types';

const byTimeDesc = (a: { timestamp: string }, b: { timestamp: string }) =>
  a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0;

const byStartDesc = (a: Recording, b: Recording) =>
  a.start < b.start ? 1 : a.start > b.start ? -1 : 0;

export function cameraById(id: string): Camera | undefined {
  return cameras.find((c) => c.id === id);
}

export function eventsForCamera(cameraId: string): DetectionEvent[] {
  return events.filter((e) => e.cameraId === cameraId).sort(byTimeDesc);
}

export function recordingsForCamera(cameraId: string): Recording[] {
  return recordings.filter((r) => r.cameraId === cameraId).sort(byStartDesc);
}

export function recordingById(id: string): Recording | undefined {
  return recordings.find((r) => r.id === id);
}

export function allEventsNewestFirst(): DetectionEvent[] {
  return [...events].sort(byTimeDesc);
}

export function allRecordingsNewestFirst(): Recording[] {
  return [...recordings].sort(byStartDesc);
}
