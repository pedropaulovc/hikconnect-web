// src/lib/hikconnect/client.test.ts
import { describe, it, expect, vi } from 'vitest'
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const headers = new Headers((mockFetch.mock.lastCall as any)?.[1]?.headers as HeadersInit)
      expect(headers.get('sessionId')).toBe('sess123')
    })
  })
})
