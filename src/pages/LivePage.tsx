import {
  IonCol,
  IonContent,
  IonGrid,
  IonHeader,
  IonPage,
  IonRow,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { CameraCard } from '../components/CameraCard';
import { cameras } from '../data';

export function LivePage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Cameras</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonGrid>
          <IonRow>
            {cameras.map((camera) => (
              <IonCol size="12" sizeMd="6" key={camera.id}>
                <CameraCard camera={camera} />
              </IonCol>
            ))}
          </IonRow>
        </IonGrid>
      </IonContent>
    </IonPage>
  );
}
