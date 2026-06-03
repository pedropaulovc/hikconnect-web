import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';

export function RecordingsPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Recordings</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">Recordings</IonContent>
    </IonPage>
  );
}
