import { SeverityNumber } from '@opentelemetry/api-logs'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export const SEVERITY: Record<LogLevel, { number: SeverityNumber; text: string; rank: number }> = {
  trace: { number: SeverityNumber.TRACE, text: 'TRACE', rank: 1 },
  debug: { number: SeverityNumber.DEBUG, text: 'DEBUG', rank: 2 },
  info: { number: SeverityNumber.INFO, text: 'INFO', rank: 3 },
  warn: { number: SeverityNumber.WARN, text: 'WARN', rank: 4 },
  error: { number: SeverityNumber.ERROR, text: 'ERROR', rank: 5 },
}

// Records below this rank are dropped. Default: info.
export function thresholdRank(): number {
  const env = (process.env.OTEL_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel
  return (SEVERITY[env] ?? SEVERITY.info).rank
}
