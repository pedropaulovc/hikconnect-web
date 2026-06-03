import { useLocation } from 'react-router-dom';
import {
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonMenu,
  IonMenuToggle,
  IonNote,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { videocam, film, notifications } from 'ionicons/icons';

const NAV = [
  { path: '/live', label: 'Cameras', icon: videocam },
  { path: '/recordings', label: 'Recordings', icon: film },
  { path: '/events', label: 'Events', icon: notifications },
];

export function SideMenu() {
  const location = useLocation();

  return (
    <IonMenu contentId="main" type="overlay">
      <IonHeader>
        <IonToolbar>
          <IonTitle>CCTV Demo</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <IonList>
          <IonListHeader>
            <IonLabel>Monitoring</IonLabel>
          </IonListHeader>
          {NAV.map((item) => {
            const active = location.pathname.startsWith(item.path);
            return (
              <IonMenuToggle key={item.path} autoHide={false}>
                <IonItem
                  routerLink={item.path}
                  routerDirection="root"
                  lines="none"
                  detail={false}
                  color={active ? 'primary' : undefined}
                >
                  <IonIcon slot="start" icon={item.icon} />
                  <IonLabel>{item.label}</IonLabel>
                </IonItem>
              </IonMenuToggle>
            );
          })}
        </IonList>
        <IonNote className="ion-padding" color="medium">
          Demo data · public sample streams
        </IonNote>
      </IonContent>
    </IonMenu>
  );
}
