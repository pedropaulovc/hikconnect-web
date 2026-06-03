interface VideoPlayerProps {
  src: string;
  poster?: string;
}

/** Plays a progressive video file (MP4) for recordings playback. */
export function VideoPlayer({ src, poster }: VideoPlayerProps) {
  return (
    <video
      key={src}
      controls
      autoPlay
      playsInline
      poster={poster}
      src={src}
      style={{ width: '100%', aspectRatio: '16 / 9', display: 'block' }}
    />
  );
}
