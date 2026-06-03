import { IonItem, IonLabel, IonNote, IonThumbnail } from '@ionic/react';
import type { Recording } from '../data/types';
import { formatClock } from './detection';

interface RecordingListItemProps {
  recording: Recording;
  cameraName?: string;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function RecordingListItem({ recording, cameraName }: RecordingListItemProps) {
  return (
    <IonItem routerLink={`/playback/${recording.id}`} detail>
      <IonThumbnail slot="start">
        <img src={recording.thumbnailUrl} alt="recording" />
      </IonThumbnail>
      <IonLabel>
        <h2>{formatClock(recording.start)}</h2>
        <p>{cameraName ?? recording.cameraId}</p>
      </IonLabel>
      <IonNote slot="end">{formatDuration(recording.durationSec)}</IonNote>
    </IonItem>
  );
}
