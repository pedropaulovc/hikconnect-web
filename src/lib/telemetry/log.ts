import { logs, type LogAttributes } from '@opentelemetry/api-logs'
import { SEVERITY, thresholdRank, type LogLevel } from './severity'
import { ensureTelemetry } from './telemetry'

function emit(level: LogLevel, body: string, attributes?: LogAttributes): void {
  if (SEVERITY[level].rank < thresholdRank()) return
  ensureTelemetry()
  logs.getLogger('hikconnect-web').emit({
    severityNumber: SEVERITY[level].number,
    severityText: SEVERITY[level].text,
    body,
    attributes,
  })
}

export const log = {
  trace: (body: string, attributes?: LogAttributes) => emit('trace', body, attributes),
  debug: (body: string, attributes?: LogAttributes) => emit('debug', body, attributes),
  info: (body: string, attributes?: LogAttributes) => emit('info', body, attributes),
  warn: (body: string, attributes?: LogAttributes) => emit('warn', body, attributes),
  error: (body: string, attributes?: LogAttributes) => emit('error', body, attributes),
}
