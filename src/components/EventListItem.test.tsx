import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EventListItem } from './EventListItem';
import type { DetectionEvent } from '../data/types';

const event: DetectionEvent = {
  id: 'evt-x',
  cameraId: 'front-door',
  type: 'vehicle',
  timestamp: '2026-06-03T08:12:04',
  thumbnailUrl: 'thumb.jpg',
  recordingId: 'rec-001',
};

describe('EventListItem', () => {
  it('renders the detection type label', () => {
    render(
      <MemoryRouter>
        <EventListItem event={event} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Vehicle')).toBeInTheDocument();
  });

  it('shows the camera name when asked', () => {
    render(
      <MemoryRouter>
        <EventListItem event={event} cameraName="Front Door" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Front Door/)).toBeInTheDocument();
  });
});
