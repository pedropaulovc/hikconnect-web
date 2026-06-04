import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DetectionEvent } from '../data/types';
import { colors } from '../theme/colors';
import { detectionMeta, formatRelativeTime } from './detection';
import { Chip } from './ui';

export function EventListItem({ event, cameraName }: { event: DetectionEvent; cameraName?: string }) {
  const router = useRouter();
  const meta = detectionMeta(event.type);

  const onPress = () => {
    if (event.recordingId) return router.push(`/playback/${event.recordingId}`);
    return router.push(`/camera/${event.cameraId}`);
  };

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Image source={{ uri: event.thumbnailUrl }} style={styles.thumb} />
      <View style={styles.body}>
        <View style={styles.chipRow}>
          <Chip label={meta.label} color={meta.color} icon={meta.icon} />
        </View>
        <Text style={styles.sub}>
          {cameraName ? `${cameraName} · ` : ''}
          {formatRelativeTime(event.timestamp)}
        </Text>
      </View>
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
  body: { flex: 1, gap: 4 },
  chipRow: { flexDirection: 'row' },
  sub: { color: colors.textMuted, fontSize: 13 },
});
