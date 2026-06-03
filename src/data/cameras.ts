import type { Camera } from './types';

// Public HLS test streams used as stand-in "live" footage for the demo.
const MUX_TEST = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const APPLE_BIPBOP =
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8';
const MUX_LL = 'https://test-streams.mux.dev/pts_shift/master.m3u8';

const poster = (id: string) => `https://picsum.photos/seed/${id}/640/360`;

export const cameras: Camera[] = [
  {
    id: 'front-door',
    name: 'Front Door',
    location: 'Entrance',
    status: 'online',
    posterUrl: poster('front-door'),
    liveStreamUrl: MUX_TEST,
  },
  {
    id: 'lobby',
    name: 'Lobby',
    location: 'Ground Floor',
    status: 'online',
    posterUrl: poster('lobby'),
    liveStreamUrl: APPLE_BIPBOP,
  },
  {
    id: 'parking-lot',
    name: 'Parking Lot',
    location: 'Exterior',
    status: 'online',
    posterUrl: poster('parking-lot'),
    liveStreamUrl: MUX_LL,
  },
  {
    id: 'backyard',
    name: 'Backyard',
    location: 'Rear',
    status: 'offline',
    posterUrl: poster('backyard'),
    liveStreamUrl: MUX_TEST,
  },
];
