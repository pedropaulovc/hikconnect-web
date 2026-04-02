# JNI Export Survey — libezstreamclient.so

**Binary:** libezstreamclient.so (7.2MB, ARM64)
**Total functions:** 28,296
**JNI exports:** 200+ (`Java_com_ez_stream_NativeApi_*`)
**Source path leaked:** `E:\ezplayer\v7.5.6\sdk\src\common\ez_player_sdk\src\`

---

## Architecture Overview

```
Java (NativeApi.java)
  │
  ├── JNI_OnLoad @ 0x28fba4
  │     └── stores gJavaVM, creates thread key
  │
  ├── getFieldAndMethod @ 0x28fddc
  │     └── caches all JNI field/method IDs for:
  │           - InitParam (75+ fields)
  │           - P2PServerKey
  │           - EZStreamCallback
  │           - EZP2PServerInfo
  │           - EZStreamClientManager$GlobalCallback
  │           - EZTokenData
  │           - UploadVoiceParam, DownloadCloudParam
  │           - EZTimeoutParam, EZAutoDefReportParam
  │
  ├── Java_com_ez_stream_NativeApi_createClient @ 0x29625c
  │     ├── getInitParamValue(env, jobject, &INIT_PARAM)
  │     └── ezstream_createClient(&INIT_PARAM) → returns handle
  │
  ├── Java_com_ez_stream_NativeApi_startPreview @ 0x2965e4
  │     └── ezstream_startPreview(handle)
  │           └── vtable[0x20] → startPlayer()
  │                 └── EZMediaBase::startPlayer @ 0x27c3e0
  │
  └── Java_com_ez_stream_NativeApi_stopPreview @ 0x2965f8
        └── ezstream_stopPreview(handle)
```

## INIT_PARAM Structure (from getFieldAndMethod)

Complete field list extracted from JNI field ID caching:

### Connection Parameters
| Field | Type | Description |
|-------|------|-------------|
| szDevIP | String | Device WAN IP |
| szDevLocalIP | String | Device LAN IP |
| iDevCmdPort | int | Command port (9010) |
| iDevCmdLocalPort | int | Local command port |
| iDevStreamPort | int | Stream port (9020) |
| iDevStreamLocalPort | int | Local stream port |
| szDevSerial | String | Device serial (e.g., L38239367) |
| szSuperDeviceSerial | String | Parent device serial |
| szChnlSerial | String | Channel serial |
| szChnlIndex | String | Channel index |
| iChannelNumber | int | Channel number |
| iChannelCount | int | Total channels |

### CAS Broker
| Field | Type | Description |
|-------|------|-------------|
| szCasServerIP | String | CAS broker IP (34.194.209.167) |
| iCasServerPort | int | CAS broker port (6500) |

### STUN/P2P
| Field | Type | Description |
|-------|------|-------------|
| szStunIP | String | STUN server IP (43.130.155.63) |
| iStunPort | int | STUN port (6002) |
| iP2PVersion | int | P2P protocol version |
| iP2PSPS | int | P2P SPS value |
| p2pServerList | EZP2PServerInfo[] | P2P server list |
| stP2PServerKey | P2PServerKey | P2P server key struct |
| usP2PKeyVer | int | P2P key version (101) |
| szP2PLinkKey | byte[] | 32-byte P2P link key |
| iSupportNAT34 | int | NAT3/4 support flag |

### VTM/Relay
| Field | Type | Description |
|-------|------|-------------|
| szVtmIP | String | VTM relay IP |
| szVtmBackIP | String | VTM backup IP |
| iVtmPort | int | VTM port (8554) |
| szVtduIpCache | String | VTDU cached IP |
| iVtduPortCache | int | VTDU cached port |

### Cloud/Streaming
| Field | Type | Description |
|-------|------|-------------|
| szCloudServerIP | String | Cloud server IP |
| iCloudServerPort | int | Cloud server port |
| szCloudServerBackupIP | String | Cloud backup IP |
| szClientSession | String | JWT session token |
| szStreamToken | String | Stream ticket token |
| szTicketToken | String | Ticket token |
| szPermanetkey | String | Device permanent key |
| iStreamSource | int | Stream source type |
| iStreamInhibit | int | Stream inhibit flags (10 = disable DIRECT_OUTER + DIRECT_REVERSE) |
| iStreamType | int | Stream type |
| iVideoLevel | int | Video quality level |
| iClnType | int | Client type |

### Crypto
| Field | Type | Description |
|-------|------|-------------|
| vtduServerPublicKey | byte[] | VTDU server EC public key |
| vtduServerKeyVersion | int | Key version |
| iLinkEncryptV2 | int | Link encryption v2 flag |
| udpEcdh | int | UDP ECDH flag |

### Misc
| Field | Type | Description |
|-------|------|-------------|
| szHardwareCode | String | Hardware code |
| szTtsIP | String | TTS server IP |
| szTtsBackupIP | String | TTS backup IP |
| iTtsPort | int | TTS port |
| iTalkType | int | Talk type |
| szCallingId | String | Calling ID |
| iMicType | int | Mic type |
| szUserID | String | User ID |
| iPlaybackSpeed | int | Playback speed |
| iNetSDKUserId | int | NetSDK user ID |
| iNetSDKChannelNumber | int | NetSDK channel |
| iStorageVersion | int | Storage version |
| iCloudVideoType | int | Cloud video type |
| iSDCardVideoType | int | SD card video type |
| iBusType | int | Bus type |
| iInterlaceFlag | int | Interlace flag |
| iFrameInterval | int | Frame interval |
| iShared | int | Shared flag |
| iSmallStream | int | Small stream flag |
| isSmallMtu | int | Small MTU flag |
| iDevSupportAsyn | int | Async support flag |
| iSupportPlayBackEndFlag | int | Playback end flag |
| szStartTime | String | Start time |
| szStopTime | String | Stop time |
| szFileID | String | File ID |
| szExtInfo | String | Extension info |
| szExtensionParas | String | Extension parameters |
| iIPV6 | int | IPv6 flag |
| iNeedProxy | int | Proxy needed flag |
| iInternetType | int | Internet type |
| iCheckInterval | int | Check interval |
| iPreOpWhileStream | int | Pre-op while stream |

## P2PServerKey Structure
| Field | Type |
|-------|------|
| enabled | int |
| saltIndex | int |
| saltVer | int |
| szP2PKey | byte[] |

## Callback Interfaces

### EZStreamCallback
- `onDataCallBack(int type, byte[] data, int len)` — types: 1=HEADER, 2=DATA, 3=AUDIO, 50=FIRST_DATA, 100=END
- `onMessageCallBack(int msgType, int value)`
- `onStatisticsCallBack(int type, String info)`

### EZStreamClientManager$GlobalCallback
- `onPreConnectStatistics(int, String, String)`
- `onEvent(String, int, String)`
- `onData(...)`
- `onPreconnectResult(String, int, boolean)`
- `onFetchToken(String, String) → EZTokenData`

## Key Internal APIs

### CAS Client
| Function | Address | Purpose |
|----------|---------|---------|
| CASClient_InitLib | 0x280d60 | Initialize CAS library |
| CASClient_CreateSessionEx | 0x27e9e0 | Create CAS session |
| CASClient_DestroySession | 0x27b130 | Destroy session |
| CASClient_StopP2PPlay | 0x27bd60 | Stop P2P playback |
| CASClient_GetDevPermanentKey | 0x2815d0 | Get device key |
| CASClient_SetP2PStatusChangeCallBack | 0x27e010 | P2P status callback |
| CASClient_GetPreviewStatInformation | 0x281830 | Preview statistics |
| CASClient_GetStatisticInformation | 0x27fee0 | General statistics |
| CASClient_SetIntConfigInfo | 0x27d7a0 | Set int config |
| CASClient_SetStringConfigInfo | 0x2796f0 | Set string config |
| CASClient_CloudPlayStart | 0x27cdd0 | Start cloud playback |
| CASClient_CloudPlayStop | 0x27ec20 | Stop cloud playback |
| CASClient_CanDeviceDirectClient | 0x278f90 | Check direct connection |
| createCASClient | 0x281300 | Create CAS client instance |

### P2P Network
| Function | Address | Purpose |
|----------|---------|---------|
| p2pnet_Init | 0x280080 | Initialize P2P network |
| p2pnet_Fini | 0x287280 | Finalize P2P |
| p2pnet_CreateSession | 0x27da30 | Create P2P session |
| p2pnet_CloseSession | 0x27f690 | Close P2P session |
| p2pnet_SetStunAddress | 0x28d420 | Set STUN server |
| p2pnet_SetLocalIp | 0x279060 | Set local IP |
| p2pnet_GetSelfPunchInfo | 0x289ed0 | Get NAT punch info |
| p2pnet_SetPeerConnection | 0x286bf0 | Set peer connection info |
| p2pnet_SendData | 0x286830 | Send data over P2P |
| BavP2pnetGetPunchInfo | 0x279d20 | Get punch-through info |
| BavP2pnetSetPeerConnection | 0x286310 | Set peer connection |

### ECDH Crypto
| Function | Address | Purpose |
|----------|---------|---------|
| ezviz_ecdh_init | 0x28bf70 | Initialize ECDH |
| ezviz_ecdh_finit | 0x285c90 | Finalize ECDH |
| ezviz_ecdh_createSession | 0x283010 | Create ECDH session |
| ezviz_ecdh_destroySession | 0x2887f0 | Destroy ECDH session |
| ezviz_ecdh_generatePublicAndPrivateKey | 0x2866f0 | Generate key pair |
| ezviz_ecdh_getSelfPublicKey | 0x278ff0 | Get own public key |
| ezviz_ecdh_getPeerPublickey | 0x28b2b0 | Get peer public key |
| ezviz_ecdh_generateSessionKey | 0x280c00 | Derive session key |
| ezviz_ecdh_generateMasterKey | 0x288f50 | Derive master key |
| ezviz_ecdh_SetSessionEncKey | 0x2891d0 | Set encryption key |
| ezviz_ecdh_encECDHDataPackage | 0x287230 | Encrypt data packet |
| ezviz_ecdh_decECDHDataPackage | 0x27e770 | Decrypt data packet |
| ezviz_ecdh_encECDHReqPackage | 0x287150 | Encrypt request packet |
| ezviz_ecdh_decECDHReqPackage | 0x289600 | Decrypt request packet |
| ezviz_ecdh_setPBKeyAndPRKey | 0x280e70 | Set public/private keys |
| ezviz_ecdh_setEcdhMTKeyPair | 0x286a70 | Set MT key pair |
| ezviz_ecdh_GetMTKey | 0x286aa0 | Get MT key |
| ezviz_ecdh_SaveMTKey | 0x28a410 | Save MT key |
| ezviz_ecdh_updateECDHReqPackage | 0x27fb00 | Update request package |
| ezviz_ecdh_SetPacketWindowSize | 0x282210 | Set packet window |
| ezviz_ecdh_crc32 | 0x28d130 | CRC32 checksum |

## Call Flow: Live Preview

```
Java: NativeApi.createClient(initParam)
  → getInitParamValue(env, jobject, &INIT_PARAM)  // reads 75+ fields from Java
  → ezstream_createClient(&INIT_PARAM)
    → EZClientManager::createClient(g_pManager, &INIT_PARAM)
      → new EZMediaPreview(INIT_PARAM*)
        → EZStreamClientProxy::setCallback(onData, onMsg, onStats)

Java: NativeApi.startPreview(handle)
  → ezstream_startPreview(handle)
    → vtable[0x20] → startPlayer()
      ├── EZStreamClientProxy side (network):
      │     → CASClient_InitLib()
      │     → CASClient_CreateSessionEx(statusCB, dataCB, userData)
      │     → p2pnet_Init()
      │     → p2pnet_SetStunAddress(stunIP, stunPort)
      │     → p2pnet_CreateSession(notifyCB, recvDataCB, userData)
      │     → p2pnet_GetSelfPunchInfo()  // STUN binding request
      │     → CAS broker exchanges punch info with NVR
      │     → p2pnet_SetPeerConnection(session, peerAddr, peerPort)
      │     → p2pnet_SendData()           // stream request over P2P
      │     → P2PNetRecvData()            // incoming video packets
      │     → ezviz_ecdh_decECDHDataPackage()  // ChaCha20 decrypt
      │     → HandleVideoStream()         // demux PS container
      │     → onDataCallbackMedia()       // deliver to player
      │
      └── EZMediaBase side (player, decompiled @ 0x3217a4):
            → PlayM4_GetPort()
            → vtable[0x18]() → get encryption key
            → PlayM4_SetSecretKey(port, 1, key, keyBits)
            │  keyBits = 128 if key ≤ 16 bytes, else full length * 8
            → PlayM4_SetEncryptTypeCallBack(port, 1, player_EncryptTypeCBFun)
            → PlayM4_SetFileEndCallback()
            → PlayM4_RegisterDecCallBack(player_DecodeCallback)
            → PlayM4_SetDisplayCallBackEx(player_DisplayCBFun)
            → PlayM4_SetStreamEndCallback()
            → PlayM4_Play(port, surface)
```

**Key insight:** EZStreamClientProxy handles CAS/P2P/crypto (network layer).
EZMediaBase handles PlayM4 media decoding (player layer). For our TypeScript
implementation, we only need the network layer — we pipe raw frames to FFmpeg
instead of using PlayM4.

## Next Steps

1. **Decompile CASClient_InitLib + CASClient_CreateSessionEx** — understand the CAS TCP protocol
2. **Decompile p2pnet_Init + p2pnet_CreateSession** — understand STUN/P2P setup
3. **Decompile ezviz_ecdh_generateSessionKey** — understand key derivation
4. **Decompile HandleVideoStream + inputData** — understand packet framing
