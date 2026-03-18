"""
Test ecdhCryption.dll functions via ctypes on Windows.
Run from Windows: python scripts/test-ecdh-dll.py

This captures the exact KDF output for known inputs to use as test vectors.
"""
import ctypes
import os
import sys

# Load the DLL
dll_path = os.path.join(os.path.dirname(__file__), '..', '..', 'ivms4200-extracted', 'ecdhCryption.dll')
if not os.path.exists(dll_path):
    dll_path = r"C:\temp\ecdhCryption.dll"

print(f"Loading: {dll_path}")
dll = ctypes.CDLL(dll_path)

# Function signatures from Ghidra exports
# ECDHCryption_InitLib() -> int
dll.ECDHCryption_InitLib.restype = ctypes.c_int

# ECDHCryption_CreateSession() -> void*
dll.ECDHCryption_CreateSession.restype = ctypes.c_void_p

# ECDHCryption_GeneratePublicAndPrivateKey(session) -> int
dll.ECDHCryption_GeneratePublicAndPrivateKey.restype = ctypes.c_int
dll.ECDHCryption_GeneratePublicAndPrivateKey.argtypes = [ctypes.c_void_p]

# ECDHCryption_GetSelfPublicKey(session, out_buf, out_len) -> int
dll.ECDHCryption_GetSelfPublicKey.restype = ctypes.c_int
dll.ECDHCryption_GetSelfPublicKey.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_int)]

# ECDHCryption_GenerateMasterKey(peer_pubkey_str, session) -> int
dll.ECDHCryption_GenerateMasterKey.restype = ctypes.c_int
dll.ECDHCryption_GenerateMasterKey.argtypes = [ctypes.c_char_p, ctypes.c_void_p]

# ECDHCryption_GenerateSessionKey(session) -> int
dll.ECDHCryption_GenerateSessionKey.restype = ctypes.c_int
dll.ECDHCryption_GenerateSessionKey.argtypes = [ctypes.c_void_p]

# ECDHCryption_GetMTKey(session, out_buf) -> int
dll.ECDHCryption_GetMTKey.restype = ctypes.c_int
dll.ECDHCryption_GetMTKey.argtypes = [ctypes.c_void_p, ctypes.c_char_p]

# ECDHCryption_DestroySession(session)
dll.ECDHCryption_DestroySession.argtypes = [ctypes.c_void_p]

# ECDHCryption_FiniLib()
dll.ECDHCryption_FiniLib.restype = ctypes.c_int

def main():
    print("=== ECDHCryption DLL Test ===\n")

    # Init library
    ret = dll.ECDHCryption_InitLib()
    print(f"InitLib: {ret}")

    # Create session
    session = dll.ECDHCryption_CreateSession()
    print(f"CreateSession: 0x{session:x}" if session else "CreateSession: NULL")

    if not session:
        print("Failed to create session!")
        return

    # Generate key pair
    ret = dll.ECDHCryption_GeneratePublicAndPrivateKey(session)
    print(f"GenerateKeyPair: {ret}")

    # Get our public key
    pubkey_buf = ctypes.create_string_buffer(256)
    pubkey_len = ctypes.c_int(256)
    ret = dll.ECDHCryption_GetSelfPublicKey(session, pubkey_buf, ctypes.byref(pubkey_len))
    print(f"GetSelfPublicKey: ret={ret} len={pubkey_len.value}")
    pubkey = pubkey_buf.raw[:pubkey_len.value]
    print(f"  Public key ({len(pubkey)}B): {pubkey.hex()}")

    # Use a known test server public key (from our relay server API)
    # This is the base64-decoded SPKI/DER key
    import base64
    server_pubkey_b64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqzR4o4/j2vzZ0mBmp2ym1CJkX3jzgqS8fIxQ1lDTcil7PE50SKxCXcevwE4NaJbUf5Sk9iyUDl+8/z2WbA4MYg=="
    server_pubkey_der = base64.b64decode(server_pubkey_b64)
    print(f"\nServer pubkey (DER, {len(server_pubkey_der)}B): {server_pubkey_der.hex()[:60]}...")

    # Generate master key
    ret = dll.ECDHCryption_GenerateMasterKey(server_pubkey_der, session)
    print(f"GenerateMasterKey: {ret}")

    # Get master key
    mt_key_buf = ctypes.create_string_buffer(64)
    ret = dll.ECDHCryption_GetMTKey(session, mt_key_buf)
    print(f"GetMTKey: ret={ret}")
    master_key = mt_key_buf.raw[:32]
    print(f"  Master key (32B): {master_key.hex()}")

    # Generate session key
    ret = dll.ECDHCryption_GenerateSessionKey(session)
    print(f"GenerateSessionKey: {ret}")

    # The session key is stored internally. Let's try to encrypt a test message
    # to see the output format.

    # Clean up
    dll.ECDHCryption_DestroySession(session)
    dll.ECDHCryption_FiniLib()
    print("\nDone!")

if __name__ == '__main__':
    main()
