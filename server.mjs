/* Minimal zero-dependency static server for FLOR MUSIC.
   Usage: node server.mjs  (then open http://localhost:5173) */
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import os from 'node:os';
import tls from 'node:tls';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, 'app');
const START_PORT = Number(process.env.PORT) || 5173;

/* ============================================================
   Accounts — stored server-side in users.json so the SAME login
   works from any device that connects to this server (PC, phone…).
   ============================================================ */
const USERS_FILE = join(__dirname, 'users.json');
const AVATARS_DIR = join(__dirname, 'avatars');
function avatarFile(email){ return join(AVATARS_DIR, crypto.createHash('sha256').update(email).digest('hex') + '.jpg'); }
let users = {};
try { users = JSON.parse(readFileSync(USERS_FILE, 'utf8')) || {}; } catch { users = {}; }
async function saveUsers(){ try { await writeFile(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e){ console.error('users.json save failed:', e.message); } }
function hashPass(pass, salt){
  salt = salt || crypto.randomBytes(8).toString('hex');
  const h = crypto.scryptSync(String(pass), salt, 32).toString('hex');
  return salt + ':' + h;
}
function verifyPass(pass, stored){
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hashPass(pass, salt)), Buffer.from(stored));
}
function readBody(req){
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ============================================================
   Email delivery (for login codes & password reset).
   Config is read from env vars or email-config.json next to this server.
   Supported: любой SMTP (Gmail, Yandex, Proton*, Mail.ru…), Brevo API, Resend API.
   If nothing is configured, codes print to the console for local testing.
   ============================================================ */
let emailCfg = {};
try { emailCfg = JSON.parse(readFileSync(join(__dirname, 'email-config.json'), 'utf8')) || {}; } catch { emailCfg = {}; }
let proxyCfg = {};
try { proxyCfg = JSON.parse(readFileSync(join(__dirname, 'proxy-config.json'), 'utf8')) || {}; } catch { proxyCfg = {}; }
const PROXY = { workerUrl: (process.env.CF_WORKER_URL || proxyCfg.workerUrl || '').trim().replace(/\/$/, '') };
const EMAIL = {
  smtpHost: (process.env.SMTP_HOST || emailCfg.smtpHost || 'smtp.gmail.com').trim(),
  smtpPort: Number(process.env.SMTP_PORT || emailCfg.smtpPort || 465),
  smtpUser: (process.env.SMTP_USER || emailCfg.smtpUser || '').trim(),
  smtpPass: (process.env.SMTP_PASS || emailCfg.smtpPass || '').trim(),
  brevoKey: (process.env.BREVO_API_KEY || emailCfg.brevoKey || '').trim(),
  resendKey: (process.env.RESEND_API_KEY || emailCfg.resendKey || '').trim(),
  from: (process.env.EMAIL_FROM || emailCfg.from || '').trim(),
  fromName: (process.env.EMAIL_FROM_NAME || emailCfg.fromName || 'FLOR MUSIC').trim(),
};

function smtpConfigured(){ return !!(EMAIL.smtpUser && EMAIL.smtpPass); }

function readSmtpResponse(socket){
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/).filter(l => l.length);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)){
        socket.off('data', onData);
        const code = Number(last.slice(0, 3));
        if (code >= 400) reject(new Error(buf.trim()));
        else resolve(buf.trim());
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('SMTP connection closed')));
  });
}

async function smtpCmd(socket, cmd){
  if (cmd != null) socket.write(cmd + '\r\n');
  return readSmtpResponse(socket);
}

async function smtpConnect(host, port){
  if (port === 465){
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
    return socket;
  }
  const plain = net.connect({ host, port });
  await new Promise((res, rej) => { plain.once('connect', res); plain.once('error', rej); });
  await readSmtpResponse(plain);
  await smtpCmd(plain, 'EHLO flor-music');
  await smtpCmd(plain, 'STARTTLS');
  const socket = tls.connect({ socket: plain, servername: host, rejectUnauthorized: true });
  await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
  return socket;
}

async function sendSmtpEmail(to, subject, html){
  const from = EMAIL.from || EMAIL.smtpUser;
  const host = EMAIL.smtpHost;
  const port = EMAIL.smtpPort || 465;
  const socket = await smtpConnect(host, port);

  if (port === 465) await readSmtpResponse(socket);
  await smtpCmd(socket, 'EHLO flor-music');
  await smtpCmd(socket, 'AUTH LOGIN');
  await smtpCmd(socket, Buffer.from(EMAIL.smtpUser).toString('base64'));
  await smtpCmd(socket, Buffer.from(EMAIL.smtpPass).toString('base64'));
  await smtpCmd(socket, `MAIL FROM:<${from}>`);
  await smtpCmd(socket, `RCPT TO:<${to}>`);
  await smtpCmd(socket, 'DATA');
  const body = Buffer.from(html, 'utf8').toString('base64');
  const msg = [
    `From: ${EMAIL.fromName} <${from}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '.',
  ].join('\r\n');
  await smtpCmd(socket, msg);
  try { await smtpCmd(socket, 'QUIT'); } catch {}
  socket.end();
}

async function sendEmail(to, subject, html, textCode){
  if (!smtpConfigured() && !EMAIL.brevoKey && !EMAIL.resendKey){
    console.log(`\n  [EMAIL → ${to}] ${subject}\n  Код: ${textCode || '(см. письмо)'}\n`);
    return { ok: true, dev: true };
  }
  try {
    if (smtpConfigured()){
      await sendSmtpEmail(to, subject, html);
      return { ok: true };
    }
    if (EMAIL.brevoKey){
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': EMAIL.brevoKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          sender: { email: EMAIL.from, name: EMAIL.fromName },
          to: [{ email: to }], subject, htmlContent: html,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok){ const t = await r.text().catch(() => ''); console.error('Brevo send failed', r.status, t); return { ok: false }; }
      return { ok: true };
    }
    // Resend
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + EMAIL.resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${EMAIL.fromName} <${EMAIL.from}>`, to: [to], subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok){ const t = await r.text().catch(() => ''); console.error('Resend send failed', r.status, t); return { ok: false, error: t }; }
    return { ok: true };
  } catch (e){ console.error('sendEmail error', e.message); return { ok: false, error: e.message }; }
}
const emailConfigured = () => smtpConfigured() || !!(EMAIL.brevoKey || EMAIL.resendKey);

function emailSendError(){
  return 'Не удалось отправить письмо. Проверьте email-config.json на сервере (Gmail SMTP или API-ключ).';
}

/* one-time codes: key `${purpose}:${email}` -> { code, exp, tries } */
const codes = new Map();
const pendingReg = new Map();   // email -> { name, pass(hash), exp }
const CODE_TTL = 10 * 60 * 1000;
function genCode(){ return String(Math.floor(100000 + Math.random() * 900000)); }
function putCode(purpose, email){
  const code = genCode();
  codes.set(purpose + ':' + email, { code, exp: Date.now() + CODE_TTL, tries: 0 });
  return code;
}
function checkCode(purpose, email, code){
  const key = purpose + ':' + email;
  const rec = codes.get(key);
  if (!rec) return false;
  if (Date.now() > rec.exp){ codes.delete(key); return false; }
  if (rec.tries++ > 6){ codes.delete(key); return false; }
  if (rec.code !== String(code || '').trim()) return false;
  codes.delete(key);
  return true;
}
function codeEmailHtml(code, action){
  return `<div style="font-family:Arial,sans-serif;max-width:440px;margin:auto">
    <h2 style="color:#6C3CE0">FLOR MUSIC</h2>
    <p>Ваш код для ${action}:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#1A1426">${code}</div>
    <p style="color:#888;font-size:13px">Код действует 10 минут. Если вы это не запрашивали — проигнорируйте письмо.</p>
  </div>`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // ---- API: health check (client uses this to detect server reachability) ----
  if (urlPath === '/api/health'){
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ---- API: public config (Cloudflare Worker URL for music proxy) ----
  if (urlPath === '/api/config'){
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ workerUrl: PROXY.workerUrl || null }));
  }

  // ---- API: user avatar (GET) ----
  if (urlPath === '/api/auth/avatar' && req.method === 'GET'){
    const email = (new URL(req.url, 'http://x').searchParams.get('email') || '').trim().toLowerCase();
    const u = users[email];
    if (!u?.hasAvatar) { res.writeHead(404); return res.end(); }
    try {
      const data = await readFile(avatarFile(email));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
      return res.end(data);
    } catch { res.writeHead(404); return res.end(); }
  }

  // ---- API: accounts (shared across devices) ----
  if (urlPath.startsWith('/api/auth/') && req.method === 'POST'){
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const pass = String(b.pass || '');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    const userOut = (u, em) => {
      const e = em || u.email || email;
      return { name: u.name, email: e, avatar: u.hasAvatar ? `/api/auth/avatar?email=${encodeURIComponent(e)}&t=${u.avatarAt || 0}` : null };
    };

    // 1) Start registration → store pending + email a confirmation code.
    if (urlPath === '/api/auth/register'){
      const name = String(b.name || '').trim();
      if (!EMAIL_RE.test(email)) return json(400, { error: 'Некорректный email' });
      if (pass.length < 4) return json(400, { error: 'Пароль слишком короткий (мин. 4 символа)' });
      if (users[email]) return json(409, { error: 'Аккаунт с таким email уже существует' });
      pendingReg.set(email, { name: name || email.split('@')[0], pass: hashPass(pass), exp: Date.now() + CODE_TTL });
      const code = putCode('register', email);
      const r = await sendEmail(email, 'Код подтверждения FLOR MUSIC', codeEmailHtml(code, 'подтверждения регистрации'), code);
      if (!r.ok) return json(502, { error: emailSendError() });
      return json(200, { ok: true, step: 'verify', emailed: !r.dev, devCode: r.dev ? code : undefined });
    }

    // 2) Confirm registration with the code.
    if (urlPath === '/api/auth/register/verify'){
      const p = pendingReg.get(email);
      if (!p || Date.now() > p.exp){ pendingReg.delete(email); return json(400, { error: 'Срок кода истёк, начните заново' }); }
      if (!checkCode('register', email, b.code)) return json(401, { error: 'Неверный код' });
      users[email] = { name: p.name, email, pass: p.pass, createdAt: Date.now() };
      pendingReg.delete(email); await saveUsers();
      return json(200, { ok: true, user: userOut(users[email], email) });
    }

    // 3) Password login.
    if (urlPath === '/api/auth/login'){
      const u = users[email];
      if (!u || !verifyPass(pass, u.pass)) return json(401, { error: 'Неверный email или пароль' });
      return json(200, { ok: true, user: userOut(u, email) });
    }

    // 3b) Change password (logged-in user).
    if (urlPath === '/api/auth/password'){
      const u = users[email];
      const oldPass = String(b.oldPass || '');
      const newPass = String(b.newPass || '');
      if (!u || !verifyPass(oldPass, u.pass)) return json(401, { error: 'Неверный текущий пароль' });
      if (newPass.length < 4) return json(400, { error: 'Новый пароль слишком короткий (мин. 4 символа)' });
      u.pass = hashPass(newPass); await saveUsers();
      return json(200, { ok: true });
    }

    // 3c) Upload avatar (base64 JPEG, max ~400 KB).
    if (urlPath === '/api/auth/avatar'){
      const u = users[email];
      if (!u || !verifyPass(pass, u.pass)) return json(401, { error: 'Неверный пароль' });
      const raw = String(b.avatar || '');
      const m = raw.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
      if (!m) return json(400, { error: 'Некорректное изображение' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 400000) return json(400, { error: 'Файл слишком большой (макс. 400 КБ)' });
      try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(AVATARS_DIR, { recursive: true });
        await writeFile(avatarFile(email), buf);
        u.hasAvatar = true; u.avatarAt = Date.now(); await saveUsers();
        return json(200, { ok: true, user: userOut(u, email) });
      } catch (e){ return json(500, { error: 'Не удалось сохранить аватар' }); }
    }

    // 4) Request a one-time code for passwordless login OR password reset.
    if (urlPath === '/api/auth/code'){
      const purpose = b.purpose === 'reset' ? 'reset' : 'login';
      if (!users[email]) return json(404, { error: 'Аккаунт с таким email не найден' });
      const code = putCode(purpose, email);
      const action = purpose === 'reset' ? 'сброса пароля' : 'входа';
      const r = await sendEmail(email, 'Код FLOR MUSIC', codeEmailHtml(code, action), code);
      if (!r.ok) return json(502, { error: emailSendError() });
      return json(200, { ok: true, emailed: !r.dev, devCode: r.dev ? code : undefined });
    }

    // 5) Verify passwordless-login code.
    if (urlPath === '/api/auth/code/verify'){
      if (!checkCode('login', email, b.code)) return json(401, { error: 'Неверный или просроченный код' });
      const u = users[email];
      if (!u) return json(404, { error: 'Аккаунт не найден' });
      return json(200, { ok: true, user: userOut(u, email) });
    }

    // 6) Reset password with a code.
    if (urlPath === '/api/auth/reset'){
      if (pass.length < 4) return json(400, { error: 'Пароль слишком короткий (мин. 4 символа)' });
      if (!checkCode('reset', email, b.code)) return json(401, { error: 'Неверный или просроченный код' });
      const u = users[email];
      if (!u) return json(404, { error: 'Аккаунт не найден' });
      u.pass = hashPass(pass); await saveUsers();
      return json(200, { ok: true, user: userOut(u, email) });
    }

    // 7) Sync library (playlists, liked, wave) across devices.
    if (urlPath === '/api/auth/library'){
      const u = users[email];
      if (!u) return json(404, { error: 'Аккаунт не найден' });
      const hasData = b.playlists || b.liked || b.wave;
      if (hasData){
        u.library = u.library || {};
        if (Array.isArray(b.playlists)) u.library.playlists = b.playlists.slice(0, 50);
        if (Array.isArray(b.liked)) u.library.liked = b.liked.slice(0, 500);
        if (Array.isArray(b.wave)) u.library.wave = b.wave.slice(0, 80);
        u.library.updatedAt = Number(b.updatedAt) || Date.now();
        await saveUsers();
      }
      const lib = u.library || { playlists: [], liked: [], wave: [], updatedAt: 0 };
      return json(200, { ok: true, library: lib });
    }

    return json(404, { error: 'Неизвестный метод' });
  }

  // ---- API: Audius / iTunes (proxied — works when the VPS blocks YouTube/SC) ----
  if (urlPath.startsWith('/api/audius/') || urlPath === '/api/itunes/search'){
    const params = new URL(req.url, 'http://x').searchParams;
    const jsonOk = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    try {
      if (urlPath === '/api/audius/host'){
        return jsonOk({ host: await audiusGetHost() });
      }
      if (urlPath === '/api/audius/search'){
        const query = params.get('query') || params.get('q') || '';
        const limit = params.get('limit') || '30';
        return jsonOk(await audiusProxy('/v1/tracks/search', { query, limit }));
      }
      if (urlPath === '/api/audius/trending'){
        const p = { time: params.get('time') || 'week' };
        const genre = params.get('genre'); if (genre) p.genre = genre;
        return jsonOk(await audiusProxy('/v1/tracks/trending', p));
      }
      if (urlPath === '/api/audius/playlists/trending'){
        return jsonOk(await audiusProxy('/v1/playlists/trending', {}));
      }
      if (urlPath === '/api/audius/playlists/tracks'){
        const id = params.get('id') || '';
        if (!id){ res.writeHead(400); return res.end('bad id'); }
        return jsonOk(await audiusProxy(`/v1/playlists/${id}/tracks`, {}));
      }
      if (urlPath === '/api/itunes/search'){
        const q = params.get('q') || '';
        const limit = params.get('limit') || '30';
        const r = await serverFetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}`);
        return jsonOk(await r.json());
      }
    } catch (e){
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ data: [], results: [], error: e.message }));
    }
  }

  // ---- API: YouTube search (server-side, no key, no CORS) ----
  if (urlPath === '/api/yt/search'){
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    const items = await ytSearch(q).catch(() => []);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ items }));
  }

  // ---- API: YouTube AUDIO stream (proxied) ----
  // YouTube video/googlevideo is throttled or blocked by some ISPs (e.g. in RU),
  // and the IFrame player then shows "video unavailable". We instead resolve an
  // audio-only stream through a foreign Piped instance and pipe it through this
  // server, so the browser only ever talks to localhost + a non-Google host.
  if (urlPath === '/api/yt/audio'){
    try {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      if (!/^[\w-]{6,20}$/.test(id)){ res.writeHead(400); return res.end('bad id'); }
      const audioUrl = await ytAudioUrl(id);
      if (!audioUrl){ res.writeHead(502); return res.end('no audio'); }
      const headers = { 'User-Agent': 'Mozilla/5.0' };
      if (req.headers.range) headers['Range'] = req.headers.range;
      const up = await fetch(audioUrl, { headers });
      const h = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      const ct = up.headers.get('content-type'); if (ct) h['Content-Type'] = ct;
      const cl = up.headers.get('content-length'); if (cl) h['Content-Length'] = cl;
      const cr = up.headers.get('content-range'); if (cr) h['Content-Range'] = cr;
      res.writeHead(up.status, h);
      if (up.body) Readable.fromWeb(up.body).pipe(res); else res.end();
    } catch (e){
      if (!res.headersSent) res.writeHead(502);
      res.end('audio error');
    }
    return;
  }

  // ---- API: SoundCloud search ----
  if (urlPath === '/api/sc/search'){
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    const items = await scSearch(q).catch(() => []);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ items }));
  }

  // ---- API: SoundCloud stream (resolve + redirect to media) ----
  if (urlPath === '/api/sc/stream'){
    try {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      if (!/^\d+$/.test(id)){ res.writeHead(400); return res.end('bad id'); }
      const media = await scStreamUrl(id);
      if (!media){ res.writeHead(502); return res.end('no stream'); }
      res.writeHead(302, { Location: media, 'Cache-Control': 'no-store' });
      return res.end();
    } catch (e){
      if (!res.headersSent) res.writeHead(502);
      return res.end('stream error');
    }
  }

  // ---- API: image proxy (same-origin, so the client can crop artwork to a
  //      square on a <canvas> without CORS tainting → fixes the iPhone player
  //      showing covers with black side bars) ----
  if (urlPath === '/api/img'){
    try {
      const u = new URL(req.url, 'http://x').searchParams.get('u') || '';
      if (!/^https?:\/\//i.test(u)){ res.writeHead(400); return res.end('bad url'); }
      const up = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      const ct = up.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//.test(ct)){ res.writeHead(415); return res.end('not image'); }
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      return res.end(buf);
    } catch {
      if (!res.headersSent) res.writeHead(502);
      return res.end('img error');
    }
  }

  // ---- Static files ----
  try {
    let p = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = normalize(join(ROOT, p));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const data = await readFile(filePath);
    // No caching for app files so edits always reach the browser on reload.
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
  }
});

/* ============================================================
   Shared outbound fetch — some RU VPS hosts block YouTube /
   SoundCloud but still reach Audius, iTunes and Invidious mirrors.
   ============================================================ */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

async function serverFetch(url, opts = {}){
  const r = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
    signal: opts.signal || AbortSignal.timeout(opts.timeout || 12000),
    ...opts,
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r;
}

/* ============================================================
   Audius — proxied for search/trending on VPS where the browser
   may not reach api.audius.co reliably.
   ============================================================ */
let audiusHost = null, audiusHostAt = 0;
const AUDIUS_HOST_TTL = 30 * 60 * 1000;
// api.audius.co часто отдаёт 403 с RU VPS — пробуем зеркала напрямую.
const AUDIUS_MIRRORS = [
  'https://discoveryprovider.audius.co',
  'https://audius-mainnet.cultur3stake.com',
  'https://audius-discovery-1.altego.net',
  'https://audius-discovery-2.altego.net',
];

async function audiusGetHost(){
  if (audiusHost && Date.now() - audiusHostAt < AUDIUS_HOST_TTL) return audiusHost;
  try {
    const r = await serverFetch('https://api.audius.co', { timeout: 6000 });
    const j = await r.json();
    const hosts = (j.data || []).filter(Boolean);
    if (hosts.length){ audiusHost = hosts[0]; audiusHostAt = Date.now(); return audiusHost; }
  } catch {}
  for (const h of AUDIUS_MIRRORS){
    try {
      await serverFetch(`${h}/v1/tracks/trending?app_name=FLOR-Music&limit=1`, { timeout: 8000 });
      audiusHost = h; audiusHostAt = Date.now();
      return audiusHost;
    } catch {}
  }
  audiusHost = AUDIUS_MIRRORS[0];
  audiusHostAt = Date.now();
  return audiusHost;
}

async function audiusProxy(path, params){
  const host = await audiusGetHost();
  const qs = new URLSearchParams(params);
  if (!qs.has('app_name')) qs.set('app_name', 'FLOR-Music');
  const r = await serverFetch(`${host}${path}?${qs}`);
  return r.json();
}

/* ============================================================
   YouTube search by scraping the public results page.
   No API key, no quota, no payment — runs server-side so there
   are no CORS issues. Results are cached briefly in memory.
   ============================================================ */
const ytCache = new Map();   // q -> { at, items }
const YT_TTL = 5 * 60 * 1000;
const INVIDIOUS = [
  'https://invidious.ducks.party',
  'https://invidious.privacyredirect.com',
  'https://invidious.io',
  'https://vid.puffyan.us',
  'https://inv.tux.pizza',
  'https://inv.nadeko.net',
  'https://invidious.fdn.fr',
  'https://yewtu.be',
];

function parseDuration(text){
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((a, n) => a * 60 + n, 0);
}

async function invidiousSearch(q){
  for (const inst of INVIDIOUS){
    try {
      const r = await serverFetch(`${inst}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, { timeout: 8000 });
      const j = await r.json();
      const items = [];
      for (const v of (j || [])){
        if (v.type !== 'video' || !v.videoId || !v.lengthSeconds) continue;
        const thumb = (v.videoThumbnails || []).find(t => t.quality === 'medium')?.url
          || (v.videoThumbnails || []).at(-1)?.url
          || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`;
        items.push({
          id: v.videoId,
          title: v.title || 'YouTube',
          author: (v.author || 'YouTube').replace(/ - Topic$/, ''),
          duration: v.lengthSeconds,
          thumb,
        });
        if (items.length >= 30) break;
      }
      if (items.length) return items;
    } catch {}
  }
  return [];
}

async function ytSearchDirect(q){
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en&gl=US`;
  const r = await serverFetch(url, {
    headers: { Cookie: 'CONSENT=YES+1; SOCS=CAI;' },
    timeout: 15000,
  });
  const html = await r.text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s) || html.match(/ytInitialData = (\{.*?\});/s);
  if (!m) return [];

  let data; try { data = JSON.parse(m[1]); } catch { return []; }
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const items = [];
  for (const sec of sections){
    const list = sec.itemSectionRenderer?.contents || [];
    for (const it of list){
      const v = it.videoRenderer;
      if (!v || !v.videoId) continue;
      const dur = parseDuration(v.lengthText?.simpleText);
      if (!dur) continue;
      const thumbs = v.thumbnail?.thumbnails || [];
      items.push({
        id: v.videoId,
        title: v.title?.runs?.[0]?.text || 'YouTube',
        author: (v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || 'YouTube').replace(/ - Topic$/, ''),
        duration: dur,
        thumb: thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      });
      if (items.length >= 30) break;
    }
    if (items.length >= 30) break;
  }
  return items;
}

async function ytSearch(q){
  q = (q || '').trim();
  if (!q) return [];
  const cached = ytCache.get(q);
  if (cached && Date.now() - cached.at < YT_TTL) return cached.items;

  let items = [];
  try { items = await ytSearchDirect(q); } catch {}
  if (!items.length) items = await invidiousSearch(q);
  if (items.length) ytCache.set(q, { at: Date.now(), items });
  return items;
}

/* ============================================================
   Resolve a playable audio-only stream URL for a YouTube video
   via public Piped instances (hosted abroad → not Google-blocked).
   ============================================================ */
const PIPED = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.reallyaweso.me',
  'https://api.piped.private.coffee',
  'https://pipedapi.drgns.space',
];
const audioCache = new Map();   // id -> { at, url }
const AUDIO_TTL = 90 * 60 * 1000;

async function pipedAudio(inst, id){
  const r = await fetch(`${inst}/streams/${id}`, {
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!r.ok) throw new Error(inst + ' ' + r.status);
  const j = await r.json();
  const audios = (j.audioStreams || []).filter(a => a && a.url);
  if (!audios.length) throw new Error(inst + ' no streams');
  audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  // Prefer an m4a/AAC stream around ≤160 kbps for broad <audio> compatibility.
  const isM4a = a => /mp4|m4a|mp4a/i.test(a.mimeType || a.format || '');
  const pick = audios.find(a => isM4a(a) && (a.bitrate || 0) <= 160000)
            || audios.find(isM4a)
            || audios[0];
  if (!pick?.url) throw new Error(inst + ' no url');
  return pick.url;
}

async function ytAudioUrl(id){
  const c = audioCache.get(id);
  if (c && Date.now() - c.at < AUDIO_TTL) return c.url;
  try {
    // Race every instance — take the first that returns a usable stream.
    const url = await Promise.any(PIPED.map(inst => pipedAudio(inst, id)));
    if (url){ audioCache.set(id, { at: Date.now(), url }); return url; }
  } catch {}
  return null;
}

/* ============================================================
   SoundCloud — public api-v2 with a scraped client_id.
   Works in regions where YouTube is blocked; serves full tracks.
   ============================================================ */
const SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
let scClientId = null, scClientIdAt = 0;
const SC_CID_TTL = 6 * 60 * 60 * 1000;

async function scGetClientId(){
  if (scClientId && Date.now() - scClientIdAt < SC_CID_TTL) return scClientId;
  try {
    const html = await (await serverFetch('https://soundcloud.com/', { headers: { 'User-Agent': SC_UA } })).text();
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)].map(m => m[1]);
    for (const src of scripts.reverse()){
      try {
        const js = await (await serverFetch(src, { headers: { 'User-Agent': SC_UA }, timeout: 6000 })).text();
        const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{20,40})"/);
        if (m){ scClientId = m[1]; scClientIdAt = Date.now(); return scClientId; }
      } catch {}
    }
  } catch {}
  return scClientId;
}

function scArtwork(t){
  const u = t.artwork_url || t.user?.avatar_url || '';
  return u ? u.replace('-large.', '-t300x300.') : '';
}

async function scSearch(q){
  q = (q || '').trim();
  if (!q) return [];
  const cid = await scGetClientId();
  if (!cid) return [];
  try {
    const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=25&client_id=${cid}`;
    const r = await serverFetch(url, { headers: { 'User-Agent': SC_UA }, timeout: 8000 });
    const j = await r.json();
    const items = [];
    for (const t of (j.collection || [])){
      if (!t || t.kind !== 'track' || t.streamable === false) continue;
      const hasProgressive = (t.media?.transcodings || []).some(x => x.format?.protocol === 'progressive');
      if (!hasProgressive) continue;
      items.push({
        id: t.id,
        title: t.title || 'SoundCloud',
        author: t.user?.username || '',
        duration: Math.round((t.duration || 0) / 1000),
        thumb: scArtwork(t),
      });
      if (items.length >= 25) break;
    }
    return items;
  } catch { return []; }
}

async function scStreamUrl(trackId){
  const cid = await scGetClientId();
  if (!cid) return null;
  const r = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${cid}`, {
    headers: { 'User-Agent': SC_UA }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const t = await r.json();
  const trans = t.media?.transcodings || [];
  const prog = trans.find(x => x.format?.protocol === 'progressive') || trans[0];
  if (!prog?.url) return null;
  const rr = await fetch(`${prog.url}?client_id=${cid}`, {
    headers: { 'User-Agent': SC_UA }, signal: AbortSignal.timeout(8000),
  });
  if (!rr.ok) return null;
  const jj = await rr.json();
  return jj.url || null;
}

// If the chosen port is busy, automatically try the next ones so the
// server never crashes with a confusing EADDRINUSE stack trace.
function lanUrls(port){
  const urls = [];
  for (const ifaces of Object.values(os.networkInterfaces())){
    for (const i of ifaces || []){
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function listen(port, attemptsLeft = 10){
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0){
      console.log(`  Порт ${port} занят, пробую ${port + 1}…`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('  Не удалось запустить сервер:', err.message);
      process.exit(1);
    }
  });
  // 0.0.0.0 — доступ с телефона/других устройств в той же сети.
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n  FLOR MUSIC → http://localhost:${port}`);
    if (smtpConfigured()) console.log(`  [EMAIL] SMTP ${EMAIL.smtpHost}:${EMAIL.smtpPort}, from: ${EMAIL.from || EMAIL.smtpUser}`);
    else if (EMAIL.brevoKey) console.log(`  [EMAIL] Brevo, from: ${EMAIL.from || '(не указан!)'}`);
    else if (EMAIL.resendKey) console.log(`  [EMAIL] Resend, from: ${EMAIL.from || '(не указан!)'}`);
    else console.log('  [EMAIL] не настроена — коды выводятся в консоль сервера');
    if (PROXY.workerUrl) console.log(`  [PROXY] Cloudflare Worker → ${PROXY.workerUrl}`);
    const lan = lanUrls(port);
    if (lan.length){
      console.log('  С телефона откройте один из адресов:');
      lan.forEach(u => console.log('   ', u));
    }
    console.log('  (остановить: Ctrl+C)\n');
  });
}

listen(START_PORT);
