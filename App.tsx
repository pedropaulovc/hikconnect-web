import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { NavProvider } from './src/navigation/router';
import { AppShell } from './src/AppShell';
import { colors } from './src/theme/colors';

export default function App() {
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <NavProvider>
        <AppShell />
      </NavProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
