import { Redirect, Route } from 'react-router-dom';
import { IonApp, IonRouterOutlet, IonSplitPane } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';

import { SideMenu } from './components/SideMenu';
import { LivePage } from './pages/LivePage';
import { RecordingsPage } from './pages/RecordingsPage';
import { EventsPage } from './pages/EventsPage';
import { CameraDetailPage } from './pages/CameraDetailPage';
import { PlaybackPage } from './pages/PlaybackPage';

export function App() {
  return (
    <IonApp>
      <IonReactRouter>
        <IonSplitPane contentId="main" when="md">
          <SideMenu />
          <IonRouterOutlet id="main">
            <Route exact path="/live" component={LivePage} />
            <Route exact path="/live/:cameraId" component={CameraDetailPage} />
            <Route exact path="/recordings" component={RecordingsPage} />
            <Route exact path="/playback/:recordingId" component={PlaybackPage} />
            <Route exact path="/events" component={EventsPage} />
            <Route exact path="/">
              <Redirect to="/live" />
            </Route>
          </IonRouterOutlet>
        </IonSplitPane>
      </IonReactRouter>
    </IonApp>
  );
}
