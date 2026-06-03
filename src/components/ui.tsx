import { Ionicons } from '@expo/vector-icons';
import { type ComponentProps, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/colors';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function Chip({ label, color, icon }: { label: string; color: string; icon?: IconName }) {
  return (
    <View style={[styles.chip, { backgroundColor: color + '22', borderColor: color + '55' }]}>
      {icon && <Ionicons name={icon} size={13} color={color} />}
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

export function StatusDot({ online }: { online: boolean }) {
  return (
    <View
      style={[
        styles.dot,
        { backgroundColor: online ? colors.success : colors.medium },
        online && styles.dotGlow,
      ]}
    />
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionText}>{title}</Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
  },
  chipText: { fontSize: 12, fontWeight: '600' },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, alignSelf: 'flex-start' },
  badgeText: { color: '#08110a', fontSize: 12, fontWeight: '700' },
  dot: { width: 9, height: 9, borderRadius: 5 },
  dotGlow: {
    shadowColor: colors.success,
    shadowOpacity: 0.9,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  sectionText: { color: colors.textMuted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
});
