import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { cameraById, eventsForCamera, recordingsForCamera } from '../data';
import { colors } from '../theme/colors';
import { LivePlayer } from '../components/LivePlayer';
import { EventListItem } from '../components/EventListItem';
import { RecordingListItem } from '../components/RecordingListItem';
import { Badge, SectionHeader } from '../components/ui';

export function CameraDetailScreen({ cameraId }: { cameraId: string }) {
  const router = useRouter();
  const camera = cameraById(cameraId);
  const { width } = useWindowDimensions();
  const wide = width >= 1100;

  if (!camera) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Camera not found.</Text>
      </View>
    );
  }

  const online = camera.status === 'online';
  const activity = eventsForCamera(camera.id);
  const recordings = recordingsForCamera(camera.id).slice(0, 4);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={[styles.layout, wide && styles.layoutWide]}>
        <View style={[styles.main, wide && styles.mainWide]}>
          <View style={styles.player}>
            {online ? (
              <LivePlayer src={camera.liveStreamUrl} poster={camera.posterUrl} controls fit="contain" />
            ) : (
              <View style={styles.offline}>
                <Text style={styles.offlineText}>Camera offline</Text>
              </View>
            )}
          </View>
          <View style={styles.meta}>
            <Text style={styles.title}>{camera.name}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.sub}>{camera.location}</Text>
              <Badge label={camera.status} color={online ? colors.success : colors.medium} />
            </View>
          </View>
        </View>

        <View style={[styles.side, wide && styles.sideWide]}>
          <SectionHeader title="Activity" />
          {activity.length === 0 && <Text style={styles.empty}>No recent detections.</Text>}
          {activity.map((event) => (
            <EventListItem key={event.id} event={event} />
          ))}

          <SectionHeader
            title="Recordings"
            action={
              <Pressable onPress={() => router.replace('/recordings')}>
                <Text style={styles.link}>View all</Text>
              </Pressable>
            }
          />
          {recordings.length === 0 && <Text style={styles.empty}>No recordings.</Text>}
          {recordings.map((recording) => (
            <RecordingListItem key={recording.id} recording={recording} cameraName={camera.name} />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 16, maxWidth: 1600, width: '100%', alignSelf: 'center' },
  layout: { flexDirection: 'column', gap: 16 },
  layoutWide: { flexDirection: 'row', alignItems: 'flex-start' },
  main: {},
  mainWide: { flex: 2.2 },
  player: { width: '100%', aspectRatio: 16 / 9, backgroundColor: colors.black, borderRadius: 10, overflow: 'hidden' },
  offline: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  offlineText: { color: colors.medium },
  meta: { paddingHorizontal: 4, paddingTop: 12, gap: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  sub: { color: colors.textMuted, fontSize: 14 },
  side: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  sideWide: { flex: 1 },
  empty: { color: colors.textMuted, padding: 14 },
  link: { color: colors.primary, fontWeight: '600' },
  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  notFoundText: { color: colors.textMuted },
});
