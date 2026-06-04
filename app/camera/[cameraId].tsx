import { useLocalSearchParams } from 'expo-router';
import { CameraDetailScreen } from '../../src/screens/CameraDetailScreen';

export default function CameraDetailRoute() {
  const { cameraId } = useLocalSearchParams<{ cameraId: string }>();
  return <CameraDetailScreen cameraId={cameraId} />;
}
