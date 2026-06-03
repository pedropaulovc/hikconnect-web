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
  name: string
  fullSerial: string
  deviceType: string
  version: string
  status: number
  channelNumber: number
  hik: boolean
  deviceCategory: string
  customType: string
  mac: string
  supportExt: string
  ezDeviceCapability: string
  offlineTime: string
  offlineTimestamp: number
  riskLevel: number
}

/** GET /v3/userdevices/v1/resources/pagelist response */
export type DeviceListResponse = ApiResponse<{
  deviceInfos: Device[]
}>

/** Single camera channel */
export type Camera = {
  cameraId: string
  cameraName: string
  channelNo: number
  cameraCover: string
  deviceSerial: string
  isShow: number
  videoLevel: number
  videoQualityInfos: { streamType: number; videoLevel: number }[]
  vtmInfo?: VtmInfo
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

/** A single alarm/motion event from /v3/alarms/advanced */
export type AlarmEvent = {
  alarmId: string
  channelNo: number
  alarmName: string          // "Bikes"
  alarmType: number          // 10002
  sampleName: string         // "Motion Detection Alarm"
  alarmMessage: string       // "Bikes Motion Detection Alarm"
  alarmStartTime: number     // epoch ms (UTC)
  alarmStartTimeStr: string  // "2026-06-03 13:07:20" (device wall-clock)
  picUrl: string             // signed thumbnail; directly fetchable when isEncrypt=0
  isCheck: number            // 0 = unread
  isEncrypt: number          // 0 for this account
  preTime: number            // seconds before event
  delayTime: number          // seconds after event
}

/** Pagination block on /v3/alarms/advanced. NOTE: totalResults is unreliable — use hasNext. */
export type AlarmPage = {
  offset: number
  limit: number
  totalResults: number
  hasNext: boolean
}

/** GET /v3/alarms/advanced response */
export type AlarmListResponse = ApiResponse<{
  alarms: AlarmEvent[]
  page: AlarmPage
}>

/** P2P server entry from pagelist */
export type P2PServer = {
  ip: string
  port: number
}

/** Parsed P2P configuration for a device */
export type P2PConfig = {
  servers: P2PServer[]
  secretKey: string
  keyVersion: number
  connection: {
    localIp: string
    netIp: string
    localCmdPort: number
    netCmdPort: number
    localStreamPort: number
    netStreamPort: number
    wanIp: string
  }
}

/**
 * Account-level P2P server key + salt, fetched fresh per session.
 * Source: POST /api/p2p/configurations (official app's ConfigApi.getP2PConfigInfo).
 * The key rotates server-side, so it MUST be fetched, never hardcoded.
 */
export type P2PSecret = {
  /** 32-byte P2P server key, decoded from the "[b0,...,b31]" decimal-byte string. */
  key: Buffer
  /** Salt index paired with the key (0-7). */
  saltIndex: number
  /** Salt version (V3 flags). */
  saltVer: number
  /** Unix epoch (seconds) when this key expires server-side. */
  expireTime: number
  /** P2P server list returned alongside the secret. */
  servers: P2PServer[]
  /** Optional session ticket. */
  ticket: string | null
}

/** POST /api/p2p/configurations — raw response (uses resultCode, not meta). */
export type P2PConfigurationsResponse = {
  serverInfos: P2PServer[]
  expireTime: number | null
  ticket: string | null
  resultCode: string
  resultDes: string
  secret: {
    version: number
    saltIndex: number
    expireTime: number
    /** "[b0, b1, ..., b31]" signed decimal bytes. */
    data: string
  }
}

/** Raw KMS entry from pagelist */
export type KmsEntry = {
  secretKey: string
  version: string
}

/** Raw CONNECTION entry from pagelist */
export type ConnectionEntry = {
  localIp: string
  netIp: string
  localCmdPort: number
  netCmdPort: number
  localStreamPort: number
  netStreamPort: number
  netType: number
  wanIp: string
  upnp: boolean
}

/** GET /v3/userdevices/v1/resources/pagelist with P2P,KMS,CONNECTION filter */
export type P2PDeviceListResponse = ApiResponse<{
  deviceInfos: Device[]
  P2P: Record<string, P2PServer[]>
  KMS: Record<string, KmsEntry>
  CONNECTION: Record<string, ConnectionEntry>
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
