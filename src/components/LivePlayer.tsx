import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

interface LivePlayerProps {
  src: string;
  poster?: string;
  /** Show native video controls. Off for wall tiles, on for the focused view. */
  controls?: boolean;
  /** object-fit for the video element. 'cover' fills a tile; 'contain' letterboxes. */
  fit?: 'cover' | 'contain';
}

/**
 * Plays an HLS (.m3u8) stream. Uses the browser's native HLS support when
 * available (Safari/iOS), otherwise falls back to hls.js (Chrome/Firefox).
 */
export function LivePlayer({ src, poster, controls = true, fit = 'contain' }: LivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return;
    }

    if (!Hls.isSupported()) {
      video.src = src; // last resort — most browsers won't play it, but no crash
      return;
    }

    const hls = new Hls();
    hls.loadSource(src);
    hls.attachMedia(video);
    return () => hls.destroy();
  }, [src]);

  return (
    <video
      ref={videoRef}
      controls={controls}
      autoPlay
      muted
      playsInline
      poster={poster}
      style={{
        width: '100%',
        height: '100%',
        objectFit: fit,
        display: 'block',
        background: '#000',
      }}
    />
  );
}
