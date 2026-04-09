const http   = require('http');
const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const dgram  = require('dgram');
const os     = require('os');
const { WebSocketServer } = require('ws');
const { randomUUID, randomBytes } = require('crypto');
const Busboy = require('busboy');

const HTTP_PORT      = 80;
const DNS_PORT       = 53;
const MAX_MESSAGES   = 50;
const SMALL_LIMIT    = 20  * 1024 * 1024;   // ≤20 MB → base64 in JSON (preview OK)
const LARGE_LIMIT    = 500 * 1024 * 1024;   // ≤500 MB → multipart, stored on disk
const UPLOAD_DIR     = path.join(__dirname, 'uploads');
const HOSTNAME       = 'air.clip';
const UPSTREAM_DNS   = '223.5.5.5';

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Auth ──────────────────────────────────────────────────
const OTP = String(Math.floor(100000 + Math.random() * 900000));
const devices = new Map(); // token → { id, name, firstSeen, lastSeen }

function genToken() { return randomBytes(32).toString('hex'); }

function authMiddleware(req) {
  const token = req.headers['x-token'] || new URL(req.url, 'http://x').searchParams.get('token');
  if (!token) return null;
  const dev = devices.get(token);
  if (!dev) return null;
  dev.lastSeen = Date.now();
  return dev;
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; req.resume(); reject(new Error('too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return; done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('bad_json')); }
    });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

// ── Multipart upload → disk ───────────────────────────────
function receiveFile(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) { reject(new Error('not_multipart')); return; }

    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: LARGE_LIMIT } });
    let meta = { sender: 'Device', filename: 'file', mime: 'application/octet-stream' };
    let fileId = null, filePath = null, fileSize = 0, limitHit = false;

    bb.on('field', (name, val) => { meta[name] = val.slice(0, 256); });

    bb.on('file', (name, stream, info) => {
      fileId   = randomUUID();
      filePath = path.join(UPLOAD_DIR, fileId);
      meta.filename = info.filename || 'file';
      meta.mime     = info.mimeType || 'application/octet-stream';

      const out = fs.createWriteStream(filePath);
      stream.on('data', chunk => { fileSize += chunk.length; });
      stream.on('limit', () => {
        limitHit = true;
        out.destroy();
        try { fs.unlinkSync(filePath); } catch {}
        reject(new Error('too_large'));
      });
      stream.pipe(out);
      out.on('error', reject);
    });

    bb.on('close', () => {
      if (limitHit) return;
      if (!fileId) { reject(new Error('no_file')); return; }
      resolve({ fileId, filePath, fileSize, ...meta });
    });

    bb.on('error', reject);
    req.pipe(bb);
  });
}

// ── State ─────────────────────────────────────────────────
let messages = [];
let clients  = new Map(); // ws → token

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return '127.0.0.1';
}
const localIP = getLocalIP();

function broadcast(data) {
  const p = JSON.stringify(data);
  for (const [ws] of clients) if (ws.readyState === 1) ws.send(p);
}

// ── HTTP ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── Static
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }

  // ── Auth
  if (req.method === 'POST' && url === '/auth') {
    let body;
    try { body = await readBody(req, 1024); } catch { json(res, 400, { error: 'bad_request' }); return; }
    if (body.otp !== OTP) { json(res, 401, { error: 'invalid_otp' }); return; }
    const token = genToken();
    const name  = (body.name || 'Device').slice(0, 32);
    devices.set(token, { id: randomUUID(), name, firstSeen: Date.now(), lastSeen: Date.now() });
    console.log(`\n  ✓ Device authorized: ${name}\n`);
    json(res, 200, { token });
    return;
  }

  // ── Auth gate
  const dev = authMiddleware(req);
  if (!dev) { json(res, 401, { error: 'unauthorized' }); return; }

  // ── Messages list
  if (req.method === 'GET' && url === '/messages') {
    json(res, 200, messages);
    return;
  }

  // ── Send (small: JSON/base64, large: multipart)
  if (req.method === 'POST' && url === '/send') {
    const ct = req.headers['content-type'] || '';

    if (ct.includes('multipart/form-data')) {
      // Large file path
      let info;
      try { info = await receiveFile(req); }
      catch (e) {
        json(res, e.message === 'too_large' ? 413 : 400, { error: e.message });
        return;
      }
      const msg = {
        id: randomUUID(), type: 'file-large',
        fileId: info.fileId, filename: info.filename,
        mime: info.mime, size: info.fileSize,
        ts: Date.now(),
        sender: (info.sender || dev.name).slice(0, 32),
      };
      messages.unshift(msg);
      if (messages.length > MAX_MESSAGES) messages = messages.slice(0, MAX_MESSAGES);
      broadcast({ event: 'new', msg });
      json(res, 200, { ok: true });
      return;
    }

    // Small file / text path (JSON)
    let body;
    try { body = await readBody(req, SMALL_LIMIT + 65536); }
    catch (e) { json(res, e.message === 'too_large' ? 413 : 400, { error: e.message }); return; }
    const msg = {
      id: randomUUID(), type: body.type || 'text',
      content: body.content, filename: body.filename || null,
      mime: body.mime || null, ts: Date.now(),
      sender: (body.sender || dev.name).slice(0, 32),
    };
    messages.unshift(msg);
    if (messages.length > MAX_MESSAGES) messages = messages.slice(0, MAX_MESSAGES);
    broadcast({ event: 'new', msg });
    json(res, 200, { ok: true });
    return;
  }

  // ── Download large file
  if (req.method === 'GET' && url.startsWith('/file/')) {
    const fileId = url.slice(6).replace(/[^a-f0-9-]/gi, '');
    const msg = messages.find(m => m.fileId === fileId);
    if (!msg) { json(res, 404, { error: 'not_found' }); return; }
    const filePath = path.join(UPLOAD_DIR, fileId);
    try {
      const stat = await fsp.stat(filePath);
      res.writeHead(200, {
        'Content-Type': msg.mime || 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(msg.filename)}"`,
      });
      fs.createReadStream(filePath).pipe(res);
    } catch { json(res, 404, { error: 'file_not_found' }); }
    return;
  }

  // ── Delete message (also clean up disk file)
  if (req.method === 'DELETE' && url.startsWith('/delete/')) {
    const id = url.slice(8);
    const msg = messages.find(m => m.id === id);
    if (msg && msg.fileId) {
      try { await fsp.unlink(path.join(UPLOAD_DIR, msg.fileId)); } catch {}
    }
    messages = messages.filter(m => m.id !== id);
    broadcast({ event: 'delete', id });
    res.writeHead(200); res.end('ok');
    return;
  }

  if (req.method === 'DELETE' && url === '/clear') {
    // Clean up all disk files
    for (const m of messages) {
      if (m.fileId) try { await fsp.unlink(path.join(UPLOAD_DIR, m.fileId)); } catch {}
    }
    messages = [];
    broadcast({ event: 'clear' });
    res.writeHead(200); res.end('ok');
    return;
  }

  // ── Devices
  if (req.method === 'GET' && url === '/devices') {
    json(res, 200, [...devices.entries()].map(([token, d]) => ({
      token, id: d.id, name: d.name, firstSeen: d.firstSeen, lastSeen: d.lastSeen,
    })));
    return;
  }

  if (req.method === 'DELETE' && url.startsWith('/devices/')) {
    const targetToken = url.slice(9);
    if (!devices.has(targetToken)) { json(res, 404, { error: 'not_found' }); return; }
    const name = devices.get(targetToken).name;
    devices.delete(targetToken);
    for (const [ws, tok] of clients) {
      if (tok === targetToken) { ws.close(); clients.delete(ws); }
    }
    broadcast({ event: 'device_revoked', token: targetToken });
    console.log(`\n  ✗ Device revoked: ${name}\n`);
    json(res, 200, { ok: true });
    return;
  }

  res.writeHead(404); res.end();
});

// ── WebSocket ─────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  if (!token || !devices.has(token)) { ws.close(); return; }
  devices.get(token).lastSeen = Date.now();
  clients.set(ws, token);
  ws.on('close', () => clients.delete(ws));
});

// ── DNS ───────────────────────────────────────────────────
function readQName(buf, offset) {
  let name = '', i = offset;
  while (i < buf.length && buf[i] !== 0) {
    const len = buf[i++];
    name += (name ? '.' : '') + buf.slice(i, i + len).toString('ascii');
    i += len;
  }
  return { name: name.toLowerCase(), end: i + 1 };
}
function buildAResponse(query, ip) {
  const id = query.slice(0, 2);
  const { end } = readQName(query, 12);
  const qSection = query.slice(12, end + 4);
  const rdata = Buffer.from(ip.split('.').map(Number));
  return Buffer.concat([
    id, Buffer.from([0x81, 0x80]),
    Buffer.from([0x00,0x01,0x00,0x01,0x00,0x00,0x00,0x00]),
    qSection, Buffer.from([0xc0,0x0c]),
    Buffer.from([0x00,0x01,0x00,0x01]),
    Buffer.from([0x00,0x00,0x00,0x3c]),
    Buffer.from([0x00,0x04]), rdata,
  ]);
}
function startDNS() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let qname = '';
    try { qname = readQName(msg, 12).name; } catch { return; }
    if (qname === HOSTNAME || qname === 'www.' + HOSTNAME) {
      try { sock.send(buildAResponse(msg, localIP), rinfo.port, rinfo.address); } catch {}
      return;
    }
    const up = dgram.createSocket('udp4');
    const t  = setTimeout(() => { try { up.close(); } catch {} }, 3000);
    up.send(msg, DNS_PORT, UPSTREAM_DNS);
    up.on('message', r => { clearTimeout(t); sock.send(r, rinfo.port, rinfo.address); try { up.close(); } catch {} });
    up.on('error', () => { clearTimeout(t); try { up.close(); } catch {} });
  });
  sock.on('error', e => {
    if (e.code === 'EACCES') console.warn('\n⚠  DNS port 53 needs root.\n');
    else console.error('[DNS]', e.message);
  });
  sock.bind(DNS_PORT, '0.0.0.0', () => console.log(`  → DNS  :53  (${HOSTNAME} → ${localIP})`));
}

// ── Boot ──────────────────────────────────────────────────
server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('\n✦ AirClip\n');
  console.log(`  → http://${HOSTNAME}    (custom domain)`);
  console.log(`  → http://${localIP}  (LAN IP)`);
  console.log(`  → http://localhost       (local)\n`);
  console.log(`  ┌─────────────────────────┐`);
  console.log(`  │   OTP: ${OTP}           │`);
  console.log(`  └─────────────────────────┘\n`);
  startDNS();
});
server.on('error', e => {
  if (e.code === 'EACCES') { console.error('\n✗ Port 80 needs admin.\nRun: sudo node server.js\n'); process.exit(1); }
  throw e;
});