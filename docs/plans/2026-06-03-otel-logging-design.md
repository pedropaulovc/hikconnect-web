# OTel Logging for HikConnect Web — Design

**Date:** 2026-06-03
**Status:** Approved
**Origin:** "change send/recv log events to trace level" → "update to use proper OTel telemetry"

## Goal

Replace ad-hoc `console.*` logging in `src/` with proper OpenTelemetry **Logs** telemetry.
Per-packet P2P send/recv events become structured trace-severity log records, hidden by
default and surfaced on demand — preserving the original "send/recv at trace level" intent.

## Decisions (from brainstorming)

| Question | Choice |
|----------|--------|
| Signal | OTel **Logs** at TRACE severity (via `@opentelemetry/api-logs`). No traces/metrics. |
| Scope | Route **all `console.*` in `src/`** through a log facade. |
| Exporter | **OTLP** (when endpoint env set) with **console** fallback for local dev. |
| Init scope | **Both** Next.js server (`instrumentation.ts`) and standalone `tsx` scripts. |
| Scripts' own logs | **Keep `scripts/` `console.log` as-is** (human CLI output). Scripts still call `initTelemetry()` so the library's send/recv OTel events have a provider. |
| Default level | `OTEL_LOG_LEVEL=info` — trace send/recv hidden unless set to `trace`. |

## Architecture

```
Next server  ── instrumentation.ts ─┐
                                     ├─→ initTelemetry() ─→ LoggerProvider ─→ processor ─→ exporter
tsx scripts  ── initTelemetry() ────┘                                         │              │
                                                                   severity   OTLP (endpoint set)
src/ code ── log.{trace,debug,info,warn,error}(body, attrs) ─→ logs.getLogger filter         │
                                                                              └─ Console (fallback)
```

## Components

### 1. Dependencies (new)
`@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, `@opentelemetry/resources`,
`@opentelemetry/semantic-conventions`, `@opentelemetry/exporter-logs-otlp-proto`.

### 2. `src/lib/telemetry/telemetry.ts` — SDK init
- Resource with `service.name = hikconnect-web` (override `OTEL_SERVICE_NAME`).
- `LoggerProvider` with one processor chosen at runtime:
  - OTLP endpoint env present (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`)
    → `BatchLogRecordProcessor(OTLPLogExporter)`.
  - else → `SimpleLogRecordProcessor(ConsoleLogRecordExporter)`.
- Severity filter (`OTEL_LOG_LEVEL`, default `info`) drops records below threshold.
- `logs.setGlobalLoggerProvider(provider)`.
- Idempotent `initTelemetry()`; `shutdownTelemetry()` flushes on `beforeExit` / `SIGTERM`.
- All wrapped so telemetry failures never crash the app.

### 3. `src/lib/telemetry/log.ts` — facade
`log.trace/debug/info/warn/error(body: string, attributes?)` → emits `LogRecord` with the
mapped `SeverityNumber`/`severityText`. Lazily calls `initTelemetry()`. Single import that
replaces `console.*` across `src/`.

### 4. Call-site conversion (`src/` only)
- **send/recv events** (`p2p-session.ts` recv@679, send@1221/1227; `vtm-client.ts`,
  `relay-client.ts` Sent/Recv) → `log.trace('p2p send', { 'net.direction':'send',
  'net.bytes':n, 'p2p.type':'0x..', 'net.peer':'ip:port' })`.
- other `console.log` → `log.info`; `console.warn` → `log.warn`; `console.error` → `log.error`.

### 5. Wiring
- `instrumentation.ts` (repo root): `register()` calls `initTelemetry()` when
  `NEXT_RUNTIME === 'nodejs'`. Next 16 enables the instrumentation hook by default.
- Diagnostic scripts: add `initTelemetry()` near their entry; leave their own `console.log`.

## Error handling
- OTLP exporter failures are swallowed by OTel internals; console fallback always works.
- `initTelemetry()` try/catch → app continues even if telemetry setup throws.

## Testing
- Unit test the facade with `InMemoryLogRecordExporter`: severity mapping + attribute forwarding.
- Confirm existing 239 tests still pass (verify none assert on `console` output before/after conversion).

## Non-goals (YAGNI)
- No tracing spans, no metrics.
- No backwards-compat shim for `console.*` — full replacement in `src/`.
