import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// Mock hls.js so the component never touches the network in tests.
vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported() {
      return true;
    }
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
  }
  return { default: FakeHls };
});

import { LivePlayer } from './LivePlayer';

describe('LivePlayer', () => {
  it('renders a video element with the poster', () => {
    const { container } = render(
      <LivePlayer src="https://example.com/stream.m3u8" poster="poster.jpg" />,
    );
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute('poster', 'poster.jpg');
  });
});
