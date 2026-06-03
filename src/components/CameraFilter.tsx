import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { cameras } from '../data';
import { colors } from '../theme/colors';

export function CameraFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const options = [{ id: 'all', name: 'All cameras' }, ...cameras.map((c) => ({ id: c.id, name: c.name }))];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.bar}
      style={styles.scroll}
    >
      {options.map((o) => {
        const active = value === o.id;
        return (
          <Pressable
            key={o.id}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onChange(o.id)}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{o.name}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, borderBottomWidth: 1, borderColor: colors.border },
  bar: { gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.textMuted, fontSize: 14, fontWeight: '500' },
  chipTextActive: { color: '#fff' },
});
