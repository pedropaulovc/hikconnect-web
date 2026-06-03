import { Ionicons } from '@expo/vector-icons';
import { ImageBackground, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Camera, DetectionEvent } from '../data/types';
import { colors } from '../theme/colors';
import { useNav } from '../navigation/router';
import { LivePlayer } from './LivePlayer';
import { detectionMeta, formatRelativeTime } from './detection';
import { Chip, StatusDot } from './ui';

interface CameraTileProps {
  camera: Camera;
  lastEvent?: DetectionEvent;
}

/** A single live tile in the camera wall. Streams when online, shows an offline state otherwise. */
export function CameraTile({ camera, lastEvent }: CameraTileProps) {
  const nav = useNav();
  const online = camera.status === 'online';
  const meta = lastEvent ? detectionMeta(lastEvent.type) : null;

  return (
    <Pressable
      style={styles.tile}
      onPress={() => nav.push({ name: 'cameraDetail', cameraId: camera.id })}
    >
      <View style={styles.video}>
        {online ? (
          <LivePlayer src={camera.liveStreamUrl} poster={camera.posterUrl} controls={false} fit="cover" />
        ) : (
          <ImageBackground source={{ uri: camera.posterUrl }} style={styles.offline}>
            <View style={styles.offlineScrim} />
            <Ionicons name="videocam-off" size={28} color={colors.medium} />
            <Text style={styles.offlineText}>Offline</Text>
          </ImageBackground>
        )}
      </View>

      <View style={styles.bar}>
        <StatusDot online={online} />
        <Text style={styles.name} numberOfLines={1}>
          {camera.name}
        </Text>
        {lastEvent && meta && (
          <View style={styles.event}>
            <Chip label={formatRelativeTime(lastEvent.timestamp)} color={meta.color} icon={meta.icon} />
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.black,
    borderWidth: 1,
    borderColor: colors.border,
  },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: colors.black },
  offline: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  offlineScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(13,17,23,0.78)',
  },
  offlineText: { color: colors.medium, fontWeight: '600' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface,
  },
  name: { color: colors.text, fontWeight: '600', flexShrink: 1 },
  event: { marginLeft: 'auto' },
});
