import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Slot, usePathname, useGlobalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../src/theme/colors';
import { Sidebar } from '../src/components/Sidebar';
import { cameraById, recordingById } from '../src/data';

/** Title for the custom header, derived from the active URL + params. */
function titleFor(pathname: string, params: Record<string, string | string[]>): string {
  if (pathname.startsWith('/camera/')) {
    return cameraById(String(params.cameraId))?.name ?? 'Camera';
  }
  if (pathname.startsWith('/playback/')) {
    const rec = recordingById(String(params.recordingId));
    return rec ? cameraById(rec.cameraId)?.name ?? 'Playback' : 'Playback';
  }
  if (pathname.startsWith('/recordings')) return 'Recordings';
  if (pathname.startsWith('/events')) return 'Events';
  return 'Camera Wall';
}

/**
 * NVR shell shared by every route: persistent sidebar (desktop) / hamburger
 * drawer (mobile) + a custom header, wrapping the active screen via <Slot />.
 * Expo Router owns the route stack, so URLs, deep links and browser
 * back/forward all work — this layout just renders the chrome around them.
 */
export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const [menuOpen, setMenuOpen] = useState(false);

  const isDetail = pathname.startsWith('/camera/') || pathname.startsWith('/playback/');
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.row}>
        {wide && <Sidebar />}

        <View style={styles.main}>
          <View style={styles.header}>
            {isDetail ? (
              <Pressable style={styles.iconBtn} onPress={goBack}>
                <Ionicons name="arrow-back" size={22} color={colors.text} />
              </Pressable>
            ) : !wide ? (
              <Pressable style={styles.iconBtn} onPress={() => setMenuOpen(true)}>
                <Ionicons name="menu" size={24} color={colors.text} />
              </Pressable>
            ) : null}
            <Text style={styles.title}>{titleFor(pathname, params)}</Text>
          </View>
          <View style={styles.body}>
            <Slot />
          </View>
        </View>
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
  root: { flex: 1, backgroundColor: colors.bg },
  row: { flex: 1, flexDirection: 'row' },
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
