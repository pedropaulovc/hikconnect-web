import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { cameraById, recordingById } from '../data';
import { colors } from '../theme/colors';
import { VideoPlayer } from '../components/VideoPlayer';
import { formatClock, formatDay } from '../components/detection';

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

export function PlaybackScreen({ recordingId }: { recordingId: string }) {
  const recording = recordingById(recordingId);

  if (!recording) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Recording not found.</Text>
      </View>
    );
  }

  const camera = cameraById(recording.cameraId);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.player}>
        <VideoPlayer src={recording.videoUrl} poster={recording.thumbnailUrl} />
      </View>
      <Text style={styles.title}>{camera?.name ?? recording.cameraId}</Text>
      <Text style={styles.sub}>{formatDay(recording.start)}</Text>
      <View style={styles.metaList}>
        <MetaRow label="Start" value={formatClock(recording.start)} />
        <MetaRow label="End" value={formatClock(recording.end)} />
        <MetaRow label="Duration" value={`${recording.durationSec}s`} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { maxWidth: 900, width: '100%', alignSelf: 'center', padding: 16, gap: 4 },
  player: { width: '100%', aspectRatio: 16 / 9, backgroundColor: colors.black, borderRadius: 10, overflow: 'hidden' },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 12 },
  sub: { color: colors.textMuted, fontSize: 14 },
  metaList: { marginTop: 12, borderTopWidth: 1, borderColor: colors.border },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  metaLabel: { color: colors.text, fontSize: 15 },
  metaValue: { color: colors.textMuted, fontSize: 15 },
  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  notFoundText: { color: colors.textMuted },
});
