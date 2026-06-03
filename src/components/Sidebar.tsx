import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { useNav, type Route } from '../navigation/router';

const NAV = [
  { key: 'wall', label: 'Cameras', icon: 'videocam', group: ['wall', 'cameraDetail'] },
  { key: 'recordings', label: 'Recordings', icon: 'film', group: ['recordings', 'playback'] },
  { key: 'events', label: 'Events', icon: 'notifications', group: ['events'] },
] as const;

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const nav = useNav();
  const current = nav.route.name;

  return (
    <View style={styles.sidebar}>
      <Text style={styles.brand}>CCTV Demo</Text>
      <Text style={styles.sectionLabel}>MONITORING</Text>
      {NAV.map((item) => {
        const active = (item.group as readonly string[]).includes(current);
        return (
          <Pressable
            key={item.key}
            style={[styles.item, active && styles.itemActive]}
            onPress={() => {
              nav.replaceRoot({ name: item.key } as Route);
              onNavigate?.();
            }}
          >
            <Ionicons name={item.icon} size={20} color={active ? '#fff' : colors.textMuted} />
            <Text style={[styles.itemText, active && styles.itemTextActive]}>{item.label}</Text>
          </Pressable>
        );
      })}
      <View style={{ flex: 1 }} />
      <Text style={styles.note}>Demo data · public sample streams</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    width: 240,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderColor: colors.border,
    paddingTop: 18,
    height: '100%',
  },
  brand: { color: colors.text, fontSize: 20, fontWeight: '700', paddingHorizontal: 16, marginBottom: 18 },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 13 },
  itemActive: { backgroundColor: colors.primary },
  itemText: { color: colors.textMuted, fontSize: 16, fontWeight: '500' },
  itemTextActive: { color: '#fff' },
  note: { color: colors.textMuted, fontSize: 12, padding: 16 },
});
