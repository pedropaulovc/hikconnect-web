import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';

export function LivePage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Cameras</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">Live</IonContent>
    </IonPage>
  );
}
