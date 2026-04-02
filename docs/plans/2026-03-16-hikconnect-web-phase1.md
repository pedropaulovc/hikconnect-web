# Phase 1: Hik-Connect REST API Client — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build a typed Hik-Connect REST API client that authenticates, lists devices/cameras, and fetches stream session parameters (VTM info, stream tickets, relay server configs).

**Architecture:** Server-side TypeScript module using native `fetch`. Exposes Next.js API routes that proxy to Hik-Connect cloud. Session managed server-side to avoid leaking credentials to the browser. No external HTTP libraries.

**Tech Stack:** TypeScript, Next.js 16 API routes, Vitest, Node.js 25 native crypto (for MD5 password hashing)

---

## High-Level Spec

> From [design document](./2026-03-16-hikconnect-web-streaming-design.md)

Phase 1 implements Stack A (EZVIZ/Legacy API):
- Base URL: `https://api.hik-connect.com`
- Auth: `POST /v3/users/login/v2` with `account` + `password` (MD5-hashed) → `sessionId`
- Session refresh: `PUT /v3/apigateway/login` with `refreshSessionId`
- Device list: `GET /v3/userdevices/v1/resources/pagelist`
- Camera info: `GET /v3/userdevices/v1/cameras/info?deviceSerial={serial}`
- Stream ticket: `GET /v3/streaming/ticket/{serial}/{channel}`
- VTM info: `GET /v3/streaming/vtm/{serial}/{channel}`
- Relay server: `GET /v3/streaming/query/{type}/{serial}/{channel}`
- Recording list: `GET /v3/streaming/records?deviceSerial=...&startTime=...&stopTime=...`
- All requests include headers: `sessionId`, `clientType: 55`, `featureCode: deadbeef`

---

### Task 1: Project Scaffold

**Files:**
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `vitest.config.ts`
- Create: `.env.local.example`

**Step 1: Install dependencies**

```bash
npm install
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["dom", "dom.iterable", "ES2024"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "paths": {
      "@/*": ["./src/*"]
    },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

**Step 3: Create next.config.ts**

```typescript
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {}

export default nextConfig
```

**Step 4: Create minimal app layout and page**

`src/app/layout.tsx`:
```tsx
export const metadata = { title: 'HikConnect Web' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

`src/app/page.tsx`:
```tsx
export default function Home() {
  return <h1>HikConnect Web</h1>
}
```

**Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
```

**Step 6: Create .env.local.example**

```
HIKCONNECT_BASE_URL=https://api.hik-connect.com
```

**Step 7: Verify the project builds and tests run**

```bash
npx next build 2>&1 | tail -5
npm test -- --run 2>&1 | tail -3
```

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js project with TypeScript and Vitest"
```

---

### Task 2: Hik-Connect API Types

**Files:**
- Create: `src/lib/hikconnect/types.ts`

**Step 1: Write the type definitions**

These types are derived from the reverse-engineered Java classes (`LoginRespData.java`, `StreamServerConfig.java`, `VtmInfo.java`, `TicketResp.java`). See design doc for field sources.

```typescript
// src/lib/hikconnect/types.ts

/** Wraps all Hik-Connect API responses */
export type ApiResponse<T> = {
  meta?: { code: number; message: string }
  loginArea?: { apiDomain: string }
  loginSession?: { sessionId: string; rfSessionId: string }
} & T

/** POST /v3/users/login/v2 response */
export type LoginResponse = ApiResponse<{
  loginSession: {
    sessionId: string
    rfSessionId: string
  }
  loginArea?: {
    apiDomain: string
  }
}>

/** PUT /v3/apigateway/login response */
export type RefreshResponse = ApiResponse<{
  sessionInfo: {
    sessionId: string
    refreshSessionId: string
  }
}>

/** Single device from pagelist */
export type Device = {
  deviceSerial: string
  deviceName: string
  deviceType: string
  deviceVersion: string
  status: number
  defence: number
  isEncrypt: number
  supportP2p: number
  p2pVersion: number
  casIp: string
  casPort: number
  deviceIp: string
  deviceLocalIp: string
  cmdPort: number
  localCmdPort: number
  channelNumber: number
}

/** GET /v3/userdevices/v1/resources/pagelist response */
export type DeviceListResponse = ApiResponse<{
  deviceInfos: Device[]
}>

/** Single camera channel */
export type Camera = {
  deviceSerial: string
  channelNo: number
  channelName: string
  status: number
  isShared: string
  videoLevel: number
}

/** GET /v3/userdevices/v1/cameras/info response */
export type CameraListResponse = ApiResponse<{
  cameraInfos: Camera[]
}>

/** GET /v3/streaming/ticket/{serial}/{channel} response */
export type StreamTicketResponse = ApiResponse<{
  ticket: string
}>

/** VTM server info */
export type VtmInfo = {
  domain: string
  externalIp: string
  port: number
  forceStreamType: number
  isBackup: number
}

/** GET /v3/streaming/vtm/{serial}/{channel} response */
export type VtmInfoResponse = ApiResponse<{
  streamServerConfig: VtmInfo
}>

/** Relay server public key */
export type PublicKey = {
  key: string
  version: number
}

/** Relay server config */
export type StreamServerConfig = {
  domain: string
  externalIp: string
  internalIp: string
  port: number
  internalPort: number
  forceStreamType: number
  isBackup: number
  memo: string
  publicKey: PublicKey
}

/** GET /v3/streaming/query/{type}/{serial}/{channel} response */
export type RelayServerResponse = ApiResponse<{
  streamServerConfig: StreamServerConfig
}>

/** A single recording file */
export type RecordFile = {
  begin: string
  end: string
  type: string
}

/** GET /v3/streaming/records response */
export type RecordListResponse = ApiResponse<{
  files: RecordFile[]
}>

/** Credentials for login */
export type Credentials = {
  account: string
  password: string
}

/** Session state stored server-side */
export type Session = {
  sessionId: string
  refreshSessionId: string
  apiDomain: string
  expiresAt: number
}
```

**Step 2: Verify types compile**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/lib/hikconnect/types.ts
git commit -m "feat: add Hik-Connect API type definitions"
```

---

### Task 3: API Client — Core HTTP Layer

**Files:**
- Create: `src/lib/hikconnect/client.ts`
- Create: `src/lib/hikconnect/client.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/hikconnect/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HikConnectClient } from './client'

describe('HikConnectClient', () => {
  describe('login', () => {
    it('sends MD5-hashed password and returns session', async () => {
      const fetches: { url: string; init: RequestInit }[] = []
      const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
        fetches.push({ url, init: init! })
        return new Response(JSON.stringify({
          meta: { code: 200, message: 'OK' },
          loginSession: { sessionId: 'sess123', rfSessionId: 'rf456' },
          loginArea: { apiDomain: 'https://api.hik-connect.com' },
        }), { status: 200 })
      })

      const client = new HikConnectClient({
        baseUrl: 'https://api.hik-connect.com',
        fetch: mockFetch as unknown as typeof fetch,
      })

      const session = await client.login({ account: 'user@test.com', password: 'mypass' })

      expect(session.sessionId).toBe('sess123')
      expect(session.refreshSessionId).toBe('rf456')

      // Verify password was MD5-hashed
      const body = new URLSearchParams(fetches[0].init.body as string)
      expect(body.get('password')).not.toBe('mypass')
      expect(body.get('password')).toHaveLength(32) // MD5 hex
      expect(body.get('account')).toBe('user@test.com')
    })
  })

  describe('getDevices', () => {
    it('sends sessionId header and returns device list', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(JSON.stringify({
          meta: { code: 200, message: 'OK' },
          deviceInfos: [{ deviceSerial: 'ABC123', deviceName: 'NVR' }],
        }), { status: 200 })
      )

      const client = new HikConnectClient({
        baseUrl: 'https://api.hik-connect.com',
        fetch: mockFetch as unknown as typeof fetch,
      })
      client.setSession({ sessionId: 'sess123', refreshSessionId: 'rf456', apiDomain: 'https://api.hik-connect.com', expiresAt: Date.now() + 3600000 })

      const devices = await client.getDevices()

      expect(devices).toHaveLength(1)
      expect(devices[0].deviceSerial).toBe('ABC123')

      const headers = new Headers(mockFetch.mock.calls[0][1]?.headers as HeadersInit)
      expect(headers.get('sessionId')).toBe('sess123')
    })
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run src/lib/hikconnect/client.test.ts
```
Expected: FAIL — `HikConnectClient` not found.

**Step 3: Write the implementation**

```typescript
// src/lib/hikconnect/client.ts
import { createHash } from 'node:crypto'
import type {
  Credentials, Session, Device, Camera,
  LoginResponse, RefreshResponse, DeviceListResponse, CameraListResponse,
  StreamTicketResponse, VtmInfoResponse, RelayServerResponse, RecordListResponse,
  VtmInfo, StreamServerConfig, RecordFile,
} from './types'

export type ClientOptions = {
  baseUrl: string
  fetch?: typeof fetch
}

const DEFAULT_HEADERS: Record<string, string> = {
  clientType: '55',
  featureCode: 'deadbeef',
  'Content-Type': 'application/x-www-form-urlencoded',
}

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export class HikConnectClient {
  private baseUrl: string
  private fetchFn: typeof fetch
  private session: Session | null = null

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl
    this.fetchFn = options.fetch ?? globalThis.fetch
  }

  setSession(session: Session) {
    this.session = session
  }

  getSession(): Session | null {
    return this.session
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...DEFAULT_HEADERS }
    if (this.session) {
      h.sessionId = this.session.sessionId
    }
    return h
  }

  private url(path: string): string {
    const base = this.session?.apiDomain ?? this.baseUrl
    return `${base}${path}`
  }

  async login(creds: Credentials): Promise<Session> {
    const body = new URLSearchParams({
      account: creds.account,
      password: md5(creds.password),
      featureCode: 'deadbeef',
    })

    const resp = await this.fetchFn(this.url('/v3/users/login/v2'), {
      method: 'POST',
      headers: this.headers(),
      body: body.toString(),
    })

    const data: LoginResponse = await resp.json()
    if (data.meta?.code !== 200) {
      throw new Error(data.meta?.message ?? 'Login failed')
    }

    this.session = {
      sessionId: data.loginSession.sessionId,
      refreshSessionId: data.loginSession.rfSessionId,
      apiDomain: data.loginArea?.apiDomain ?? this.baseUrl,
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
    return this.session
  }

  async refreshSession(): Promise<Session> {
    if (!this.session) throw new Error('No session to refresh')

    const body = new URLSearchParams({
      refreshSessionId: this.session.refreshSessionId,
      featureCode: 'deadbeef',
    })

    const resp = await this.fetchFn(this.url('/v3/apigateway/login'), {
      method: 'PUT',
      headers: this.headers(),
      body: body.toString(),
    })

    const data: RefreshResponse = await resp.json()
    if (data.meta?.code !== 200) {
      throw new Error(data.meta?.message ?? 'Refresh failed')
    }

    this.session = {
      ...this.session,
      sessionId: data.sessionInfo.sessionId,
      refreshSessionId: data.sessionInfo.refreshSessionId,
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
    return this.session
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.session) throw new Error('Not authenticated')

    const resp = await this.fetchFn(this.url(path), {
      method: 'GET',
      headers: this.headers(),
    })

    const data = await resp.json()
    if (data.meta?.code !== 200) {
      throw new Error(data.meta?.message ?? `GET ${path} failed`)
    }
    return data as T
  }

  async getDevices(): Promise<Device[]> {
    const data = await this.get<DeviceListResponse>(
      '/v3/userdevices/v1/resources/pagelist?groupId=-1&limit=50&offset=0&filter=TIME_PLAN,CONNECTION,SWITCH,STATUS,STATUS_EXT,WIFI,NODISTURB,P2P,KMS,HIDDNS'
    )
    return data.deviceInfos ?? []
  }

  async getCameras(deviceSerial: string): Promise<Camera[]> {
    const data = await this.get<CameraListResponse>(
      `/v3/userdevices/v1/cameras/info?deviceSerial=${deviceSerial}`
    )
    return data.cameraInfos ?? []
  }

  async getStreamTicket(deviceSerial: string, channelNo: number): Promise<string> {
    const data = await this.get<StreamTicketResponse>(
      `/v3/streaming/ticket/${deviceSerial}/${channelNo}`
    )
    return data.ticket
  }

  async getVtmInfo(deviceSerial: string, channelNo: number): Promise<VtmInfo> {
    const data = await this.get<VtmInfoResponse>(
      `/v3/streaming/vtm/${deviceSerial}/${channelNo}`
    )
    return data.streamServerConfig
  }

  async getRelayServer(type: string, deviceSerial: string, channelNo: number): Promise<StreamServerConfig> {
    const data = await this.get<RelayServerResponse>(
      `/v3/streaming/query/${type}/${deviceSerial}/${channelNo}`
    )
    return data.streamServerConfig
  }

  async getRecordings(deviceSerial: string, channelNo: number, startTime: string, stopTime: string): Promise<RecordFile[]> {
    const data = await this.get<RecordListResponse>(
      `/v3/streaming/records?deviceSerial=${deviceSerial}&channelNo=${channelNo}&startTime=${startTime}&stopTime=${stopTime}&size=500`
    )
    return data.files ?? []
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- --run src/lib/hikconnect/client.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/hikconnect/client.ts src/lib/hikconnect/client.test.ts
git commit -m "feat: implement Hik-Connect API client with login and device listing"
```

---

### Task 4: Session Management Singleton

**Files:**
- Create: `src/lib/hikconnect/session.ts`
- Create: `src/lib/hikconnect/session.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/hikconnect/session.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SessionStore } from './session'

describe('SessionStore', () => {
  let store: SessionStore

  beforeEach(() => {
    store = new SessionStore()
  })

  it('starts with no session', () => {
    expect(store.get()).toBeNull()
  })

  it('stores and retrieves a session', () => {
    const session = {
      sessionId: 'sess1',
      refreshSessionId: 'rf1',
      apiDomain: 'https://api.hik-connect.com',
      expiresAt: Date.now() + 3600000,
    }
    store.set(session)
    expect(store.get()).toEqual(session)
  })

  it('reports expired sessions', () => {
    store.set({
      sessionId: 'sess1',
      refreshSessionId: 'rf1',
      apiDomain: 'https://api.hik-connect.com',
      expiresAt: Date.now() - 1000,
    })
    expect(store.isExpired()).toBe(true)
  })

  it('reports non-expired sessions', () => {
    store.set({
      sessionId: 'sess1',
      refreshSessionId: 'rf1',
      apiDomain: 'https://api.hik-connect.com',
      expiresAt: Date.now() + 3600000,
    })
    expect(store.isExpired()).toBe(false)
  })

  it('clear removes the session', () => {
    store.set({
      sessionId: 'sess1',
      refreshSessionId: 'rf1',
      apiDomain: 'https://api.hik-connect.com',
      expiresAt: Date.now() + 3600000,
    })
    store.clear()
    expect(store.get()).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --run src/lib/hikconnect/session.test.ts
```

**Step 3: Write the implementation**

```typescript
// src/lib/hikconnect/session.ts
import type { Session } from './types'

export class SessionStore {
  private session: Session | null = null

  get(): Session | null {
    return this.session
  }

  set(session: Session) {
    this.session = session
  }

  clear() {
    this.session = null
  }

  isExpired(): boolean {
    if (!this.session) return true
    return Date.now() >= this.session.expiresAt
  }
}

/** Global singleton — lives for the lifetime of the Node.js process */
export const sessionStore = new SessionStore()
```

**Step 4: Run tests**

```bash
npm test -- --run src/lib/hikconnect/session.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/hikconnect/session.ts src/lib/hikconnect/session.test.ts
git commit -m "feat: add server-side session store for Hik-Connect auth"
```

---

### Task 5: Barrel Export

**Files:**
- Create: `src/lib/hikconnect/index.ts`

**Step 1: Create barrel export**

```typescript
// src/lib/hikconnect/index.ts
export { HikConnectClient } from './client'
export type { ClientOptions } from './client'
export { SessionStore, sessionStore } from './session'
export type * from './types'
```

**Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/lib/hikconnect/index.ts
git commit -m "feat: add barrel export for hikconnect module"
```

---

### Task 6: API Route — Login

**Files:**
- Create: `src/app/api/auth/login/route.ts`

**Step 1: Write the route**

```typescript
// src/app/api/auth/login/route.ts
import { NextResponse } from 'next/server'
import { HikConnectClient } from '@/lib/hikconnect'
import { sessionStore } from '@/lib/hikconnect'

export async function POST(request: Request) {
  const body = await request.json()
  const { account, password } = body

  if (!account || !password) {
    return NextResponse.json({ error: 'account and password required' }, { status: 400 })
  }

  const client = new HikConnectClient({
    baseUrl: process.env.HIKCONNECT_BASE_URL ?? 'https://api.hik-connect.com',
  })

  try {
    const session = await client.login({ account, password })
    sessionStore.set(session)
    return NextResponse.json({ ok: true, apiDomain: session.apiDomain })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Login failed'
    return NextResponse.json({ error: message }, { status: 401 })
  }
}
```

**Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/app/api/auth/login/route.ts
git commit -m "feat: add /api/auth/login route"
```

---

### Task 7: API Route — Devices

**Files:**
- Create: `src/lib/hikconnect/getClient.ts`
- Create: `src/app/api/devices/route.ts`

**Step 1: Create shared client factory**

```typescript
// src/lib/hikconnect/getClient.ts
import { HikConnectClient } from './client'
import { sessionStore } from './session'

export function getAuthenticatedClient(): HikConnectClient {
  const session = sessionStore.get()
  if (!session) throw new Error('Not authenticated')

  const client = new HikConnectClient({
    baseUrl: session.apiDomain,
  })
  client.setSession(session)
  return client
}
```

**Step 2: Create devices route**

```typescript
// src/app/api/devices/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET() {
  try {
    const client = getAuthenticatedClient()
    const devices = await client.getDevices()
    return NextResponse.json({ devices })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to fetch devices'
    const status = message === 'Not authenticated' ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
```

**Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/lib/hikconnect/getClient.ts src/app/api/devices/route.ts
git commit -m "feat: add /api/devices route and authenticated client factory"
```

---

### Task 8: API Routes — Cameras, Stream Ticket, VTM, Relay, Recordings

**Files:**
- Create: `src/app/api/devices/[serial]/cameras/route.ts`
- Create: `src/app/api/devices/[serial]/[channel]/ticket/route.ts`
- Create: `src/app/api/devices/[serial]/[channel]/vtm/route.ts`
- Create: `src/app/api/devices/[serial]/[channel]/relay/route.ts`
- Create: `src/app/api/devices/[serial]/[channel]/recordings/route.ts`

**Step 1: Create cameras route**

```typescript
// src/app/api/devices/[serial]/cameras/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(_req: Request, { params }: { params: Promise<{ serial: string }> }) {
  try {
    const { serial } = await params
    const client = getAuthenticatedClient()
    const cameras = await client.getCameras(serial)
    return NextResponse.json({ cameras })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

**Step 2: Create stream ticket route**

```typescript
// src/app/api/devices/[serial]/[channel]/ticket/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(_req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const client = getAuthenticatedClient()
    const ticket = await client.getStreamTicket(serial, Number(channel))
    return NextResponse.json({ ticket })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

**Step 3: Create VTM info route**

```typescript
// src/app/api/devices/[serial]/[channel]/vtm/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(_req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const client = getAuthenticatedClient()
    const vtm = await client.getVtmInfo(serial, Number(channel))
    return NextResponse.json({ vtm })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

**Step 4: Create relay server route**

```typescript
// src/app/api/devices/[serial]/[channel]/relay/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const url = new URL(req.url)
    const type = url.searchParams.get('type') ?? 'relay'
    const client = getAuthenticatedClient()
    const config = await client.getRelayServer(type, serial, Number(channel))
    return NextResponse.json({ config })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

**Step 5: Create recordings route**

```typescript
// src/app/api/devices/[serial]/[channel]/recordings/route.ts
import { NextResponse } from 'next/server'
import { getAuthenticatedClient } from '@/lib/hikconnect/getClient'

export async function GET(req: Request, { params }: { params: Promise<{ serial: string; channel: string }> }) {
  try {
    const { serial, channel } = await params
    const url = new URL(req.url)
    const startTime = url.searchParams.get('startTime') ?? ''
    const stopTime = url.searchParams.get('stopTime') ?? ''
    if (!startTime || !stopTime) {
      return NextResponse.json({ error: 'startTime and stopTime required' }, { status: 400 })
    }
    const client = getAuthenticatedClient()
    const files = await client.getRecordings(serial, Number(channel), startTime, stopTime)
    return NextResponse.json({ files })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

**Step 6: Verify compilation**

```bash
npx tsc --noEmit
```

**Step 7: Commit**

```bash
git add src/app/api/devices/
git commit -m "feat: add API routes for cameras, stream ticket, VTM, relay, and recordings"
```

---

### Task 9: Integration Test with Real API

**Files:**
- Create: `src/lib/hikconnect/client.integration.test.ts`

This test hits the real Hik-Connect API. It runs only when `HIKCONNECT_ACCOUNT` and `HIKCONNECT_PASSWORD` env vars are set.

**Step 1: Write the integration test**

```typescript
// src/lib/hikconnect/client.integration.test.ts
import { describe, it, expect } from 'vitest'
import { HikConnectClient } from './client'

const account = process.env.HIKCONNECT_ACCOUNT
const password = process.env.HIKCONNECT_PASSWORD

const skip = !account || !password

describe.skipIf(skip)('HikConnectClient integration', () => {
  it('logs in, lists devices, fetches stream params', async () => {
    const client = new HikConnectClient({
      baseUrl: 'https://api.hik-connect.com',
    })

    // Login
    const session = await client.login({ account: account!, password: password! })
    expect(session.sessionId).toBeTruthy()
    console.log('Logged in. apiDomain:', session.apiDomain)

    // List devices
    const devices = await client.getDevices()
    expect(devices.length).toBeGreaterThan(0)
    console.log('Devices:', devices.map(d => `${d.deviceSerial} (${d.deviceName})`))

    const device = devices[0]

    // List cameras
    const cameras = await client.getCameras(device.deviceSerial)
    expect(cameras.length).toBeGreaterThan(0)
    console.log('Cameras:', cameras.map(c => `ch${c.channelNo}: ${c.channelName}`))

    const cam = cameras[0]

    // Stream ticket
    const ticket = await client.getStreamTicket(device.deviceSerial, cam.channelNo)
    expect(ticket).toBeTruthy()
    console.log('Stream ticket:', ticket.substring(0, 20) + '...')

    // VTM info
    const vtm = await client.getVtmInfo(device.deviceSerial, cam.channelNo)
    expect(vtm.externalIp).toBeTruthy()
    console.log('VTM:', vtm.externalIp, ':', vtm.port)

    // Relay server
    try {
      const relay = await client.getRelayServer('relay', device.deviceSerial, cam.channelNo)
      console.log('Relay:', relay.externalIp, ':', relay.port)
      if (relay.publicKey) {
        console.log('Relay public key version:', relay.publicKey.version)
        console.log('Relay public key (first 40 chars):', relay.publicKey.key?.substring(0, 40))
      }
    } catch (e) {
      console.log('Relay server not available (expected for some device types)')
    }

    // Log full device info for protocol analysis
    console.log('\n--- Full device info for VTDU protocol work ---')
    console.log(JSON.stringify(device, null, 2))
    console.log('\n--- Full VTM info ---')
    console.log(JSON.stringify(vtm, null, 2))
  }, 30000)
})
```

**Step 2: Run the test (if credentials available)**

```bash
HIKCONNECT_ACCOUNT="your@email.com" HIKCONNECT_PASSWORD="yourpass" npm test -- --run src/lib/hikconnect/client.integration.test.ts
```

**Step 3: Commit**

```bash
git add src/lib/hikconnect/client.integration.test.ts
git commit -m "feat: add integration test for real Hik-Connect API"
```

---

### Task 10: Update barrel export and final verification

**Files:**
- Modify: `src/lib/hikconnect/index.ts`

**Step 1: Update barrel export**

```typescript
// src/lib/hikconnect/index.ts
export { HikConnectClient } from './client'
export type { ClientOptions } from './client'
export { SessionStore, sessionStore } from './session'
export { getAuthenticatedClient } from './getClient'
export type * from './types'
```

**Step 2: Run all tests**

```bash
npm test -- --run
```
Expected: All tests PASS.

**Step 3: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: No errors.

**Step 4: Commit**

```bash
git add src/lib/hikconnect/index.ts
git commit -m "feat: complete Phase 1 — Hik-Connect REST API client"
```

---

## Summary of API Routes Created

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/login` | POST | Login with Hik-Connect credentials |
| `/api/devices` | GET | List all devices |
| `/api/devices/[serial]/cameras` | GET | List cameras for a device |
| `/api/devices/[serial]/[channel]/ticket` | GET | Get stream ticket |
| `/api/devices/[serial]/[channel]/vtm` | GET | Get VTM relay server info |
| `/api/devices/[serial]/[channel]/relay` | GET | Get relay server config + public key |
| `/api/devices/[serial]/[channel]/recordings` | GET | List recording files |

## What's Next (Phase 2)

With the API client working and the integration test returning real VTM/relay server addresses and stream tickets, the next phase is:

1. Run the integration test to capture real relay server IPs and stream tickets
2. Set up Android emulator + TCP proxy to capture VTDU protocol traffic
3. Use the captured data to reverse engineer the binary protocol
4. Implement VTDU TCP client in Node.js
