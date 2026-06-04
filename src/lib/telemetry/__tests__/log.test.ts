import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { logs } from '@opentelemetry/api-logs'

// Facade reads the global provider; install an in-memory one per test.
let exporter: InMemoryLogRecordExporter
let provider: LoggerProvider

beforeEach(() => {
  vi.resetModules()
  exporter = new InMemoryLogRecordExporter()
  provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] })
  logs.disable()
  logs.setGlobalLoggerProvider(provider)
})

afterEach(async () => {
  delete process.env.OTEL_LOG_LEVEL
  await provider.shutdown()
})

describe('log facade', () => {
  it('emits info as an INFO-severity record with attributes', async () => {
    process.env.OTEL_LOG_LEVEL = 'trace' // emit everything
    const { log } = await import('../log')
    log.info('hello', { foo: 'bar' })
    const recs = exporter.getFinishedLogRecords()
    expect(recs).toHaveLength(1)
    expect(recs[0].body).toBe('hello')
    expect(recs[0].severityText).toBe('INFO')
    expect(recs[0].attributes).toMatchObject({ foo: 'bar' })
  })

  it('maps trace send/recv to TRACE severity', async () => {
    process.env.OTEL_LOG_LEVEL = 'trace'
    const { log } = await import('../log')
    log.trace('p2p send', { 'net.direction': 'send', 'net.bytes': 12 })
    const recs = exporter.getFinishedLogRecords()
    expect(recs[0].severityText).toBe('TRACE')
    expect(recs[0].attributes).toMatchObject({ 'net.direction': 'send', 'net.bytes': 12 })
  })

  it('drops records below OTEL_LOG_LEVEL (default info → trace dropped)', async () => {
    const { log } = await import('../log')
    log.trace('hidden')
    log.info('shown')
    const recs = exporter.getFinishedLogRecords()
    expect(recs).toHaveLength(1)
    expect(recs[0].body).toBe('shown')
  })
})
