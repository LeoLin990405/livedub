# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.2.x | ✅ |
| 0.1.x | ⚠️ best effort |

## Reporting a Vulnerability

Please **do not** open a public issue for security problems.

1. Open a private report via GitHub → *Security* → *Report a vulnerability*
   (private vulnerability reporting) on this repository.
2. Include: affected version/commit, OS, reproduction steps, and impact.
3. We aim to acknowledge within 7 days and provide a remediation plan.

## Threat model & design boundaries

livedub is a **local-first** tool. The local engine:

- binds to `127.0.0.1` only (never `0.0.0.0` by default);
- accepts WebSocket origins limited to `chrome-extension://*` and
  `http://127.0.0.1` / `http://localhost`;
- serves static files only from whitelisted directories (`studio/`, `demo/`) and
  protects against path traversal;
- never writes API keys to disk, never logs them, and `/api/config` responses are
  recursively scrubbed;
- reads provider credentials read-only from `~/.sayless/config.json` or
  `LIVEDUB_PROVIDER_*` environment variables.

Out of scope for the local engine: multi-user hosting, remote access, TLS
termination. If you expose the engine beyond localhost you do so at your own risk
and should place a hardened reverse proxy in front of it.

## Known non-security limitations

- Chrome extension `tabCapture` requires a user gesture; DRM-protected media may
  not be capturable.
- Local ASR runs on-device; translated text is sent to the configured cloud
  providers (DeepSeek / MiniMax etc.) only when you configure them.
- The bundled demo media is synthetic; no third-party copyrighted content is
  included.

## Dependencies

Runtime has **zero npm dependencies** (Node built-ins only). This drastically
reduces supply-chain risk; test code also uses only `node:test`.
