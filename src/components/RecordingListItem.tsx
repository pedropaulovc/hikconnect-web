import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Recording } from '../data/types';
import { colors } from '../theme/colors';
import { useNav } from '../navigation/router';
import { formatClock } from './detection';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function RecordingListItem({
  recording,
  cameraName,
}: {
  recording: Recording;
  cameraName?: string;
}) {
  const nav = useNav();

  return (
    <Pressable
      style={styles.row}
      onPress={() => nav.push({ name: 'playback', recordingId: recording.id })}
    >
      <Image source={{ uri: recording.thumbnailUrl }} style={styles.thumb} />
      <View style={styles.body}>
        <Text style={styles.title}>{formatClock(recording.start)}</Text>
        <Text style={styles.sub}>{cameraName ?? recording.cameraId}</Text>
      </View>
      <Text style={styles.note}>{formatDuration(recording.durationSec)}</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.medium} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  thumb: { width: 64, height: 40, borderRadius: 6, backgroundColor: colors.surfaceAlt },
  body: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.textMuted, fontSize: 13 },
  note: { color: colors.textMuted, fontSize: 12 },
});
