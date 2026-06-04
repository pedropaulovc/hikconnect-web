import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../src/theme/colors';

export default function NotFoundRoute() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>This screen doesn't exist.</Text>
      <Link href="/" style={styles.link}>
        Go to the camera wall
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  text: { color: colors.textMuted, fontSize: 16 },
  link: { color: colors.primary, fontWeight: '600' },
});
