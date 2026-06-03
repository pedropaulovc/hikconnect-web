import { useState } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { CameraTile } from '../components/CameraTile';
import { cameras, eventsForCamera } from '../data';

const GAP = 16;
const MIN_TILE = 360;

export function CamerasWallScreen() {
  const [width, setWidth] = useState(0);
  const cols = width > 0 ? Math.max(1, Math.floor((width + GAP) / (MIN_TILE + GAP))) : 1;
  const tileWidth = cols > 0 ? (width - GAP * (cols - 1)) / cols : width;

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.grid} onLayout={onLayout}>
        {cameras.map((camera) => (
          <View key={camera.id} style={{ width: width > 0 ? tileWidth : '100%' }}>
            <CameraTile camera={camera} lastEvent={eventsForCamera(camera.id)[0]} />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: GAP, maxWidth: 1600, width: '100%', alignSelf: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
});
