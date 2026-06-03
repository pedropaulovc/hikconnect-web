import { IonBadge, IonCard, IonCardHeader, IonCardSubtitle, IonCardTitle, IonImg } from '@ionic/react';
import type { Camera } from '../data/types';

interface CameraCardProps {
  camera: Camera;
}

export function CameraCard({ camera }: CameraCardProps) {
  const statusColor = camera.status === 'online' ? 'success' : 'medium';
  return (
    <IonCard routerLink={`/live/${camera.id}`} button>
      <div style={{ position: 'relative' }}>
        <IonImg
          src={camera.posterUrl}
          alt={camera.name}
          style={{ aspectRatio: '16 / 9', objectFit: 'cover' }}
        />
        <IonBadge
          color={statusColor}
          style={{ position: 'absolute', top: 8, right: 8 }}
        >
          {camera.status}
        </IonBadge>
      </div>
      <IonCardHeader>
        <IonCardTitle>{camera.name}</IonCardTitle>
        <IonCardSubtitle>{camera.location}</IonCardSubtitle>
      </IonCardHeader>
    </IonCard>
  );
}
