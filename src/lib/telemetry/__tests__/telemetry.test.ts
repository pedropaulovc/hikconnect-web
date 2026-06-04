import { afterEach, describe, expect, it, vi } from 'vitest'
import { logs } from '@opentelemetry/api-logs'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

describe('ensureTelemetry', () => {
  it('is idempotent and registers a global logger provider', async () => {
    vi.stubEnv('VITEST', '') // allow real init in this one test
    const { ensureTelemetry } = await import('../telemetry')
    ensureTelemetry()
    const first = logs.getLoggerProvider()
    ensureTelemetry()
    expect(logs.getLoggerProvider()).toBe(first)
  })

  it('does nothing in the vitest env guard (leaves global no-op provider)', async () => {
    vi.stubEnv('VITEST', 'true')
    logs.disable()
    const before = logs.getLoggerProvider()
    const { ensureTelemetry } = await import('../telemetry')
    ensureTelemetry()
    expect(logs.getLoggerProvider()).toBe(before) // unchanged → no real SDK installed
  })
})
