export type CameraStatus = 'online' | 'offline';
export type DetectionType = 'person' | 'vehicle' | 'motion' | 'animal';

export interface Camera {
  id: string;
  name: string;
  location: string;
  status: CameraStatus;
  posterUrl: string;
  liveStreamUrl: string;
}

export interface DetectionEvent {
  id: string;
  cameraId: string;
  type: DetectionType;
  timestamp: string; // ISO 8601
  thumbnailUrl: string;
  recordingId?: string;
}

export interface Recording {
  id: string;
  cameraId: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  durationSec: number;
  videoUrl: string; // MP4
  thumbnailUrl: string;
}
