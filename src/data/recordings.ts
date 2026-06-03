import type { Recording } from './types';

// Public sample MP4s (Google sample video bucket) stand in for stored clips.
const BUCKET = 'https://storage.googleapis.com/gtv-videos-bucket/sample';
const MP4 = {
  bunny: `${BUCKET}/BigBuckBunny.mp4`,
  blazes: `${BUCKET}/ForBiggerBlazes.mp4`,
  escapes: `${BUCKET}/ForBiggerEscapes.mp4`,
  fun: `${BUCKET}/ForBiggerFun.mp4`,
  joyrides: `${BUCKET}/ForBiggerJoyrides.mp4`,
  meltdowns: `${BUCKET}/ForBiggerMeltdowns.mp4`,
};

const thumb = (id: string) => `https://picsum.photos/seed/${id}/320/180`;

export const recordings: Recording[] = [
  {
    id: 'rec-001',
    cameraId: 'front-door',
    start: '2026-06-03T08:12:04',
    end: '2026-06-03T08:13:34',
    durationSec: 90,
    videoUrl: MP4.bunny,
    thumbnailUrl: thumb('rec-001'),
  },
  {
    id: 'rec-002',
    cameraId: 'front-door',
    start: '2026-06-03T07:45:00',
    end: '2026-06-03T07:46:00',
    durationSec: 60,
    videoUrl: MP4.blazes,
    thumbnailUrl: thumb('rec-002'),
  },
  {
    id: 'rec-003',
    cameraId: 'lobby',
    start: '2026-06-03T09:01:22',
    end: '2026-06-03T09:03:22',
    durationSec: 120,
    videoUrl: MP4.escapes,
    thumbnailUrl: thumb('rec-003'),
  },
  {
    id: 'rec-004',
    cameraId: 'parking-lot',
    start: '2026-06-03T06:30:10',
    end: '2026-06-03T06:31:40',
    durationSec: 90,
    videoUrl: MP4.joyrides,
    thumbnailUrl: thumb('rec-004'),
  },
  {
    id: 'rec-005',
    cameraId: 'parking-lot',
    start: '2026-06-02T22:14:55',
    end: '2026-06-02T22:16:25',
    durationSec: 90,
    videoUrl: MP4.meltdowns,
    thumbnailUrl: thumb('rec-005'),
  },
  {
    id: 'rec-006',
    cameraId: 'backyard',
    start: '2026-06-02T19:48:00',
    end: '2026-06-02T19:49:00',
    durationSec: 60,
    videoUrl: MP4.fun,
    thumbnailUrl: thumb('rec-006'),
  },
  {
    id: 'rec-007',
    cameraId: 'lobby',
    start: '2026-06-02T14:05:30',
    end: '2026-06-02T14:07:30',
    durationSec: 120,
    videoUrl: MP4.bunny,
    thumbnailUrl: thumb('rec-007'),
  },
  {
    id: 'rec-008',
    cameraId: 'front-door',
    start: '2026-06-02T11:20:00',
    end: '2026-06-02T11:21:30',
    durationSec: 90,
    videoUrl: MP4.blazes,
    thumbnailUrl: thumb('rec-008'),
  },
];
