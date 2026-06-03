import { useState } from 'react';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonItemDivider,
  IonLabel,
  IonList,
  IonMenuButton,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { EventListItem } from '../components/EventListItem';
import { allEventsNewestFirst, cameraById, cameras } from '../data';

export function EventsPage() {
  const [cameraFilter, setCameraFilter] = useState<string>('all');

  const events = allEventsNewestFirst().filter(
    (e) => cameraFilter === 'all' || e.cameraId === cameraFilter,
  );

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>
          <IonTitle>Events</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList className="page-content">
          <IonItemDivider>
            <IonLabel>Camera</IonLabel>
            <IonSelect
              slot="end"
              value={cameraFilter}
              interface="popover"
              onIonChange={(e) => setCameraFilter(e.detail.value)}
            >
              <IonSelectOption value="all">All cameras</IonSelectOption>
              {cameras.map((c) => (
                <IonSelectOption value={c.id} key={c.id}>
                  {c.name}
                </IonSelectOption>
              ))}
            </IonSelect>
          </IonItemDivider>

          {events.map((event) => (
            <EventListItem
              key={event.id}
              event={event}
              cameraName={cameraById(event.cameraId)?.name}
            />
          ))}
        </IonList>
      </IonContent>
    </IonPage>
  );
}
