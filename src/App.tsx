import { Redirect, Route } from 'react-router-dom';
import {
  IonApp,
  IonIcon,
  IonLabel,
  IonRouterOutlet,
  IonTabBar,
  IonTabButton,
  IonTabs,
} from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { videocam, film, notifications } from 'ionicons/icons';

import { LivePage } from './pages/LivePage';
import { RecordingsPage } from './pages/RecordingsPage';
import { EventsPage } from './pages/EventsPage';
import { CameraDetailPage } from './pages/CameraDetailPage';
import { PlaybackPage } from './pages/PlaybackPage';

export function App() {
  return (
    <IonApp>
      <IonReactRouter>
        <IonTabs>
          <IonRouterOutlet>
            <Route exact path="/live" component={LivePage} />
            <Route exact path="/live/:cameraId" component={CameraDetailPage} />
            <Route exact path="/recordings" component={RecordingsPage} />
            <Route exact path="/playback/:recordingId" component={PlaybackPage} />
            <Route exact path="/events" component={EventsPage} />
            <Route exact path="/">
              <Redirect to="/live" />
            </Route>
          </IonRouterOutlet>

          <IonTabBar slot="bottom">
            <IonTabButton tab="live" href="/live">
              <IonIcon icon={videocam} />
              <IonLabel>Live</IonLabel>
            </IonTabButton>
            <IonTabButton tab="recordings" href="/recordings">
              <IonIcon icon={film} />
              <IonLabel>Recordings</IonLabel>
            </IonTabButton>
            <IonTabButton tab="events" href="/events">
              <IonIcon icon={notifications} />
              <IonLabel>Events</IonLabel>
            </IonTabButton>
          </IonTabBar>
        </IonTabs>
      </IonReactRouter>
    </IonApp>
  );
}
