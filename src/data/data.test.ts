import { cameras } from './cameras';
import { events } from './events';
import { recordings } from './recordings';
import {
  cameraById,
  eventsForCamera,
  recordingsForCamera,
  recordingById,
  allEventsNewestFirst,
  allRecordingsNewestFirst,
} from './index';

const DETECTION_TYPES = ['person', 'vehicle', 'motion', 'animal'];

describe('mock data integrity', () => {
  it('has multiple cameras', () => {
    expect(cameras.length).toBeGreaterThanOrEqual(3);
  });

  it('every event references a real camera and valid type', () => {
    const ids = new Set(cameras.map((c) => c.id));
    for (const e of events) {
      expect(ids.has(e.cameraId)).toBe(true);
      expect(DETECTION_TYPES).toContain(e.type);
    }
  });

  it('every recording references a real camera with positive duration', () => {
    const ids = new Set(cameras.map((c) => c.id));
    for (const r of recordings) {
      expect(ids.has(r.cameraId)).toBe(true);
      expect(r.durationSec).toBeGreaterThan(0);
    }
  });

  it('every event recordingId, when present, references a real recording', () => {
    const ids = new Set(recordings.map((r) => r.id));
    for (const e of events) {
      if (e.recordingId) expect(ids.has(e.recordingId)).toBe(true);
    }
  });
});

describe('selectors', () => {
  it('cameraById finds a camera and returns undefined for unknown', () => {
    expect(cameraById(cameras[0].id)?.id).toBe(cameras[0].id);
    expect(cameraById('nope')).toBeUndefined();
  });

  it('recordingById finds a recording and returns undefined for unknown', () => {
    expect(recordingById(recordings[0].id)?.id).toBe(recordings[0].id);
    expect(recordingById('nope')).toBeUndefined();
  });

  it('eventsForCamera returns only that camera, newest first', () => {
    const id = cameras[0].id;
    const list = eventsForCamera(id);
    expect(list.every((e) => e.cameraId === id)).toBe(true);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].timestamp >= list[i].timestamp).toBe(true);
    }
  });

  it('recordingsForCamera returns only that camera, newest first', () => {
    const id = cameras[0].id;
    const list = recordingsForCamera(id);
    expect(list.every((r) => r.cameraId === id)).toBe(true);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].start >= list[i].start).toBe(true);
    }
  });

  it('allEventsNewestFirst is sorted descending and covers every event', () => {
    const list = allEventsNewestFirst();
    expect(list).toHaveLength(events.length);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].timestamp >= list[i].timestamp).toBe(true);
    }
  });

  it('allRecordingsNewestFirst is sorted descending and covers every recording', () => {
    const list = allRecordingsNewestFirst();
    expect(list).toHaveLength(recordings.length);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].start >= list[i].start).toBe(true);
    }
  });
});
