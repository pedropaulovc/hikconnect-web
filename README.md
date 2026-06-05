# hikconnect-web

Greenfield, production-grade, multitenant service for streaming Hikvision NVR/camera
video over the Hik-Connect cloud — no port forwarding required.

This `main` is a clean slate. The stack, data model, and architecture are being
designed from scratch for multitenancy and production operation.

## Reverse-engineering prototype

The earlier single-tenant prototype reverse-engineered the full Hik-Connect P2P
streaming pipeline (P2P_SETUP → hole-punch → SRT → HEVC, live + playback, verified
end-to-end) and documented the protocol in depth. It lives, intact, on:

```
feat/reverse-engineering-prototype
```

Treat that branch as the protocol reference (see its `docs/re/`) while building the
production service here.
