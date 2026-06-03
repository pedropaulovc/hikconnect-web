import { Redirect, useParams } from 'react-router-dom';
import {
  IonBackButton,
  IonBadge,
  IonButtons,
  IonContent,
  IonHeader,
  IonItemDivider,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonRouterLink,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { LivePlayer } from '../components/LivePlayer';
import { EventListItem } from '../components/EventListItem';
import { RecordingListItem } from '../components/RecordingListItem';
import { cameraById, eventsForCamera, recordingsForCamera } from '../data';

export function CameraDetailPage() {
  const { cameraId } = useParams<{ cameraId: string }>();
  const camera = cameraById(cameraId);

  if (!camera) {
    return <Redirect to="/live" />;
  }

  const activity = eventsForCamera(camera.id);
  const recordings = recordingsForCamera(camera.id).slice(0, 4);
  const statusColor = camera.status === 'online' ? 'success' : 'medium';

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/live" />
          </IonButtons>
          <IonTitle>{camera.name}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <LivePlayer src={camera.liveStreamUrl} poster={camera.posterUrl} />

        <div className="ion-padding-horizontal ion-padding-top">
          <IonText>
            <h2 style={{ margin: '0 0 4px' }}>{camera.name}</h2>
          </IonText>
          <IonNote>{camera.location}</IonNote>{' '}
          <IonBadge color={statusColor}>{camera.status}</IonBadge>
        </div>

        <IonList>
          <IonItemDivider>
            <IonLabel>Activity</IonLabel>
          </IonItemDivider>
          {activity.length === 0 && (
            <div className="ion-padding">
              <IonNote>No recent detections.</IonNote>
            </div>
          )}
          {activity.map((event) => (
            <EventListItem key={event.id} event={event} />
          ))}

          <IonItemDivider>
            <IonLabel>Recordings</IonLabel>
            <IonRouterLink slot="end" routerLink="/recordings" className="ion-padding-end">
              View all
            </IonRouterLink>
          </IonItemDivider>
          {recordings.length === 0 && (
            <div className="ion-padding">
              <IonNote>No recordings.</IonNote>
            </div>
          )}
          {recordings.map((recording) => (
            <RecordingListItem
              key={recording.id}
              recording={recording}
              cameraName={camera.name}
            />
          ))}
        </IonList>
      </IonContent>
    </IonPage>
  );
}
