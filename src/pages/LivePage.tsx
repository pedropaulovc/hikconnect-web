import {
  IonButtons,
  IonContent,
  IonHeader,
  IonMenuButton,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { CameraTile } from '../components/CameraTile';
import { cameras, eventsForCamera } from '../data';
import './LivePage.css';

export function LivePage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>
          <IonTitle>Camera Wall</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="camera-wall">
          {cameras.map((camera) => (
            <CameraTile
              key={camera.id}
              camera={camera}
              lastEvent={eventsForCamera(camera.id)[0]}
            />
          ))}
        </div>
      </IonContent>
    </IonPage>
  );
}
