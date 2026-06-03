import { walk, carSport, pulse, paw } from 'ionicons/icons';
import type { DetectionType } from '../data/types';

interface DetectionMeta {
  label: string;
  icon: string;
  color: string; // Ionic color name
}

const META: Record<DetectionType, DetectionMeta> = {
  person: { label: 'Person', icon: walk, color: 'primary' },
  vehicle: { label: 'Vehicle', icon: carSport, color: 'warning' },
  motion: { label: 'Motion', icon: pulse, color: 'medium' },
  animal: { label: 'Animal', icon: paw, color: 'success' },
};

export function detectionMeta(type: DetectionType): DetectionMeta {
  return META[type];
}

/** Human-friendly relative time, e.g. "5 min ago", "2 h ago", "3 d ago". */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, Math.round((now.getTime() - then) / 1000));

  if (diffSec < 60) return 'just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/** Short local time label, e.g. "08:12". */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
