import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { allRecordingsNewestFirst, cameraById } from '../data';
import type { Recording } from '../data/types';
import { CameraFilter } from '../components/CameraFilter';
import { RecordingListItem } from '../components/RecordingListItem';
import { SectionHeader } from '../components/ui';
import { formatDay } from '../components/detection';

export function RecordingsScreen() {
  const [filter, setFilter] = useState('all');

  const recordings = allRecordingsNewestFirst().filter(
    (r) => filter === 'all' || r.cameraId === filter,
  );

  const groups = new Map<string, Recording[]>();
  for (const r of recordings) {
    const key = r.start.slice(0, 10);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  return (
    <View style={styles.page}>
      <CameraFilter value={filter} onChange={setFilter} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {[...groups.entries()].map(([day, items]) => (
          <View key={day}>
            <SectionHeader title={formatDay(items[0].start)} />
            {items.map((recording) => (
              <RecordingListItem
                key={recording.id}
                recording={recording}
                cameraName={cameraById(recording.cameraId)?.name}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { flex: 1 },
  content: { maxWidth: 900, width: '100%', alignSelf: 'center', paddingBottom: 24 },
});
