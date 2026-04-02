# ECDH Frida Capture — 2026-03-18

Captured from Hik-Connect Android app (com.connect.enduser) running on x86_64 Android 14 emulator with ARM64 NDK translation.

## Key Finding: ECDH Not Used for This Device

The device (NVR L38239367) has `udpEcdh=0` and `vtduServerPublicKey` is all zeros. The API does not provide a server ECDH public key, so the native ECDH functions (`generateECDHKey`, `setClientECDHKey`, `enableStreamClientCMDEcdh`) are never called.

The streaming connection uses a non-ECDH relay/VTM path. ECDH is only triggered when `udpEcdh != 0` AND the API provides a non-zero `vtduServerPublicKey` (91B SPKI/DER).

## Complete InitParam Dump

Captured via `NativeApi.createPreviewHandle(InitParam)`:

### Connection Config
| Field | Value | Notes |
|-------|-------|-------|
| szDevSerial | L38239367 | NVR serial |
| szChnlSerial | L38239367 | Channel serial |
| iChannelNumber | 1 | Camera channel |
| iChannelCount | 8 | Total channels on NVR |
| szDevIP | 24.35.64.195 | NVR public IP |
| szDevLocalIP | 192.168.0.101 | NVR local IP |
| iDevCmdPort / iDevCmdLocalPort | 9010 | Command port |
| iDevStreamPort / iDevStreamLocalPort | 9020 | Stream port |

### P2P Config
| Field | Value | Notes |
|-------|-------|-------|
| iP2PVersion | 3 | V3 protocol |
| iP2PSPS | 9 | P2P SPS value |
| usP2PKeyVer | 101 | Key version |
| stP2PServerKey.szP2PKey | `e4465f2d011ebf9d85eb32d46e1549bdf64c171d616a132afaba4b4d348a39d5` | Confirmed stable |
| stP2PServerKey.enabled | 1 | |
| stP2PServerKey.saltIndex | 3 | |
| stP2PServerKey.saltVer | 1 | |
| szP2PLinkKey | `6447f56b9e4229fb94b6f2677603e9c0` | 32 ASCII chars from KMS secretKey |

### Server Endpoints
| Field | Value | Notes |
|-------|-------|-------|
| szStunIP:iStunPort | 43.130.155.63:6002 | STUN server |
| szCasServerIP:iCasServerPort | 34.194.209.167:6500 | CAS broker |
| szVtmIP:iVtmPort | 148.153.53.29:8554 | VTM relay |
| szVtmBackIP | 148.153.53.29 | VTM backup |

### ECDH Config
| Field | Value | Notes |
|-------|-------|-------|
| udpEcdh | 0 | **ECDH disabled** |
| vtduServerKeyVersion | 0 | No server key |
| vtduServerPublicKey | (91B all zeros) | No public key = no ECDH |

### Stream Config
| Field | Value | Notes |
|-------|-------|-------|
| iStreamType | 1 | Sub-stream |
| iStreamTimeOut | 30000 | 30s timeout |
| iStreamInhibit | 10 | Max concurrent streams |
| iStreamSource | 0 | EZ_STREAM_SOURCE_LIVE_MINE |
| iClnType | 55 | Client type |
| iInternetType | 1 | |
| iStorageVersion | 1 | |

### Authentication
| Field | Value | Notes |
|-------|-------|-------|
| szClientSession | JWT token (eyJhbG...) | Session auth |
| szUserID | fcfaec90a55f4a61b4e7211152a2d805 | Account UUID |
| szHardwareCode | 74265e48c93893a15a29040e1aefcfc0 | Device fingerprint |
| szLid | ffc30384-4436-42b2-8dc8-b452c16fbde7 | Link ID |

### Stream Disable Flags (Constants)
| Constant | Value |
|----------|-------|
| EZ_STREAM_DISABLE_NONE | 0 |
| EZ_STREAM_DISABLE_DIRECT_INNER | 1 |
| EZ_STREAM_DISABLE_DIRECT_OUTER | 2 |
| EZ_STREAM_DISABLE_P2P | 4 |
| EZ_STREAM_DISABLE_DIRECT_REVERSE | 8 |
| EZ_STREAM_DISABLE_PRIVATE_STREAM | 16 |

## setSecretKey Capture

```
NativeApi.setSecretKey(handle, "ABCDEF")
```

The verification/encryption code `"ABCDEF"` is passed as the second argument. This is the 6-character device verification code from the device sticker (or Hik-Connect app -> Device Settings).

## Java ECDH API Surface

### EZEcdhKeyInfo (com.ez.stream.EZEcdhKeyInfo)
```java
byte[] szPBKey;   // Public key (SPKI/DER format, 91B)
int iPBKeyLen;    // Public key length
byte[] szPRKey;   // Private key (PEM format, ~128B)
int iPRKeyLen;    // Private key length
```

### EcdhKeyInfo (com.ezplayer.param.model.EcdhKeyInfo)
Kotlin model with Parcelable support:
```kotlin
val publicKey: ByteArray
val publicKeyLength: Int
val privateKey: ByteArray
val privateKeyLength: Int
val time: Long      // Key generation timestamp
```

### NativeApi ECDH Methods
```java
// Generate ECDH P-256 key pair (fills EZEcdhKeyInfo)
static native int generateECDHKey(EZEcdhKeyInfo keyInfo);

// Set pre-generated client key pair for reuse
static native void setClientECDHKey(byte[] pubKey, int pubKeyLen, byte[] privKey, int privKeyLen);

// Enable ECDH for stream client CMD channel
static native void enableStreamClientCMDEcdh();

// Enable ECDH for TTS (two-way talk) CMD channel
static native void enableTTSCMDEcdh();
```

### StreamClientManager
```kotlin
fun getEcdhKey(): EcdhKeyInfo  // Get cached ECDH key pair
```

## ECDH Trigger Conditions

Based on the code flow, ECDH is used when:
1. `InitParam.udpEcdh != 0` — API indicates ECDH is required
2. `InitParam.vtduServerPublicKey` is non-zero (91B SPKI/DER) — server provides its public key
3. The app then calls `generateECDHKey()` or uses a cached key via `setClientECDHKey()`
4. `enableStreamClientCMDEcdh()` is called to enable ECDH on the CMD channel

## Native Library Loading

On x86_64 emulator with ARM64 NDK translation, the native libraries (`libezstreamclient.so`, `libmbedcrypto.so`, `libConvergenceEncrypt.so`) are loaded from within the APK via memory mapping but do NOT appear in `Process.enumerateModules()`. Frida can hook Java methods but cannot directly hook the native ECDH functions (they're invisible to the module enumeration).

## Next Steps for ECDH Test Vectors

To capture actual ECDH key material, we need either:
1. **A device/account where `udpEcdh != 0`** — some newer devices or accounts may have ECDH enabled
2. **An ARM64 device/emulator** where native libs load normally and Frida can hook `ezviz_ecdh_generateMasterKey` directly
3. **Modify the API response** to inject a non-zero `vtduServerPublicKey` and set `udpEcdh=1` (MITM approach)
4. **Use iVMS-4200 (Windows)** which uses `ecdhCryption.dll` — can be hooked with Frida for Windows
