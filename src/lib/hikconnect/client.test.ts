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
      const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
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

      const lastCall = mockFetch.mock.lastCall!
      const headers = new Headers(lastCall[1]?.headers)
      expect(headers.get('sessionId')).toBe('sess123')
    })
  })

  describe('getP2PConfig', () => {
    it('parses P2P servers, KMS key, and connection info from pagelist response', async () => {
      const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({
          meta: { code: 200, message: 'OK' },
          deviceInfos: [{ deviceSerial: 'L38239367' }],
          P2P: {
            L38239367: [
              { ip: '52.5.124.127', port: 6000 },
              { ip: '52.203.168.207', port: 6000 },
            ],
          },
          KMS: {
            L38239367: {
              secretKey: '6447f56b9e4229fb94b6f2677603e9c0ee179f183c16d1df64f1602cd852999b',
              version: '101',
            },
          },
          CONNECTION: {
            L38239367: {
              localIp: '192.168.0.101',
              netIp: '24.35.64.195',
              localCmdPort: 9010,
              netCmdPort: 9010,
              localStreamPort: 9020,
              netStreamPort: 9020,
              netType: 3,
              wanIp: '24.35.64.195',
              upnp: false,
            },
          },
        }), { status: 200 })
      )

      const client = new HikConnectClient({
        baseUrl: 'https://api.hik-connect.com',
        fetch: mockFetch as unknown as typeof fetch,
      })
      client.setSession({
        sessionId: 'sess123',
        refreshSessionId: 'rf456',
        apiDomain: 'https://api.hik-connect.com',
        expiresAt: Date.now() + 3600000,
      })

      const config = await client.getP2PConfig('L38239367')

      expect(config.servers).toEqual([
        { ip: '52.5.124.127', port: 6000 },
        { ip: '52.203.168.207', port: 6000 },
      ])
      expect(config.secretKey).toBe('6447f56b9e4229fb94b6f2677603e9c0ee179f183c16d1df64f1602cd852999b')
      expect(config.keyVersion).toBe(101)
      expect(config.connection.localIp).toBe('192.168.0.101')
      expect(config.connection.netIp).toBe('24.35.64.195')
      expect(config.connection.localCmdPort).toBe(9010)
      expect(config.connection.netCmdPort).toBe(9010)
      expect(config.connection.localStreamPort).toBe(9020)
      expect(config.connection.netStreamPort).toBe(9020)
      expect(config.connection.wanIp).toBe('24.35.64.195')

      // Verify the filter query parameter
      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('filter=P2P,KMS,CONNECTION')
    })

    it('throws when device serial is not found in P2P response', async () => {
      const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({
          meta: { code: 200, message: 'OK' },
          deviceInfos: [],
          P2P: {},
          KMS: {},
          CONNECTION: {},
        }), { status: 200 })
      )

      const client = new HikConnectClient({
        baseUrl: 'https://api.hik-connect.com',
        fetch: mockFetch as unknown as typeof fetch,
      })
      client.setSession({
        sessionId: 'sess123',
        refreshSessionId: 'rf456',
        apiDomain: 'https://api.hik-connect.com',
        expiresAt: Date.now() + 3600000,
      })

      await expect(client.getP2PConfig('UNKNOWN')).rejects.toThrow('No P2P servers found for device UNKNOWN')
    })
  })

  describe('getAlarms', () => {
    const sessionInit = { sessionId: 'sess123', refreshSessionId: 'rf456', apiDomain: 'https://api.hik-connect.com', expiresAt: Date.now() + 3600000 }

    it('builds the advanced-alarms query and returns alarms + page', async () => {
      const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({
          meta: { code: 200, message: 'OK' },
          page: { offset: 0, limit: 50, totalResults: 100, hasNext: true },
          alarms: [{ alarmId: 'a1', channelNo: 5, alarmMessage: 'Bikes Motion Detection Alarm' }],
        }), { status: 200 })
      )
      const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com', fetch: mockFetch as unknown as typeof fetch })
      client.setSession(sessionInit)

      const result = await client.getAlarms('L38239367', {
        alarmStart: '2026-06-03 00:00:00', alarmEnd: '2026-06-03 13:00:00', offset: 0, limit: 50,
      })

      expect(result.alarms).toHaveLength(1)
      expect(result.alarms[0].channelNo).toBe(5)
      expect(result.page.hasNext).toBe(true)

      const url = new URL(mockFetch.mock.lastCall![0] as string)
      expect(url.pathname).toBe('/v3/alarms/advanced')
      expect(url.searchParams.get('deviceSerial')).toBe('L38239367')
      expect(url.searchParams.get('queryType')).toBe('-1')
      expect(url.searchParams.get('alarmType')).toBe('-1')
      expect(url.searchParams.get('limit')).toBe('50')
      expect(url.searchParams.get('offset')).toBe('0')
      expect(url.searchParams.get('alarmStart')).toBe('2026-06-03 00:00:00')
      expect(url.searchParams.get('alarmEnd')).toBe('2026-06-03 13:00:00')
    })

    it('throws when meta.code is not 200', async () => {
      const mockFetch = vi.fn(async () =>
        new Response(JSON.stringify({ meta: { code: 99991, message: 'session expired' } }), { status: 200 })
      )
      const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com', fetch: mockFetch as unknown as typeof fetch })
      client.setSession(sessionInit)
      await expect(client.getAlarms('L38239367', { alarmStart: 'x', alarmEnd: 'y' })).rejects.toThrow('session expired')
    })

    it('defaults offset=0 and limit=50 when omitted', async () => {
      const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ meta: { code: 200, message: 'OK' }, page: { offset: 0, limit: 50, totalResults: 0, hasNext: false }, alarms: [] }), { status: 200 })
      )
      const client = new HikConnectClient({ baseUrl: 'https://api.hik-connect.com', fetch: mockFetch as unknown as typeof fetch })
      client.setSession(sessionInit)
      await client.getAlarms('L38239367', { alarmStart: 'a', alarmEnd: 'b' })
      const url = new URL(mockFetch.mock.lastCall![0] as string)
      expect(url.searchParams.get('offset')).toBe('0')
      expect(url.searchParams.get('limit')).toBe('50')
    })
  })
})
