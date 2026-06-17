/* ============================================================
   FLOR MUSIC — Music providers (100% free, no API keys)
   - Audius:  full-length streaming, trending charts, search
   - iTunes:  huge mainstream catalogue, 30s previews, artwork
   Both are CORS-enabled and require no authentication or payment.
   ============================================================ */

const APP = 'FLOR-Music';

/* ============================================================
   Cloudflare Worker proxy (optional) — bypasses RU VPS blocks.
   URL задаётся в proxy-config.json на сервере → /api/config
   ============================================================ */
let _proxyBase = null;
let _proxyReady = false;

export async function loadProxyConfig(){
  if (_proxyReady) return _proxyBase;
  _proxyReady = true;
  try {
    const r = await timedFetch('/api/config', {}, 4000);
    if (r.ok){
      const j = await r.json();
      _proxyBase = (j.workerUrl || '').replace(/\/$/, '') || null;
    }
  } catch {}
  return _proxyBase;
}

async function proxyGet(path, params = {}, ms = 10000){
  const base = _proxyBase || await loadProxyConfig();
  if (!base) return null;
  const qs = new URLSearchParams(params).toString();
  const url = `${base}${path}${qs ? '?' + qs : ''}`;
  const r = await timedFetch(url, {}, ms);
  if (!r.ok) return null;
  return r.json();
}

/* Abort hung requests — without this the UI spinner never stops on slow/blocked APIs. */
async function timedFetch(url, opts = {}, ms = 8000){
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(id); }
}

async function withTimeout(promise, ms, fallback){
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

/* ---------- Source registry (drives the search tabs / profile) ---------- */
export const SOURCES = [
  { id:'all',     name:'Все источники', color:'var(--accent-2)', kind:'meta' },
  { id:'youtube', name:'YouTube',       color:'#FF0033', kind:'full',    note:'Вся музыка YouTube, целиком' },
  { id:'soundcloud', name:'SoundCloud', color:'#FF5500', kind:'full',    note:'Треки целиком, бесплатно' },
  { id:'audius',  name:'Audius',        color:'#7C4DE8', kind:'full',    note:'Треки целиком, бесплатно' },
  { id:'itunes',  name:'iTunes',        color:'#FF8FB1', kind:'preview', note:'Превью 30 секунд' },
  { id:'radio',   name:'Радио',         color:'#4EC8C0', kind:'live',    note:'Живые радиостанции' },
];

/* ============================================================
   Audius
   ============================================================ */
let _audiusHost = null;
let _audiusHostPromise = null;

async function audiusHost(){
  if (_audiusHost) return _audiusHost;
  if (_audiusHostPromise) return _audiusHostPromise;
  _audiusHostPromise = (async () => {
    try {
      const pj = await proxyGet('/audius/host', {}, 6000);
      if (pj?.host) _audiusHost = pj.host;
    } catch {}
    if (!_audiusHost){
      try {
        const r = await timedFetch('/api/audius/host', {}, 6000);
        if (r.ok){
          const j = await r.json();
          _audiusHost = j.host || null;
        }
      } catch {}
    }
    if (!_audiusHost){
      try {
        const r = await timedFetch('https://api.audius.co', {}, 5000);
        const j = await r.json();
        const hosts = (j.data || []).filter(Boolean);
        _audiusHost = hosts[0] || 'https://discoveryprovider.audius.co';
      } catch {
        _audiusHost = 'https://discoveryprovider.audius.co';
      }
    }
    return _audiusHost;
  })();
  return _audiusHostPromise;
}

/* Build an ordered list of artwork candidates. The default creatornode host
   is frequently slow/offline, so we route through its validator mirrors first
   and keep several sizes as fallbacks — the UI tries each until one loads. */
function audiusArtworkSet(art){
  if (!art) return [];
  const paths = [];
  for (const size of ['480x480', '1000x1000', '150x150']){
    if (art[size]){ try { paths.push(new URL(art[size]).pathname); } catch {} }
  }
  if (!paths.length) return [];
  let originHost = '';
  try { originHost = new URL(art['480x480'] || art['150x150']).origin; } catch {}
  const mirrors = Array.isArray(art.mirrors) ? art.mirrors.map(m => m.replace(/\/$/, '')) : [];
  const hosts = [...mirrors, originHost].filter(Boolean);
  const out = [];
  for (const h of hosts) for (const p of paths){ const u = h + p; if (!out.includes(u)) out.push(u); }
  return out.slice(0, 6);
}

function normalizeAudius(t){
  if (!t || !t.id) return null;
  const arts = audiusArtworkSet(t.artwork);
  return {
    id: 'audius:' + t.id,
    rawId: t.id,
    source: 'audius',
    title: t.title || 'Без названия',
    artist: t.user?.name || 'Неизвестный исполнитель',
    artistId: t.user?.id || null,
    album: t.genre || '',
    duration: t.duration || 0,
    artwork: arts[0] || null,
    artworkFallbacks: arts.slice(1),
    streamUrl: null,            // resolved lazily on play
    isFull: true,
    playCount: t.play_count || 0,
    permalink: t.permalink || null,
  };
}

export async function audiusStreamUrl(rawId){
  return playUrl({ source: 'audius', rawId });
}
export function audiusStreamUrlSync(rawId){
  return playUrl({ source: 'audius', rawId });
}
// Warm up the discovery-node host early so the first play can stay synchronous.
export function primeAudius(){ return audiusHost(); }

async function audiusDirect(path, params){
  const host = await audiusHost();
  const qs = new URLSearchParams(params);
  if (!qs.has('app_name')) qs.set('app_name', APP);
  const r = await timedFetch(`${host}${path}?${qs}`, {}, 10000);
  if (!r.ok) throw new Error('Audius ' + r.status);
  return r.json();
}

async function audiusFromServer(path, params){
  const proxyPath = '/audius/' + path;
  const pj = await proxyGet(proxyPath, params, 10000);
  if (pj && (pj.data || pj.results)) return pj;
  const qs = new URLSearchParams(params).toString();
  const r = await timedFetch(`/api/audius/${path}?${qs}`, {}, 10000);
  if (!r.ok) throw new Error('Audius proxy ' + r.status);
  return r.json();
}

async function audiusSearch(query, limit = 30){
  try {
    const j = await audiusFromServer('search', { query, limit });
    const items = (j.data || []).map(normalizeAudius).filter(Boolean);
    if (items.length) return items;
  } catch {}
  const j = await audiusDirect('/v1/tracks/search', { query, limit });
  return (j.data || []).map(normalizeAudius).filter(Boolean);
}

export async function audiusTrending({ genre, time = 'week', limit = 16 } = {}){
  const params = { time };
  if (genre) params.genre = genre;
  try {
    const j = await audiusFromServer('trending', params);
    const items = (j.data || []).slice(0, limit).map(normalizeAudius).filter(Boolean);
    if (items.length) return items;
  } catch {}
  const j = await audiusDirect('/v1/tracks/trending', params);
  return (j.data || []).slice(0, limit).map(normalizeAudius).filter(Boolean);
}

export async function audiusTrendingPlaylists(limit = 10){
  const mapPl = list => (list || []).slice(0, limit).map(p => ({
    id: 'pl:' + p.id,
    rawId: p.id,
    source: 'audius',
    title: p.playlist_name || 'Плейлист',
    subtitle: p.user?.name ? 'от ' + p.user.name : 'Audius',
    kind: 'Плейлист',
    artwork: audiusArtworkSet(p.artwork)[0] || null,
    artworkFallbacks: audiusArtworkSet(p.artwork).slice(1),
    desc: p.description || '',
  })).filter(p => p.title);
  try {
    const j = await audiusFromServer('playlists/trending', {});
    const items = mapPl(j.data);
    if (items.length) return items;
  } catch {}
  try {
    const j = await audiusDirect('/v1/playlists/trending', {});
    return mapPl(j.data);
  } catch { return []; }
}

export async function audiusPlaylistTracks(rawId, limit = 60){
  try {
    const j = await audiusFromServer('playlists/tracks', { id: rawId });
    const items = (j.data || []).slice(0, limit).map(normalizeAudius).filter(Boolean);
    if (items.length) return items;
  } catch {}
  const j = await audiusDirect(`/v1/playlists/${rawId}/tracks`, {});
  return (j.data || []).slice(0, limit).map(normalizeAudius).filter(Boolean);
}

/* ============================================================
   iTunes Search API
   ============================================================ */
function itunesArtworkSet(url){
  if (!url) return [];
  const big = url.replace('100x100bb', '600x600bb').replace('100x100', '600x600');
  return big === url ? [url] : [big, url];
}

function normalizeItunes(t){
  if (!t || !t.previewUrl) return null;   // skip results without playable audio
  const arts = itunesArtworkSet(t.artworkUrl100 || t.artworkUrl60);
  return {
    id: 'itunes:' + t.trackId,
    rawId: t.trackId,
    source: 'itunes',
    title: t.trackName || 'Без названия',
    artist: t.artistName || 'Неизвестный исполнитель',
    artistId: t.artistId || null,
    album: t.collectionName || '',
    duration: t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : 30,
    artwork: arts[0] || null,
    artworkFallbacks: arts.slice(1),
    streamUrl: t.previewUrl,    // direct 30s preview, ready to play
    isFull: false,
    genre: t.primaryGenreName || '',
  };
}

/* ============================================================
   Radio Browser — free live radio stations, no API key
   ============================================================ */
const RADIO_HOSTS = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://fi1.api.radio-browser.info', 'https://at1.api.radio-browser.info'];

// Radio Browser nodes can be slow/offline; time out fast and move on.
async function timedJSON(url, ms = 5000){
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': APP } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(id); }
}

function normalizeRadio(s){
  if (!s || !s.url_resolved) return null;
  const tags = (s.tags || '').split(',').filter(Boolean).slice(0, 2).join(' · ');
  return {
    id: 'radio:' + (s.stationuuid || s.url_resolved),
    rawId: s.stationuuid,
    source: 'radio',
    title: s.name?.trim() || 'Радиостанция',
    artist: [s.country, tags].filter(Boolean).join(' · ') || 'Радио',
    album: 'В эфире',
    duration: 0,                // live stream
    artwork: s.favicon || null,
    artworkFallbacks: [],
    streamUrl: s.url_resolved,
    isFull: true,
    isRadio: true,
    bitrate: s.bitrate || 0,
  };
}

async function radioSearch(query, limit = 30){
  for (const host of RADIO_HOSTS){
    try {
      const url = `${host}/json/stations/search?name=${encodeURIComponent(query)}&limit=${limit}&hidebroken=true&order=clickcount&reverse=true`;
      const j = await timedJSON(url, 5000);
      const out = (j || []).map(normalizeRadio).filter(Boolean);
      if (out.length || j) return out;
    } catch { /* try next host */ }
  }
  return [];
}

export async function radioTop(limit = 16){
  for (const host of RADIO_HOSTS){
    try {
      const j = await timedJSON(`${host}/json/stations/topclick/${limit}`, 5000);
      const out = (j || []).map(normalizeRadio).filter(Boolean);
      if (out.length) return out;
    } catch {}
  }
  return [];
}

async function itunesSearch(query, limit = 30){
  const pj = await proxyGet('/itunes/search', { q: query, limit }, 8000);
  if (pj?.results?.length) return (pj.results).map(normalizeItunes).filter(Boolean);
  const url = `/api/itunes/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const r = await timedFetch(url, {}, 8000);
  if (!r.ok) throw new Error('iTunes search ' + r.status);
  const j = await r.json();
  return (j.results || []).map(normalizeItunes).filter(Boolean);
}

/* ============================================================
   YouTube — search via our own server endpoint (no key),
   playback handled by the official IFrame player in player.js
   ============================================================ */
function normalizeYoutube(v){
  if (!v || !v.id) return null;
  return {
    id: 'youtube:' + v.id,
    rawId: v.id,
    source: 'youtube',
    title: v.title || 'Без названия',
    artist: v.author || '',
    artistId: null,
    album: '',
    duration: v.duration || 0,
    artwork: v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    artworkFallbacks: [`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`],
    // Primary playback is the IFrame player; if it fails (e.g. YouTube blocked by
    // an ISP) the player retries with a proxied audio stream from the server.
    streamUrl: null,
    isFull: true,
  };
}

const INVIDIOUS_CLIENT = [
  'https://invidious.ducks.party',
  'https://invidious.privacyredirect.com',
  'https://vid.puffyan.us',
];

const PIPED_CLIENT = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.drgns.space',
];

async function invidiousClientSearch(query, limit = 30){
  for (const inst of INVIDIOUS_CLIENT){
    try {
      const r = await timedFetch(`${inst}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, {}, 6000);
      if (!r.ok) continue;
      const j = await r.json();
      const items = [];
      for (const v of (j || [])){
        if (v.type !== 'video' || !v.videoId || !v.lengthSeconds) continue;
        const thumb = (v.videoThumbnails || []).find(t => t.quality === 'medium')?.url
          || (v.videoThumbnails || []).at(-1)?.url
          || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`;
        items.push(normalizeYoutube({
          id: v.videoId,
          title: v.title,
          author: v.author,
          duration: v.lengthSeconds,
          thumb,
        }));
        if (items.length >= limit) break;
      }
      if (items.length) return items;
    } catch {}
  }
  return [];
}

export async function youtubePipedAudioUrl(rawId){
  const pj = await proxyGet('/yt/audio', { id: rawId }, 12000);
  if (pj?.url) return pj.url;
  for (const inst of PIPED_CLIENT){
    try {
      const r = await timedFetch(`${inst}/streams/${rawId}`, {}, 10000);
      if (!r.ok) continue;
      const j = await r.json();
      const audios = (j.audioStreams || []).filter(a => a && a.url);
      if (!audios.length) continue;
      audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const isM4a = a => /mp4|m4a|mp4a/i.test(a.mimeType || a.format || '');
      const pick = audios.find(a => isM4a(a) && (a.bitrate || 0) <= 160000)
                || audios.find(isM4a) || audios[0];
      if (pick?.url) return pick.url;
    } catch {}
  }
  return null;
}

async function youtubeSearch(query, limit = 30){
  const pj = await proxyGet('/yt/search', { q: query }, 10000);
  if (pj?.items?.length) return pj.items.slice(0, limit).map(normalizeYoutube).filter(Boolean);
  const client = await invidiousClientSearch(query, limit);
  if (client.length) return client;
  try {
    const r = await timedFetch(`/api/yt/search?q=${encodeURIComponent(query)}`, {}, 8000);
    if (!r.ok) throw new Error('YouTube search ' + r.status);
    const j = await r.json();
    return (j.items || []).slice(0, limit).map(normalizeYoutube).filter(Boolean);
  } catch { return []; }
}

/* ============================================================
   SoundCloud — search + stream from the browser when the VPS
   cannot reach soundcloud.com (common on RU datacenters).
   ============================================================ */
const SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
let _scClientId = null, _scClientIdAt = 0;
const SC_CID_TTL = 6 * 60 * 60 * 1000;

async function scGetClientId(){
  if (_scClientId && Date.now() - _scClientIdAt < SC_CID_TTL) return _scClientId;
  const html = await (await timedFetch('https://soundcloud.com/', { headers: { 'User-Agent': SC_UA } }, 8000)).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  const patterns = [
    /client_id\s*[:=]\s*"([a-zA-Z0-9]{20,40})"/,
    /client_id\s*[:=]\s*'([a-zA-Z0-9]{20,40})'/,
    /"client_id"\s*:\s*"([a-zA-Z0-9]{20,40})"/,
  ];
  for (const src of scripts.reverse().slice(0, 6)){
    try {
      const url = src.startsWith('http') ? src : 'https://soundcloud.com' + src;
      const js = await (await timedFetch(url, { headers: { 'User-Agent': SC_UA } }, 5000)).text();
      for (const p of patterns){
        const m = js.match(p);
        if (m){ _scClientId = m[1]; _scClientIdAt = Date.now(); return _scClientId; }
      }
    } catch {}
  }
  return _scClientId;
}

function scArtwork(url){
  return url ? url.replace('-large.', '-t300x300.') : '';
}

function scMapTrack(t){
  if (!t || t.kind !== 'track' || t.streamable === false) return null;
  const hasProgressive = (t.media?.transcodings || []).some(x => x.format?.protocol === 'progressive');
  if (!hasProgressive) return null;
  return normalizeSoundcloud({
    id: t.id,
    title: t.title,
    author: t.user?.username || '',
    duration: Math.round((t.duration || 0) / 1000),
    thumb: scArtwork(t.artwork_url || t.user?.avatar_url),
  });
}

async function scClientSearch(query, limit = 30){
  const cid = await scGetClientId();
  if (!cid) return [];
  const r = await timedFetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}&client_id=${cid}`, { headers: { 'User-Agent': SC_UA } }, 8000);
  if (!r.ok) return [];
  const j = await r.json();
  const items = [];
  for (const t of (j.collection || [])){
    const n = scMapTrack(t);
    if (n) items.push(n);
    if (items.length >= limit) break;
  }
  return items;
}

export async function soundcloudStreamUrl(rawId){
  return playUrl({ source: 'soundcloud', rawId: String(rawId) });
}

/** Same-origin playback URL — required for background audio on iOS/PWA. */
export function playUrl(track){
  if (!track?.rawId && !track?.streamUrl) return null;
  const id = encodeURIComponent(track.rawId || '');
  if (track.source === 'audius') return `/api/audius/stream?id=${id}`;
  if (track.source === 'youtube') return `/api/yt/audio?id=${id}`;
  if (track.source === 'soundcloud') return `/api/sc/audio?id=${id}`;
  if (track.streamUrl && (track.source === 'itunes' || track.source === 'radio' || track.isRadio)){
    return `/api/external/audio?u=${encodeURIComponent(track.streamUrl)}`;
  }
  return track.streamUrl || null;
}

/* ============================================================
   Network probe — what can play from this device / server
   ============================================================ */
const PIPED_PROBE = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
];

export const netStatus = {
  probed: false,
  clientVpn: false,
  serverWorker: false,
  serverYoutube: false,
  serverAudius: true,
  youtubeOk: false,
  soundcloudOk: false,
};

async function probeClientPiped(){
  for (const base of PIPED_PROBE){
    try {
      const r = await timedFetch(`${base}/health`, {}, 4000);
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

async function probeClientSoundcloud(){
  try {
    const r = await timedFetch('https://api-v2.soundcloud.com/search/tracks?q=test&limit=1', {
      headers: { Accept: 'application/json' },
    }, 5000);
    return r.ok;
  } catch { return false; }
}

export async function probeNetwork(){
  await loadProxyConfig();
  const hasWorker = !!_proxyBase;
  const [clientVpn, clientSc, server] = await Promise.all([
    probeClientPiped(),
    probeClientSoundcloud(),
    timedFetch('/api/health/sources', {}, 8000).then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  netStatus.probed = true;
  netStatus.clientVpn = clientVpn;
  netStatus.serverWorker = !!server.worker;
  netStatus.serverYoutube = !!server.youtube;
  netStatus.serverAudius = server.audius !== false;
  // Playback goes through our server; worker fallback bypasses RU blocks.
  netStatus.youtubeOk = !!(server.worker || server.youtube || hasWorker);
  netStatus.soundcloudOk = !!(server.worker || clientSc || hasWorker);
  return netStatus;
}

export function canPlaySource(source){
  if (!netStatus.probed) return true;
  if (source === 'youtube') return netStatus.youtubeOk;
  if (source === 'soundcloud') return netStatus.soundcloudOk;
  return true;
}

export function netHint(source){
  if (!netStatus.probed) return null;
  if (source === 'youtube' && !netStatus.youtubeOk){
    if (!netStatus.serverWorker && netStatus.clientVpn){
      return 'YouTube заблокирован на сервере. Настройте Cloudflare Worker (proxy-config.json) — VPN на телефоне не помогает сам по себе.';
    }
    return 'YouTube недоступен. Настройте Cloudflare Worker на сервере или слушайте Audius / iTunes.';
  }
  if (source === 'soundcloud' && !netStatus.soundcloudOk){
    return 'SoundCloud недоступен. Включите VPN или настройте Cloudflare Worker.';
  }
  return null;
}

function normalizeSoundcloud(t){
  if (!t || t.id == null) return null;
  return {
    id: 'soundcloud:' + t.id,
    rawId: String(t.id),
    source: 'soundcloud',
    title: t.title || 'Без названия',
    artist: t.author || '',
    artistId: null,
    album: '',
    duration: t.duration || 0,
    artwork: t.thumb || '',
    artworkFallbacks: [],
    streamUrl: null,
    isFull: true,
  };
}

async function soundcloudSearch(query, limit = 30){
  const pj = await proxyGet('/sc/search', { q: query }, 10000);
  if (pj?.items?.length) return pj.items.slice(0, limit).map(normalizeSoundcloud).filter(Boolean);
  const client = await scClientSearch(query, limit);
  if (client.length) return client;
  try {
    const r = await fetch(`/api/sc/search?q=${encodeURIComponent(query)}`);
    if (!r.ok) throw new Error('SoundCloud search ' + r.status);
    const j = await r.json();
    return (j.items || []).slice(0, limit).map(normalizeSoundcloud).filter(Boolean);
  } catch { return []; }
}

/* ============================================================
   Public search — merges sources by the active tab
   ============================================================ */
export async function search(query, source = 'all', limit = 30){
  query = (query || '').trim();
  if (!query) return [];

  if (source === 'youtube')    return safe(youtubeSearch(query, limit));
  if (source === 'soundcloud') return safe(soundcloudSearch(query, limit));
  if (source === 'audius')     return safe(audiusSearch(query, limit));
  if (source === 'itunes')     return safe(itunesSearch(query, limit));
  if (source === 'radio')      return safe(radioSearch(query, limit));

  // "all" — query the main song sources in parallel and interleave.
  // SoundCloud + Audius stream directly (work even where YouTube is blocked),
  // so they lead; YouTube and iTunes follow.
  const [sc, aud, yt, it] = await Promise.all([
    safe(soundcloudSearch(query, Math.ceil(limit / 3)), 10000),
    safe(audiusSearch(query, Math.ceil(limit / 3)), 10000),
    safe(youtubeSearch(query, Math.ceil(limit / 3)), 12000),
    safe(itunesSearch(query, Math.ceil(limit / 3)), 8000),
  ]);
  return interleave3(sc, aud, yt, it).slice(0, limit);
}

const _IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* Fast home-page filler when Audius is slow or blocked. */
export async function homeWaveTracks(limit = 14){
  const ms = _IS_IOS ? 18000 : 12000;
  const [aud, it] = await Promise.all([
    withTimeout(audiusTrending({ limit }), ms, []),
    withTimeout(itunesSearch('top hits', limit), ms, []),
  ]);
  if (aud.length) return aud;
  return it;
}

function mapHomePlaylists(list, limit = 10){
  return (list || []).slice(0, limit).map(p => ({
    id: 'pl:' + p.id,
    rawId: p.id,
    source: 'audius',
    title: p.playlist_name || 'Плейлист',
    subtitle: p.user?.name ? 'от ' + p.user.name : 'Audius',
    kind: 'Плейлист',
    artwork: audiusArtworkSet(p.artwork)[0] || null,
    artworkFallbacks: audiusArtworkSet(p.artwork).slice(1),
    desc: p.description || '',
  })).filter(p => p.title);
}

/** One server round-trip for the home screen (faster on mobile networks). */
export async function fetchHomeBundle(){
  const ms = _IS_IOS ? 22000 : 16000;
  try {
    const r = await timedFetch('/api/home', {}, ms);
    if (!r.ok) return null;
    const j = await r.json();
    const trending = j.trendingSource === 'itunes'
      ? (j.trending || []).map(normalizeItunes).filter(Boolean)
      : (j.trending || []).map(normalizeAudius).filter(Boolean);
    return {
      trending,
      playlists: mapHomePlaylists(j.playlists),
      genres: [
        { label: 'Электроника в тренде', tracks: (j.electronic || []).map(normalizeAudius).filter(Boolean) },
        { label: 'Hip-Hop в тренде', tracks: (j.hiphop || []).map(normalizeAudius).filter(Boolean) },
      ],
      radio: [],
    };
  } catch { return null; }
}

/* ---------- helpers ---------- */
async function safe(promise, ms = 12000){
  try { return await withTimeout(promise, ms, []); } catch (e) { console.warn('[FLOR api]', e.message); return []; }
}

function interleave3(...lists){
  const out = []; const max = Math.max(...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}
