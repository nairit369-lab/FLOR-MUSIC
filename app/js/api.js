/* ============================================================
   FLOR MUSIC — Music providers (100% free, no API keys)
   - Audius:  full-length streaming, trending charts, search
   - iTunes:  huge mainstream catalogue, 30s previews, artwork
   Both are CORS-enabled and require no authentication or payment.
   ============================================================ */

const APP = 'FLOR-Music';

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
      const r = await fetch('/api/audius/host');
      if (r.ok){
        const j = await r.json();
        _audiusHost = j.host || null;
      }
    } catch {}
    if (!_audiusHost){
      try {
        const r = await fetch('https://api.audius.co');
        const j = await r.json();
        const hosts = (j.data || []).filter(Boolean);
        _audiusHost = hosts[Math.floor(Math.random() * Math.min(hosts.length, 3))] || hosts[0] || 'https://discoveryprovider.audius.co';
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
  const host = await audiusHost();
  // The /stream endpoint 302-redirects to the actual audio; browsers follow it.
  return `${host}/v1/tracks/${rawId}/stream?app_name=${APP}`;
}
// Synchronous variant — usable inside a user gesture once the host is known.
// (Mobile browsers block playback that starts after an `await`, so the player
//  prefers this and only falls back to the async resolver on a cold start.)
export function audiusStreamUrlSync(rawId){
  return _audiusHost ? `${_audiusHost}/v1/tracks/${rawId}/stream?app_name=${APP}` : null;
}
// Warm up the discovery-node host early so the first play can stay synchronous.
export function primeAudius(){ return audiusHost(); }

async function audiusSearch(query, limit = 30){
  const url = `/api/audius/search?query=${encodeURIComponent(query)}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Audius search ' + r.status);
  const j = await r.json();
  return (j.data || []).map(normalizeAudius).filter(Boolean);
}

export async function audiusTrending({ genre, time = 'week', limit = 16 } = {}){
  let url = `/api/audius/trending?time=${encodeURIComponent(time)}`;
  if (genre) url += `&genre=${encodeURIComponent(genre)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Audius trending ' + r.status);
  const j = await r.json();
  return (j.data || []).slice(0, limit).map(normalizeAudius).filter(Boolean);
}

export async function audiusTrendingPlaylists(limit = 10){
  try {
    const r = await fetch('/api/audius/playlists/trending');
    if (!r.ok) throw new Error('' + r.status);
    const j = await r.json();
    return (j.data || []).slice(0, limit).map(p => ({
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
  } catch { return []; }
}

export async function audiusPlaylistTracks(rawId, limit = 60){
  const url = `/api/audius/playlists/tracks?id=${encodeURIComponent(rawId)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Audius playlist ' + r.status);
  const j = await r.json();
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
  const url = `/api/itunes/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const r = await fetch(url);
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

async function youtubeSearch(query, limit = 30){
  const r = await fetch(`/api/yt/search?q=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error('YouTube search ' + r.status);
  const j = await r.json();
  return (j.items || []).slice(0, limit).map(normalizeYoutube).filter(Boolean);
}

/* ============================================================
   SoundCloud — full tracks, works in regions where YouTube is
   blocked. Search + stream resolution happen server-side.
   ============================================================ */
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
    // Server resolves the progressive stream and 302-redirects the browser to it.
    streamUrl: '/api/sc/stream?id=' + encodeURIComponent(t.id),
    isFull: true,
  };
}

async function soundcloudSearch(query, limit = 30){
  const r = await fetch(`/api/sc/search?q=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error('SoundCloud search ' + r.status);
  const j = await r.json();
  return (j.items || []).slice(0, limit).map(normalizeSoundcloud).filter(Boolean);
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
    safe(soundcloudSearch(query, Math.ceil(limit / 3))),
    safe(audiusSearch(query, Math.ceil(limit / 3))),
    safe(youtubeSearch(query, Math.ceil(limit / 3))),
    safe(itunesSearch(query, Math.ceil(limit / 4))),
  ]);
  return interleave3(sc, aud, yt, it).slice(0, limit);
}

/* ---------- helpers ---------- */
async function safe(promise){
  try { return await promise; } catch (e) { console.warn('[FLOR api]', e.message); return []; }
}

function interleave3(...lists){
  const out = []; const max = Math.max(...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}
