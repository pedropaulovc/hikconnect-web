import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Camera, DetectionEvent } from '../data/types';

// Avoid any real HLS/network in tests.
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

import { CameraTile } from './CameraTile';

const onlineCamera: Camera = {
  id: 'lobby',
  name: 'Lobby',
  location: 'Ground Floor',
  status: 'online',
  posterUrl: 'poster.jpg',
  liveStreamUrl: 'stream.m3u8',
};

const offlineCamera: Camera = { ...onlineCamera, id: 'backyard', name: 'Backyard', status: 'offline' };

describe('CameraTile', () => {
  it('renders the camera name and a live video when online', () => {
    const { container } = render(
      <MemoryRouter>
        <CameraTile camera={onlineCamera} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Lobby')).toBeInTheDocument();
    expect(container.querySelector('video')).toBeInTheDocument();
  });

  it('shows an offline state (no video) when offline', () => {
    const { container } = render(
      <MemoryRouter>
        <CameraTile camera={offlineCamera} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
  });

  it('shows the last event time when provided', () => {
    const event: DetectionEvent = {
      id: 'e1',
      cameraId: 'lobby',
      type: 'person',
      timestamp: '2026-06-03T08:00:00',
      thumbnailUrl: 't.jpg',
    };
    render(
      <MemoryRouter>
        <CameraTile camera={onlineCamera} lastEvent={event} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/ago|just now/)).toBeInTheDocument();
  });
});
