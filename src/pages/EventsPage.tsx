import { IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/react';

export function EventsPage() {
  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Events</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">Events</IonContent>
    </IonPage>
  );
}
