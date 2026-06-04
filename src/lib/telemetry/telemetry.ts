import { logs } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordProcessor,
} from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'

let provider: LoggerProvider | null = null

function hasOtlpEndpoint(): boolean {
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  )
}

function buildProcessor(): LogRecordProcessor {
  if (hasOtlpEndpoint()) return new BatchLogRecordProcessor(new OTLPLogExporter())
  return new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
}

/** Initialize the OTel LoggerProvider once. Safe to call from any entry point. */
export function ensureTelemetry(): void {
  if (provider) return
  // In tests we never install a real exporter — the facade emits to whatever
  // (no-op) global provider the test set up. Keeps the suite silent + fast.
  if (process.env.VITEST) return
  try {
    provider = new LoggerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'hikconnect-web',
      }),
      processors: [buildProcessor()],
    })
    logs.setGlobalLoggerProvider(provider)
    const flush = () => {
      void provider?.shutdown()
    }
    process.once('beforeExit', flush)
    process.once('SIGTERM', flush)
  } catch (err) {
    // Telemetry must never crash the app.
    console.error('[telemetry] init failed, logs disabled:', err)
  }
}

/** Flush + shut down telemetry (call from script teardown if desired). */
export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown()
  provider = null
}
