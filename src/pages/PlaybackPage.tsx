import { Redirect, useParams } from 'react-router-dom';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { VideoPlayer } from '../components/VideoPlayer';
import { cameraById, recordingById } from '../data';
import { formatClock } from '../components/detection';

export function PlaybackPage() {
  const { recordingId } = useParams<{ recordingId: string }>();
  const recording = recordingById(recordingId);

  if (!recording) {
    return <Redirect to="/recordings" />;
  }

  const camera = cameraById(recording.cameraId);
  const date = new Date(recording.start).toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/recordings" />
          </IonButtons>
          <IonTitle>{camera?.name ?? 'Playback'}</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="page-content">
          <VideoPlayer src={recording.videoUrl} poster={recording.thumbnailUrl} />

          <div className="ion-padding-horizontal ion-padding-top">
            <IonText>
              <h2 style={{ margin: '0 0 4px' }}>{camera?.name ?? recording.cameraId}</h2>
            </IonText>
            <IonNote>{date}</IonNote>
          </div>

          <IonList>
          <IonItem>
            <IonLabel>Start</IonLabel>
            <IonNote slot="end">{formatClock(recording.start)}</IonNote>
          </IonItem>
          <IonItem>
            <IonLabel>End</IonLabel>
            <IonNote slot="end">{formatClock(recording.end)}</IonNote>
          </IonItem>
          <IonItem>
            <IonLabel>Duration</IonLabel>
            <IonNote slot="end">{recording.durationSec}s</IonNote>
          </IonItem>
          </IonList>
        </div>
      </IonContent>
    </IonPage>
  );
}
