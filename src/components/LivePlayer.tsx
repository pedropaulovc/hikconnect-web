import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

interface LivePlayerProps {
  src: string;
  poster?: string;
  controls?: boolean;
  fit?: 'cover' | 'contain';
}

/**
 * HLS live player. This is a web-target component: on react-native-web the
 * renderer is react-dom, so a real <video> element works and hls.js can drive
 * it. (A native build would swap this for expo-video.)
 */
export function LivePlayer({ src, poster, controls = false, fit = 'cover' }: LivePlayerProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return;
    }
    if (!Hls.isSupported()) {
      video.src = src;
      return;
    }

    const hls = new Hls();
    hls.loadSource(src);
    hls.attachMedia(video);
    return () => hls.destroy();
  }, [src]);

  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      controls={controls}
      poster={poster}
      style={{ width: '100%', height: '100%', objectFit: fit, display: 'block', backgroundColor: '#000' }}
    />
  );
}
