import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CameraCard } from './CameraCard';
import type { Camera } from '../data/types';

const camera: Camera = {
  id: 'lobby',
  name: 'Lobby',
  location: 'Ground Floor',
  status: 'offline',
  posterUrl: 'poster.jpg',
  liveStreamUrl: 'stream.m3u8',
};

describe('CameraCard', () => {
  it('renders the camera name and status', () => {
    render(
      <MemoryRouter>
        <CameraCard camera={camera} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Lobby')).toBeInTheDocument();
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });
});
