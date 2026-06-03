interface VideoPlayerProps {
  src: string;
  poster?: string;
}

/** Progressive (MP4) player for recordings playback. Web-target (react-dom <video>). */
export function VideoPlayer({ src, poster }: VideoPlayerProps) {
  return (
    <video
      key={src}
      controls
      autoPlay
      playsInline
      poster={poster}
      src={src}
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', backgroundColor: '#000' }}
    />
  );
}
