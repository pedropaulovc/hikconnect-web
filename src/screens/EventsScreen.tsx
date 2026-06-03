import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { allEventsNewestFirst, cameraById } from '../data';
import { CameraFilter } from '../components/CameraFilter';
import { EventListItem } from '../components/EventListItem';

export function EventsScreen() {
  const [filter, setFilter] = useState('all');

  const events = allEventsNewestFirst().filter((e) => filter === 'all' || e.cameraId === filter);

  return (
    <View style={styles.page}>
      <CameraFilter value={filter} onChange={setFilter} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {events.map((event) => (
          <EventListItem key={event.id} event={event} cameraName={cameraById(event.cameraId)?.name} />
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
