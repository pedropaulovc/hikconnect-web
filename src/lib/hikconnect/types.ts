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
