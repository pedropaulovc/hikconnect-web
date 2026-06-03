import { useState } from 'react';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonItemDivider,
  IonItemGroup,
  IonLabel,
  IonList,
  IonMenuButton,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { RecordingListItem } from '../components/RecordingListItem';
import { allRecordingsNewestFirst, cameraById, cameras } from '../data';

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

export function RecordingsPage() {
  const [cameraFilter, setCameraFilter] = useState<string>('all');

  const recordings = allRecordingsNewestFirst().filter(
    (r) => cameraFilter === 'all' || r.cameraId === cameraFilter,
  );

  // Group by calendar day, preserving newest-first order.
  const groups = new Map<string, typeof recordings>();
  for (const r of recordings) {
    const key = r.start.slice(0, 10);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>
          <IonTitle>Recordings</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList className="page-content">{/* max-width wrapper for desktop */}
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

          {[...groups.entries()].map(([day, items]) => (
            <IonItemGroup key={day}>
              <IonItemDivider sticky>
                <IonLabel>{dayLabel(items[0].start)}</IonLabel>
              </IonItemDivider>
              {items.map((recording) => (
                <RecordingListItem
                  key={recording.id}
                  recording={recording}
                  cameraName={cameraById(recording.cameraId)?.name}
                />
              ))}
            </IonItemGroup>
          ))}
        </IonList>
      </IonContent>
    </IonPage>
  );
}
