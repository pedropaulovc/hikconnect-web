// Next.js calls register() once on server boot (instrumentation hook is on by default in Next 16).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureTelemetry } = await import('@/lib/telemetry/telemetry')
    ensureTelemetry()
  }
}
