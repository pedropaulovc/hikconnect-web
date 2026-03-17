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
    let base = this.session?.apiDomain ?? this.baseUrl
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = `https://${base}`
    }
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
