# AirClip

A self-hosted LAN clipboard server. Send text snippets and files between your devices — iPhone, iPad, Mac, Windows — through any browser, with no third-party apps or cloud services required.

---

## Features

- **Text & file sharing** — paste text or attach files, delivered instantly to all connected devices via WebSocket
- **Dual upload paths** — files ≤ 20 MB are base64-encoded in-memory (with Preview support); files up to 500 MB are streamed directly to disk and served back as a download
- **Preview support** — images open in a fullscreen lightbox; audio, video, and PDF hand off to the native OS player/reader
- **Light / dark theme** — toggle in-page, preference persisted in `localStorage`
- **iOS Safari optimised** — fixed header/composer, inner scroll feed, no system zoom, safe-area insets for notch and home bar
- **One-time password auth** — a 6-digit OTP is printed to the server console on each startup; new devices must enter it once to receive a persistent token
- **Device management** — view all authorised devices, see last-active time, and revoke any device instantly from the in-page panel
- **Clean shutdown** — all in-memory messages and on-disk upload files are purged on server restart, no hidden leftovers

---

## Requirements

- [Node.js](https://nodejs.org/) v18 or later
- All devices on the same local network (Wi-Fi)

---

## Getting Started

```bash
# 1. Clone the repo
git clone https://github.com/yourname/airclip.git
cd airclip

# 2. Install dependencies
npm install

# 3. Start the server (port 80 requires elevated privileges)
# macOS / Linux
sudo node server.js

# Windows (run PowerShell as Administrator)
node server.js
```

On startup the console prints:

```
✦ AirClip

  → http://air.clip    (custom domain)
  → http://192.168.x.x  (LAN IP)
  → http://localhost       (local)

  ┌─────────────────────────┐
  │   OTP:  * * * * * *     │
  └─────────────────────────┘
```

Open the LAN IP address in any browser on any device. Enter the OTP once — the device is then remembered until you revoke it.

---

## Optional: Custom Domain (`air.clip`)

AirClip includes a lightweight DNS server that resolves `air.clip` to the host machine's LAN IP. To use it:

1. Start the server with `sudo` (DNS requires port 53)
2. On your iPhone/iPad: **Settings → Wi-Fi → (your network) → Configure DNS → Manual** — add the server's LAN IP as a DNS server
3. Open `http://air.clip` in Safari

> The DNS server forwards all other queries to `223.5.5.5` (Alibaba DNS), so normal browsing is unaffected.

---

## Security

| Mechanism | Details |
|-----------|---------|
| OTP | 6-digit random code regenerated on every server restart |
| Token | 64-character hex token issued after OTP verification, stored in `localStorage` |
| Auth gate | All API routes (except `/` and `/auth`) require a valid `x-token` header |
| WebSocket | WS connections require `?token=` query param; unauthorised connections are closed immediately |
| Device revocation | Revoking a device deletes its token server-side and closes any open WS connections; the device is redirected to the auth screen |

> AirClip is designed for **trusted LAN use only**. It does not use HTTPS. Do not expose port 80 to the public internet.

---

## File Size Limits

| Size | Behaviour |
|------|-----------|
| ≤ 20 MB | Base64 in JSON, held in memory, Preview available |
| 20 MB – 500 MB | Streamed via `multipart/form-data`, written to `./uploads/`, download only |
| > 500 MB | Rejected client-side before upload begins |

Upload files are stored in `./uploads/` during the server session and **deleted on restart**.

---

## Project Structure

```
airclip/
├── server.js       # HTTP server, WebSocket, DNS, auth, file handling
├── index.html      # Single-file frontend (vanilla JS, no build step)
├── package.json
└── uploads/        # Temporary large-file storage (auto-created, auto-purged)
```

---

## Roadmap

- [ ] HTTPS / self-signed certificate support
- [ ] Persistent message history (optional, opt-in)
- [ ] Drag-and-drop file upload
- [ ] Clipboard text auto-sync (iOS Share Sheet / Windows clipboard hook)

---

## License

MIT
