import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/react';

export function PlaybackPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/recordings" />
          </IonButtons>
          <IonTitle>Playback</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">Playback</IonContent>
    </IonPage>
  );
}
