import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme/colors';
import { useNav, type Route } from './navigation/router';
import { Sidebar } from './components/Sidebar';
import { CamerasWallScreen } from './screens/CamerasWallScreen';
import { CameraDetailScreen } from './screens/CameraDetailScreen';
import { RecordingsScreen } from './screens/RecordingsScreen';
import { PlaybackScreen } from './screens/PlaybackScreen';
import { EventsScreen } from './screens/EventsScreen';
import { cameraById, recordingById } from './data';

function screenFor(route: Route) {
  switch (route.name) {
    case 'wall':
      return <CamerasWallScreen />;
    case 'cameraDetail':
      return <CameraDetailScreen cameraId={route.cameraId} />;
    case 'recordings':
      return <RecordingsScreen />;
    case 'playback':
      return <PlaybackScreen recordingId={route.recordingId} />;
    case 'events':
      return <EventsScreen />;
  }
}

function titleFor(route: Route): string {
  switch (route.name) {
    case 'wall':
      return 'Camera Wall';
    case 'cameraDetail':
      return cameraById(route.cameraId)?.name ?? 'Camera';
    case 'recordings':
      return 'Recordings';
    case 'playback': {
      const rec = recordingById(route.recordingId);
      return rec ? cameraById(rec.cameraId)?.name ?? 'Playback' : 'Playback';
    }
    case 'events':
      return 'Events';
  }
}

export function AppShell() {
  const nav = useNav();
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <View style={styles.root}>
      {wide && <Sidebar />}

      <View style={styles.main}>
        <View style={styles.header}>
          {nav.canGoBack ? (
            <Pressable style={styles.iconBtn} onPress={() => nav.back()}>
              <Ionicons name="arrow-back" size={22} color={colors.text} />
            </Pressable>
          ) : !wide ? (
            <Pressable style={styles.iconBtn} onPress={() => setMenuOpen(true)}>
              <Ionicons name="menu" size={24} color={colors.text} />
            </Pressable>
          ) : null}
          <Text style={styles.title}>{titleFor(nav.route)}</Text>
        </View>
        <View style={styles.body}>{screenFor(nav.route)}</View>
      </View>

      {!wide && menuOpen && (
        <View style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)} />
          <Sidebar onNavigate={() => setMenuOpen(false)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg },
  main: { flex: 1, minWidth: 0 },
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  iconBtn: { padding: 6 },
  title: { color: colors.text, fontSize: 18, fontWeight: '600' },
  body: { flex: 1 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' },
});
