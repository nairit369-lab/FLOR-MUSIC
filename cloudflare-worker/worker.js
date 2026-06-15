/* FLOR MUSIC — Cloudflare Worker proxy
   Обходит блокировки YouTube / SoundCloud / Audius с RU VPS.
   Деплой: npx wrangler deploy (см. wrangler.toml) */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const APP = 'FLOR-Music';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const INVIDIOUS = [
  'https://invidious.ducks.party',
  'https://invidious.privacyredirect.com',
  'https://vid.puffyan.us',
];
const PIPED = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
];
const AUDIUS_MIRRORS = [
  'https://discoveryprovider.audius.co',
  'https://audius-mainnet.cultur3stake.com',
];

let scClientId = null, scClientIdAt = 0;
let audiusHost = null, audiusHostAt = 0;

function json(data, status = 200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

async function upFetch(url, opts = {}){
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
    ...opts,
  });
  return r;
}

/* ---------- YouTube search (Invidious) ---------- */
async function ytSearch(q){
  for (const inst of INVIDIOUS){
    try {
      const r = await upFetch(`${inst}/api/v1/search?q=${encodeURIComponent(q)}&type=video`);
      if (!r.ok) continue;
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
          author: (v.author || '').replace(/ - Topic$/, ''),
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

/* ---------- YouTube audio (Piped) ---------- */
async function ytAudioUrl(id){
  for (const inst of PIPED){
    try {
      const r = await upFetch(`${inst}/streams/${id}`);
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

/* ---------- SoundCloud ---------- */
async function scGetClientId(){
  if (scClientId && Date.now() - scClientIdAt < 6 * 60 * 60 * 1000) return scClientId;
  const html = await (await upFetch('https://soundcloud.com/')).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  const patterns = [
    /client_id\s*[:=]\s*"([a-zA-Z0-9]{20,40})"/,
    /"client_id"\s*:\s*"([a-zA-Z0-9]{20,40})"/,
  ];
  for (const src of scripts.reverse().slice(0, 8)){
    try {
      const url = src.startsWith('http') ? src : 'https://soundcloud.com' + src;
      const js = await (await upFetch(url)).text();
      for (const p of patterns){
        const m = js.match(p);
        if (m){ scClientId = m[1]; scClientIdAt = Date.now(); return scClientId; }
      }
    } catch {}
  }
  return scClientId;
}

function scArtwork(t){
  const u = t.artwork_url || t.user?.avatar_url || '';
  return u ? u.replace('-large.', '-t300x300.') : '';
}

async function scSearch(q){
  const cid = await scGetClientId();
  if (!cid) return [];
  const r = await upFetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=25&client_id=${cid}`);
  if (!r.ok) return [];
  const j = await r.json();
  const items = [];
  for (const t of (j.collection || [])){
    if (!t || t.kind !== 'track' || t.streamable === false) continue;
    const ok = (t.media?.transcodings || []).some(x => x.format?.protocol === 'progressive');
    if (!ok) continue;
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
}

async function scStreamUrl(id){
  const cid = await scGetClientId();
  if (!cid) return null;
  const r = await upFetch(`https://api-v2.soundcloud.com/tracks/${id}?client_id=${cid}`);
  if (!r.ok) return null;
  const t = await r.json();
  const prog = (t.media?.transcodings || []).find(x => x.format?.protocol === 'progressive');
  if (!prog?.url) return null;
  const rr = await upFetch(`${prog.url}?client_id=${cid}`);
  if (!rr.ok) return null;
  const j = await rr.json();
  return j.url || null;
}

/* ---------- Audius ---------- */
async function audiusGetHost(){
  if (audiusHost && Date.now() - audiusHostAt < 30 * 60 * 1000) return audiusHost;
  try {
    const r = await upFetch('https://api.audius.co');
    const j = await r.json();
    const hosts = (j.data || []).filter(Boolean);
    if (hosts.length){ audiusHost = hosts[0]; audiusHostAt = Date.now(); return audiusHost; }
  } catch {}
  for (const h of AUDIUS_MIRRORS){
    try {
      await upFetch(`${h}/v1/tracks/trending?app_name=${APP}&limit=1`);
      audiusHost = h; audiusHostAt = Date.now(); return audiusHost;
    } catch {}
  }
  audiusHost = AUDIUS_MIRRORS[0];
  audiusHostAt = Date.now();
  return audiusHost;
}

async function audiusProxy(path, params){
  const host = await audiusGetHost();
  const qs = new URLSearchParams(params);
  if (!qs.has('app_name')) qs.set('app_name', APP);
  const r = await upFetch(`${host}${path}?${qs}`);
  if (!r.ok) throw new Error('audius ' + r.status);
  return r.json();
}

export default {
  async fetch(request){
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const q = url.searchParams;

    try {
      if (path === '/' || path === '/health') return json({ ok: true, service: 'flor-music-proxy' });

      if (path === '/yt/search'){
        const items = await ytSearch(q.get('q') || '');
        return json({ items });
      }
      if (path === '/yt/audio'){
        const audioUrl = await ytAudioUrl(q.get('id') || '');
        if (!audioUrl) return json({ url: null, error: 'no audio' }, 502);
        return json({ url: audioUrl });
      }

      if (path === '/sc/search'){
        const items = await scSearch(q.get('q') || '');
        return json({ items });
      }
      if (path === '/sc/stream'){
        const media = await scStreamUrl(q.get('id') || '');
        if (!media) return json({ url: null }, 502);
        return json({ url: media });
      }

      if (path === '/audius/host') return json({ host: await audiusGetHost() });

      if (path === '/audius/search'){
        return json(await audiusProxy('/v1/tracks/search', {
          query: q.get('query') || q.get('q') || '',
          limit: q.get('limit') || '30',
        }));
      }
      if (path === '/audius/trending'){
        const p = { time: q.get('time') || 'week' };
        const genre = q.get('genre'); if (genre) p.genre = genre;
        return json(await audiusProxy('/v1/tracks/trending', p));
      }
      if (path === '/audius/playlists/trending'){
        return json(await audiusProxy('/v1/playlists/trending', {}));
      }
      if (path === '/audius/playlists/tracks'){
        const id = q.get('id') || '';
        return json(await audiusProxy(`/v1/playlists/${id}/tracks`, {}));
      }

      if (path === '/itunes/search'){
        const term = q.get('q') || '';
        const limit = q.get('limit') || '30';
        const r = await upFetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=${limit}`);
        return json(await r.json());
      }

      return json({ error: 'not found' }, 404);
    } catch (e){
      return json({ error: e.message || 'proxy error' }, 502);
    }
  },
};
