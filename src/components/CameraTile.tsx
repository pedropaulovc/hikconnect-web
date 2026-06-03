import { IonChip, IonIcon, IonRouterLink } from '@ionic/react';
import { videocamOff } from 'ionicons/icons';
import type { Camera, DetectionEvent } from '../data/types';
import { LivePlayer } from './LivePlayer';
import { detectionMeta, formatRelativeTime } from './detection';
import './CameraTile.css';

interface CameraTileProps {
  camera: Camera;
  lastEvent?: DetectionEvent;
}

/** A single live tile in the camera wall. Streams when online, shows an offline state otherwise. */
export function CameraTile({ camera, lastEvent }: CameraTileProps) {
  const online = camera.status === 'online';

  return (
    <IonRouterLink className="cam-tile" routerLink={`/live/${camera.id}`}>
      <div className="cam-tile__video">
        {online ? (
          <LivePlayer src={camera.liveStreamUrl} poster={camera.posterUrl} controls={false} fit="cover" />
        ) : (
          <div className="cam-tile__offline" style={{ backgroundImage: `url(${camera.posterUrl})` }}>
            <IonIcon icon={videocamOff} />
            <span>Offline</span>
          </div>
        )}
      </div>

      <div className="cam-tile__bar">
        <span className={`cam-tile__dot cam-tile__dot--${camera.status}`} />
        <span className="cam-tile__name">{camera.name}</span>
        {lastEvent && (
          <IonChip className="cam-tile__event" color={detectionMeta(lastEvent.type).color}>
            <IonIcon icon={detectionMeta(lastEvent.type).icon} />
            <span>{formatRelativeTime(lastEvent.timestamp)}</span>
          </IonChip>
        )}
      </div>
    </IonRouterLink>
  );
}
