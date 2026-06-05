export type StatusKind = 'ok' | 'degraded' | 'down';

const LABELS: Record<StatusKind, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Offline',
};

const COLORS: Record<StatusKind, string> = {
  ok: '#16a34a',
  degraded: '#d97706',
  down: '#dc2626',
};

export function StatusBadge({ status }: { status: StatusKind }) {
  return (
    <span
      role="status"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.25rem 0.75rem',
        borderRadius: '9999px',
        background: COLORS[status],
        color: '#fff',
        fontSize: '0.875rem',
        fontWeight: 600,
      }}
    >
      {LABELS[status]}
    </span>
  );
}
