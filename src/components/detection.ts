import type { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import type { DetectionType } from '../data/types';
import { colors } from '../theme/colors';

type IconName = ComponentProps<typeof Ionicons>['name'];

interface DetectionMeta {
  label: string;
  icon: IconName;
  color: string;
}

const META: Record<DetectionType, DetectionMeta> = {
  person: { label: 'Person', icon: 'walk', color: colors.primary },
  vehicle: { label: 'Vehicle', icon: 'car-sport', color: colors.warning },
  motion: { label: 'Motion', icon: 'pulse', color: colors.medium },
  animal: { label: 'Animal', icon: 'paw', color: colors.success },
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

/** Short local time label, e.g. "08:12 AM". */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Long day label, e.g. "Wednesday, Jun 3". */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
