# OTel Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace all `console.*` logging in `src/` with OpenTelemetry Logs, emitting P2P send/recv events at TRACE severity (hidden by default, surfaced via `OTEL_LOG_LEVEL=trace`).

**Architecture:** A `src/lib/telemetry/` module initializes an OTel `LoggerProvider` (OTLP exporter when an endpoint env is set, console exporter otherwise) and exposes a tiny `log.{trace,debug,info,warn,error}` facade. The facade does severity-threshold filtering itself (no custom processor) and lazily inits the SDK, so both the Next.js server (`instrumentation.ts`) and standalone `tsx` scripts emit telemetry. All `console.*` in `src/` is rewritten to the facade; per-packet send/recv become structured `log.trace` records.

**Tech Stack:** OpenTelemetry Logs SDK (`@opentelemetry/sdk-logs` 0.218, `@opentelemetry/api-logs` 0.218, `@opentelemetry/exporter-logs-otlp-proto` 0.218, `@opentelemetry/resources` 2.7, `@opentelemetry/semantic-conventions` 1.41), Next.js 16, Vitest.

**Design doc:** `docs/plans/2026-06-03-otel-logging-design.md`

---

## API notes (ground truth — current OTel API, 0.218 / core 2.7)

- Resource: `resourceFromAttributes({ [ATTR_SERVICE_NAME]: name })` from `@opentelemetry/resources` (the `Resource` class ctor is deprecated). `ATTR_SERVICE_NAME` from `@opentelemetry/semantic-conventions`.
- Provider: `new LoggerProvider({ resource, processors: [...] })` — pass processors in the constructor (`addLogRecordProcessor` is removed in this line).
- Processors/exporters from `@opentelemetry/sdk-logs`: `BatchLogRecordProcessor`, `SimpleLogRecordProcessor`, `ConsoleLogRecordExporter`, `InMemoryLogRecordExporter`.
- OTLP exporter: `OTLPLogExporter` from `@opentelemetry/exporter-logs-otlp-proto` (auto-reads `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`).
- Global wiring: `logs.setGlobalLoggerProvider(provider)` and `logs.getLogger(name)` from `@opentelemetry/api-logs`. `SeverityNumber` enum also from `@opentelemetry/api-logs`.

---

## Task 1: Add dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install**

Run:
```bash
npm install @opentelemetry/api-logs@0.218.0 @opentelemetry/sdk-logs@0.218.0 \
  @opentelemetry/exporter-logs-otlp-proto@0.218.0 @opentelemetry/resources@2.7.1 \
  @opentelemetry/semantic-conventions@1.41.1
```
Expected: 5 packages added, `package-lock.json` updated.

**Step 2: Verify resolves**

Run: `node -e "require('@opentelemetry/sdk-logs'); require('@opentelemetry/api-logs'); console.log('ok')"`
Expected: `ok`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add OpenTelemetry logs SDK"
```

---

## Task 2: Severity mapping + log facade (TDD)

The facade is pure-ish: it maps a level → `SeverityNumber`, applies the `OTEL_LOG_LEVEL`
threshold, and emits via the global logger. Test it with `InMemoryLogRecordExporter`.

**Files:**
- Create: `src/lib/telemetry/log.ts`
- Create: `src/lib/telemetry/__tests__/log.test.ts`
- Create: `src/lib/telemetry/severity.ts`

**Step 1: Write `src/lib/telemetry/severity.ts`** (shared, no SDK imports — keeps the test fast)

```typescript
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
```

**Step 2: Write the failing test** `src/lib/telemetry/__tests__/log.test.ts`

```typescript
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
```

**Step 3: Run to verify it fails**

Run: `npm test -- --run src/lib/telemetry/__tests__/log.test.ts`
Expected: FAIL — cannot find module `../log`.

**Step 4: Write `src/lib/telemetry/log.ts`**

```typescript
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
```

> Note: the test installs its own global provider, so `ensureTelemetry()` must be a no-op
> when a provider is already set (Task 3 handles idempotency + the test-env guard).

**Step 5: Run to verify pass**

Run: `npm test -- --run src/lib/telemetry/__tests__/log.test.ts`
Expected: PASS (3 tests).

**Step 6: Commit**

```bash
git add src/lib/telemetry/severity.ts src/lib/telemetry/log.ts src/lib/telemetry/__tests__/log.test.ts
git commit -m "feat(telemetry): add OTel log facade with severity filtering"
```

---

## Task 3: SDK init module

**Files:**
- Create: `src/lib/telemetry/telemetry.ts`
- Create: `src/lib/telemetry/__tests__/telemetry.test.ts`

**Step 1: Write the failing test** `src/lib/telemetry/__tests__/telemetry.test.ts`

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logs } from '@opentelemetry/api-logs'

afterEach(() => { vi.resetModules(); vi.unstubAllEnvs() })

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
```

**Step 2: Run to verify it fails**

Run: `npm test -- --run src/lib/telemetry/__tests__/telemetry.test.ts`
Expected: FAIL — cannot find module `../telemetry`.

**Step 3: Write `src/lib/telemetry/telemetry.ts`**

```typescript
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
    const flush = () => { void provider?.shutdown() }
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
```

**Step 4: Run to verify pass**

Run: `npm test -- --run src/lib/telemetry/__tests__/telemetry.test.ts`
Expected: PASS (2 tests).

**Step 5: Re-run the facade test (now that `telemetry.ts` exists)**

Run: `npm test -- --run src/lib/telemetry/`
Expected: PASS (5 tests total).

**Step 6: Commit**

```bash
git add src/lib/telemetry/telemetry.ts src/lib/telemetry/__tests__/telemetry.test.ts
git commit -m "feat(telemetry): add OTLP/console LoggerProvider init"
```

---

## Task 4: Next.js instrumentation hook

**Files:**
- Create: `instrumentation.ts` (repo root)

**Step 1: Write `instrumentation.ts`**

```typescript
// Next.js calls register() once on server boot (instrumentation hook is on by default in Next 16).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureTelemetry } = await import('./src/lib/telemetry/telemetry')
    ensureTelemetry()
  }
}
```

**Step 2: Verify the build picks it up**

Run: `npm run build 2>&1 | grep -iE "instrumentation|error" | head`
Expected: no errors; build completes.

**Step 3: Commit**

```bash
git add instrumentation.ts
git commit -m "feat(telemetry): init OTel from Next instrumentation hook"
```

---

## Task 5: Convert `p2p-session.ts` (send/recv → trace, rest → info)

**Files:**
- Modify: `src/lib/p2p/p2p-session.ts`

The three generic per-packet I/O lines become structured `log.trace`; all other
`console.log` → `log.info`, `console.warn` → `log.warn`, `console.error` → `log.error`.

**Step 1: Add the import** at the top of `src/lib/p2p/p2p-session.ts`:

```typescript
import { log } from '../telemetry/log'
```

**Step 2: Convert the send/recv events.** Replace the three per-packet lines:

`recv` (≈ line 679) — was:
```typescript
console.log(`[P2P] recv ${buf.length}B from ${_fromAddr}:${_fromPort} type=0x${buf.length >= 2 ? buf.readUInt16BE(0).toString(16) : '??'}`)
```
becomes:
```typescript
log.trace('p2p recv', {
  'net.direction': 'recv',
  'net.bytes': buf.length,
  'net.peer': `${_fromAddr}:${_fromPort}`,
  'p2p.type': buf.length >= 2 ? `0x${buf.readUInt16BE(0).toString(16)}` : 'unknown',
})
```

`send` to `ip:port` (≈ line 1221) — was:
```typescript
console.log(`[P2P] send ${data.length}B to ${ip}:${port} type=0x${data.length >= 2 ? data.readUInt16BE(0).toString(16) : '??'}`)
```
becomes:
```typescript
log.trace('p2p send', {
  'net.direction': 'send',
  'net.bytes': data.length,
  'net.peer': `${ip}:${port}`,
  'p2p.type': data.length >= 2 ? `0x${data.readUInt16BE(0).toString(16)}` : 'unknown',
})
```

`send` to `host:port` (≈ line 1227) — was:
```typescript
console.log(`[P2P] send ${data.length}B to ${host}:${port}`)
```
becomes:
```typescript
log.trace('p2p send', {
  'net.direction': 'send',
  'net.bytes': data.length,
  'net.peer': `${host}:${port}`,
})
```

**Step 3: Convert remaining milestone logs.** For every other `console.log('[P2P] ...')` /
`console.log('[SRT] ...')` in this file, rewrite as `log.info('<message>')` — drop the
backtick template into the body unchanged (keep the existing interpolation). Example:

```typescript
console.log('[P2P] P2P_SETUP sent, waiting for device punch (0x0C00)...')
// →
log.info('[P2P] P2P_SETUP sent, waiting for device punch (0x0C00)...')
```

Convert any `console.warn` → `log.warn`, `console.error` → `log.error` the same way.

**Step 4: Verify none left**

Run: `grep -nE "console\.(log|warn|error)" src/lib/p2p/p2p-session.ts`
Expected: no output.

**Step 5: Typecheck + tests**

Run: `npm run typecheck && npm test -- --run src/lib/p2p/__tests__/`
Expected: typecheck clean (ignore `scripts/test-e2e-stream.ts`); p2p tests pass.

**Step 6: Commit**

```bash
git add src/lib/p2p/p2p-session.ts
git commit -m "refactor(p2p): route p2p-session logs through OTel, send/recv at trace"
```

---

## Task 6: Convert `vtm-client.ts` and `relay-client.ts`

**Files:**
- Modify: `src/lib/p2p/vtm-client.ts`
- Modify: `src/lib/p2p/relay-client.ts`

**Step 1: Add `import { log } from '../telemetry/log'` to each.**

**Step 2: Convert the Sent/Recv lines to `log.trace`.** e.g. `vtm-client.ts:215`:
```typescript
console.log(`[VTM] Recv frame type=${frame.msgType} subType=${frame.subType} len=${frame.payload.length}`)
// →
log.trace('vtm recv', {
  'net.direction': 'recv',
  'net.bytes': frame.payload.length,
  'vtm.msgType': frame.msgType,
  'vtm.subType': frame.subType,
})
```
And the `[VTM] Sent ...` / `[Relay] Sent ...` lines → `log.trace('vtm send' | 'relay send', { 'net.direction':'send', 'net.bytes': <payloadLen>, ... })`, carrying the salient fields (serial, body length) as attributes.

**Step 3: Convert all other `console.*`** in both files → `log.info/warn/error`.

**Step 4: Verify none left**

Run: `grep -nE "console\.(log|warn|error)" src/lib/p2p/vtm-client.ts src/lib/p2p/relay-client.ts`
Expected: no output.

**Step 5: Typecheck + tests**

Run: `npm run typecheck && npm test -- --run src/lib/p2p/__tests__/`
Expected: pass.

**Step 6: Commit**

```bash
git add src/lib/p2p/vtm-client.ts src/lib/p2p/relay-client.ts
git commit -m "refactor(p2p): route vtm/relay logs through OTel, send/recv at trace"
```

---

## Task 7: Convert remaining `src/` files

**Files:**
- Modify: `src/lib/p2p/hik-rtp.ts`
- Modify: `src/lib/hls/ffmpeg-pipe.ts`
- Modify: `src/lib/hls/ffmpeg-mp4-pipe.ts`
- Modify: `src/lib/utils/public-ip.ts`

These have no per-packet send/recv I/O — straight `console.log → log.info`,
`console.warn → log.warn`, `console.error → log.error`. Add
`import { log } from '...'` with the correct relative path per file
(`'../telemetry/log'` for `p2p`/`hls`/`utils` since each is one dir under `lib/`).

**Step 1: Convert each file** (preserve message bodies verbatim).

**Step 2: Verify no `console.*` remains in `src/` (excluding tests + the telemetry init's own fallback)**

Run:
```bash
grep -rnE "console\.(log|warn|error)" src --include="*.ts" \
  | grep -vE "__tests__|\.test\.ts" | grep -v "src/lib/telemetry/telemetry.ts"
```
Expected: no output. (The one allowed `console.error` is the telemetry init-failure fallback in `telemetry.ts`.)

**Step 3: Typecheck + full test suite**

Run: `npm run typecheck && npm test -- --run`
Expected: typecheck clean; all 239+ tests pass (5 new telemetry tests added).

**Step 4: Commit**

```bash
git add src/lib/p2p/hik-rtp.ts src/lib/hls/ffmpeg-pipe.ts src/lib/hls/ffmpeg-mp4-pipe.ts src/lib/utils/public-ip.ts
git commit -m "refactor: route remaining src logging through OTel"
```

---

## Task 8: Init telemetry in diagnostic scripts

Scripts keep their own human-readable `console.log`, but must call `ensureTelemetry()`
so the library's now-OTel send/recv events have a provider when a script drives a P2P session.

**Files:**
- Modify: scripts that construct a `P2PSession` / call into `src/lib/p2p`:
  `scripts/diag-source-resolution.ts`, `scripts/diag-srt-reorder.ts`, `scripts/diag-srt.ts`,
  `scripts/diag-srt-trace.ts`, `scripts/diag-stream-reliability.ts`,
  `scripts/test-p2p-to-ffmpeg.ts`, `scripts/test-playback-ps.ts`, `scripts/test-p2p-dynamic.ts`
  (verify the actual set via the grep in Step 1).

**Step 1: Identify the scripts**

Run: `grep -rln "p2p-session\|live-stream\|new P2PSession" scripts/*.ts`

**Step 2: In each, near the top after imports, add:**

```typescript
import { ensureTelemetry } from '../src/lib/telemetry/telemetry'
ensureTelemetry()
```

(These scripts default to `OTEL_LOG_LEVEL=info`, so send/recv stays quiet unless the
operator runs e.g. `OTEL_LOG_LEVEL=trace npx tsx scripts/diag-srt-trace.ts`.)

**Step 3: Smoke-test one script compiles/loads**

Run: `npx tsx --eval "import('./src/lib/telemetry/telemetry').then(m => { m.ensureTelemetry(); console.log('init ok') })"`
Expected: `init ok` (console exporter, no endpoint set).

**Step 4: Commit**

```bash
git add scripts/
git commit -m "chore(scripts): init OTel telemetry in P2P diagnostic scripts"
```

---

## Task 9: Final verification + docs

**Files:**
- Modify: `CLAUDE.md` (Tech Stack + a short "Logging" note)
- Modify: `.env.local` example block in `CLAUDE.md` (add `OTEL_*` vars)

**Step 1: Update `CLAUDE.md`**
- Tech Stack line: note logging is OpenTelemetry Logs (OTLP w/ console fallback).
- Add an env note: `OTEL_EXPORTER_OTLP_ENDPOINT` (optional, enables OTLP),
  `OTEL_LOG_LEVEL` (default `info`; set `trace` to see per-packet P2P send/recv),
  `OTEL_SERVICE_NAME` (default `hikconnect-web`).

**Step 2: Full gate**

Run: `npm run typecheck && npm run lint && npm test -- --run && npm run build`
Expected: all green. Note the existing known-ignored `scripts/test-e2e-stream.ts` typecheck errors per CLAUDE.md.

**Step 3: Manual trace check** (optional, proves end-to-end)

Run: `OTEL_LOG_LEVEL=trace npx tsx scripts/diag-srt-trace.ts 5 2>&1 | grep -iE "p2p (send|recv)" | head`
Expected: structured TRACE records for send/recv printed by the console exporter.

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document OTel logging + OTEL_* env vars"
```

---

## Done criteria
- No `console.*` in `src/` except the single init-failure fallback in `telemetry.ts`.
- `npm test -- --run` green (239+ existing, 5 new telemetry tests).
- `npm run typecheck`, `npm run lint`, `npm run build` green.
- `OTEL_LOG_LEVEL=trace` surfaces structured `p2p send` / `p2p recv` TRACE records; default `info` hides them.
- OTLP used when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; console exporter otherwise.
