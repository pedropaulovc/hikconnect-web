import { useLocalSearchParams } from 'expo-router';
import { PlaybackScreen } from '../../src/screens/PlaybackScreen';

export default function PlaybackRoute() {
  const { recordingId } = useLocalSearchParams<{ recordingId: string }>();
  return <PlaybackScreen recordingId={recordingId} />;
}
