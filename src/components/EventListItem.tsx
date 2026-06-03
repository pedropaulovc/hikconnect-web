import { IonChip, IonIcon, IonItem, IonLabel, IonThumbnail } from '@ionic/react';
import type { DetectionEvent } from '../data/types';
import { detectionMeta, formatRelativeTime } from './detection';

interface EventListItemProps {
  event: DetectionEvent;
  cameraName?: string;
}

export function EventListItem({ event, cameraName }: EventListItemProps) {
  const meta = detectionMeta(event.type);

  // Events link to their recording if one exists, else to the camera's live view.
  const href = event.recordingId
    ? `/playback/${event.recordingId}`
    : `/live/${event.cameraId}`;

  return (
    <IonItem routerLink={href} detail>
      <IonThumbnail slot="start">
        <img src={event.thumbnailUrl} alt={meta.label} />
      </IonThumbnail>
      <IonLabel>
        <h2>
          <IonChip color={meta.color} style={{ marginInlineStart: 0 }}>
            <IonIcon icon={meta.icon} />
            <span>{meta.label}</span>
          </IonChip>
        </h2>
        <p>
          {cameraName ? `${cameraName} · ` : ''}
          {formatRelativeTime(event.timestamp)}
        </p>
      </IonLabel>
    </IonItem>
  );
}
