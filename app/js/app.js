/* ============================================================
   FLOR MUSIC — application logic (real search & playback)
   ============================================================ */
import { I } from './icons.js?v=21';
import { player } from './player.js?v=21';
import {
  SOURCES, search as apiSearch, primeAudius, loadProxyConfig, probeNetwork, netStatus, netHint,
  audiusTrending, audiusTrendingPlaylists, audiusPlaylistTracks, radioTop, homeWaveTracks,
} from './api.js?v=21';

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

/* ---------- persisted state ---------- */
const LIKED_KEY = 'flor-liked-v1';
const RECENT_KEY = 'flor-recent-v1';
const PLAYLISTS_KEY = 'flor-playlists-v1';
const WAVE_KEY = 'flor-wave-v1';
const LIB_UPDATED_KEY = 'flor-lib-updated';
const USER_KEY = 'flor-user';
const NOTIF_READ_KEY = 'flor-notif-read';

function libKey(base){ return user?.email ? `${base}:${user.email}` : base; }

const liked  = new Map(loadJSON(LIKED_KEY, []).map(t => [t.id, t]));
let   recent = loadJSON(RECENT_KEY, []);
let   playlists = loadJSON(PLAYLISTS_KEY, []);     // [{id,name,tracks:[],createdAt}]
let   user = loadJSON(USER_KEY, null);             // {name,email}
let   notifRead = new Set(loadJSON(NOTIF_READ_KEY, []));

function loadJSON(k, def){ try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch { return def; } }
function saveJSON(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function reloadLocalLibrary(){
  if (!user?.email) return;
  const pl = loadJSON(libKey(PLAYLISTS_KEY), null);
  if (pl) playlists = pl;
  const lk = loadJSON(libKey(LIKED_KEY), null);
  if (lk){ liked.clear(); lk.forEach(t => liked.set(t.id, t)); }
}

let _syncTimer = null;
function syncLibraryToServer(){
  if (!user?.email) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    const updatedAt = Date.now();
    try {
      const r = await fetch('/api/auth/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          playlists,
          liked: [...liked.values()],
          wave: loadJSON(WAVE_KEY, []),
          updatedAt,
        }),
      });
      const j = await r.json();
      if (r.ok) saveJSON(LIB_UPDATED_KEY, j.library?.updatedAt || updatedAt);
    } catch {}
  }, 700);
}

function applyLibrary(lib){
  if (!lib) return;
  const localAt = loadJSON(LIB_UPDATED_KEY, 0);
  const serverAt = lib.updatedAt || 0;
  const serverHasData = !!(lib.playlists?.length || lib.liked?.length || lib.wave?.length);
  const localHasData = !!(playlists.length || liked.size || loadJSON(WAVE_KEY, [])?.length);
  if (!serverHasData && localHasData){ syncLibraryToServer(); return; }
  if (serverAt < localAt && localHasData) return;
  if (Array.isArray(lib.playlists)){
    playlists = lib.playlists;
    saveJSON(PLAYLISTS_KEY, playlists);
    if (user?.email) saveJSON(libKey(PLAYLISTS_KEY), playlists);
  }
  if (Array.isArray(lib.liked)){
    liked.clear();
    lib.liked.forEach(t => liked.set(t.id, t));
    saveJSON(LIKED_KEY, lib.liked);
    if (user?.email) saveJSON(libKey(LIKED_KEY), lib.liked);
  }
  if (Array.isArray(lib.wave) && lib.wave.length) saveJSON(WAVE_KEY, lib.wave);
  saveJSON(LIB_UPDATED_KEY, serverAt);
  renderSidePlaylists();
}

async function loadLibraryFromServer(email){
  if (!email) return;
  try {
    const r = await fetch('/api/auth/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const j = await r.json();
    if (r.ok && j.library) applyLibrary(j.library);
  } catch {}
}

function getWaveTracks(){
  const saved = loadJSON(WAVE_KEY, null);
  if (saved?.length) return saved;
  return state.home?.trending || [];
}

function persistWave(tracks){
  if (!tracks?.length) return;
  saveJSON(WAVE_KEY, tracks.map(stripTrack));
  syncLibraryToServer();
}

function playMyWave(){
  let list = getWaveTracks();
  if (!list.length && state.home?.trending?.length){
    list = state.home.trending;
    persistWave(list);
  }
  if (!list.length){ toast('Загружаем волну…'); ensureHomeData(); return; }
  player.playQueue(list, 0);
  if (isMobile()) openFS();
}

/* ---------- in-memory state ---------- */
const state = {
  screen: 'home',
  source: 'all',
  query: '',
  results: null,
  searching: false,
  playlistCtx: null,
  home: null,
  homeLoading: false,
  fsTab: 'queue',
};

/* ============================================================
   Cover helpers — real artwork with a robust fallback chain
   ============================================================ */
function gradClass(item){
  const key = item?.id || item?.title || item?.name || item?.t || '';
  let h = 0; for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 'cv' + (h % 12 + 1);
}
function coverImg(item){
  const list = [];
  if (item?.artwork) list.push(item.artwork);
  if (Array.isArray(item?.artworkFallbacks)) list.push(...item.artworkFallbacks);
  if (!list.length) return '';
  const fb = esc(JSON.stringify(list.slice(1)));
  return `<img class="cover-img" src="${esc(list[0])}" data-fb="${fb}" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add('loaded')" onerror="window.florImgErr&&florImgErr(this)">`;
}
// Walk through fallback URLs before giving up (then the gradient shows).
window.florImgErr = function(img){
  try {
    const fb = JSON.parse(img.dataset.fb || '[]');
    if (fb.length){ img.src = fb.shift(); img.dataset.fb = JSON.stringify(fb); }
    else { img.style.display = 'none'; }
  } catch { img.style.display = 'none'; }
};

function srcTag(){ return ''; }   // source of each track is intentionally hidden
function fmt(sec){ sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }

/* ============================================================
   Reusable UI bits
   ============================================================ */
function section(title, link){
  const s = el('div', 'section');
  const h = el('div', 'sec-head');
  h.innerHTML = `<h2>${esc(title)}</h2>` + (link ? `<a>${esc(link)}</a>` : '');
  s.appendChild(h);
  return s;
}

function trackCard(track, list, idx){
  const c = el('div', 'card');
  c.innerHTML = `
    <div class="art ${gradClass(track)}">
      ${coverImg(track)}
      <div class="play-fab">${I.play}</div>
    </div>
    <div class="t">${esc(track.title)}</div>
    <div class="s">${esc(track.artist)}</div>`;
  c.querySelector('.play-fab').addEventListener('click', e => { e.stopPropagation(); player.playQueue(list || [track], idx || 0); });
  c.addEventListener('click', () => player.playQueue(list || [track], idx || 0));
  return c;
}

function playlistCard(pl){
  const c = el('div', 'card');
  c.innerHTML = `
    <div class="art ${gradClass(pl)}">
      ${coverImg(pl)}
      <div class="play-fab">${I.play}</div>
    </div>
    <div class="t">${esc(pl.title)}</div>
    <div class="s">${esc(pl.subtitle || pl.desc || 'Плейлист')}</div>`;
  const open = () => openPlaylist(pl);
  c.querySelector('.play-fab').addEventListener('click', e => { e.stopPropagation(); open(); });
  c.addEventListener('click', open);
  return c;
}

function trackRow(track, idx, list, compact, ctx){
  const r = el('div', 'track' + (compact ? ' compact' : ''));
  const isCur = player.current?.id === track.id;
  if (isCur) r.classList.add('playing');
  const isLiked = liked.has(track.id);
  const playingNow = isCur && player.playing;
  const idxCell = playingNow
    ? `<span class="eq-mini"><i></i><i></i><i></i></span>`
    : `<span class="num">${idx + 1}</span><span class="play">${isCur ? I.pause : I.play}</span>`;
  const durText = track.isRadio ? 'LIVE' : fmt(track.duration);
  const tactHtml = compact
    ? `<div class="tact tact-compact">
        <button class="addpl" title="В плейлист">${I.plus}</button>
      </div>`
    : `<div class="tact">
        <button class="like ${isLiked ? 'on' : ''}" title="Нравится">${isLiked ? I.heartFill : I.heart}</button>
        <button class="addpl" title="В плейлист">${I.plus}</button>
        <button class="more" title="Ещё">${I.more}</button>
      </div>`;
  r.innerHTML = `
    <div class="idx">${idxCell}</div>
    <div class="tcover ${gradClass(track)}">${coverImg(track)}</div>
    <div class="tinfo">
      <div class="tt-row"><div class="tt">${esc(track.title)}</div>${srcTag(track)}</div>
      <div class="ta">${esc(track.artist)}</div>
    </div>
    ${compact ? '' : `<div class="talbum">${esc(track.album || '')}</div>`}
    <div class="tdur">${durText}</div>
    ${tactHtml}`;
  r._trackId = track.id;
  r.addEventListener('click', () => player.playQueue(list, idx));
  const lk = r.querySelector('.like');
  if (lk) lk.addEventListener('click', e => { e.stopPropagation(); toggleLike(track); });
  const ap = r.querySelector('.addpl');
  if (ap) ap.addEventListener('click', e => { e.stopPropagation(); quickAddToPlaylist(track, ap); });
  const mr = r.querySelector('.more');
  if (mr) mr.addEventListener('click', e => { e.stopPropagation(); openTrackMenu(track, mr, ctx); });
  return r;
}

function skeletonRow(n = 6){
  const row = el('div', 'skeleton-row');
  for (let i = 0; i < n; i++){
    const c = el('div', 'sk-card');
    c.innerHTML = `<div class="sk"></div><div class="sk-line"></div><div class="sk-line short"></div>`;
    row.appendChild(c);
  }
  return row;
}

function centerState({ icon = I.music, title, sub, spinner }){
  const s = el('div', 'center-state');
  s.innerHTML = `${spinner ? '<div class="spinner"></div>' : `<div style="width:34px;height:34px;color:var(--text-3)">${icon}</div>`}
    <div class="cs-title">${esc(title)}</div>${sub ? `<div class="cs-sub">${esc(sub)}</div>` : ''}`;
  return s;
}

function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// App icon (rounded square) used wherever we show the FLOR mark.
function logoImg(size){ return `<img src="assets/flor-logo.png" width="${size}" height="${size}" alt="FLOR" style="border-radius:${Math.round(size * 0.24)}px;display:block;object-fit:cover">`; }

/* ============================================================
   Screens — Home
   ============================================================ */
function renderHome(){
  const wrap = el('div');
  const hour = new Date().getHours();
  const greet = hour < 6 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
  const name = user?.name ? ', ' + user.name.split(' ')[0] : '';
  wrap.innerHTML = `<div class="greeting">${esc(greet + name)}</div>`;

  const hero = el('div', 'hero-wave');
  hero.innerHTML = `
    <div class="glow"></div>
    <div class="equalizer"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="eyebrow">Персональный поток</div>
    <h1>Моя волна</h1>
    <p>Бесконечная музыка — в едином потоке, бесплатно и без подписок.</p>
    <div class="h-actions">
      <button class="btn-glass solid">${I.play} Слушать</button>
      <button class="btn-glass" id="heroSearch">${I.search} Найти музыку</button>
    </div>`;
  hero.querySelector('.btn-glass.solid').addEventListener('click', () => playMyWave());
  hero.querySelector('#heroSearch').addEventListener('click', () => go('search'));
  const heroSec = el('div', 'section'); heroSec.appendChild(hero); wrap.appendChild(heroSec);

  if (recent.length){
    const sR = section('Вы недавно слушали');
    const row = el('div', 'row');
    recent.slice(0, 10).forEach((t, i) => row.appendChild(trackCard(t, recent, i)));
    sR.appendChild(row); wrap.appendChild(sR);
  }

  // Quick access: Liked + user playlists
  if (liked.size || playlists.length){
    const q = el('div', 'section');
    const grid = el('div', 'quick-grid');
    const fav = el('div', 'quick');
    fav.innerHTML = `<div class="qc" style="background:linear-gradient(135deg,#A78BFA,#6C3CE0);display:grid;place-items:center"><div style="width:24px;height:24px;color:#fff">${I.heartFill}</div></div><div class="qt">Любимое</div><div class="qplay">${I.play}</div>`;
    fav.querySelector('.qplay').addEventListener('click', e => { e.stopPropagation(); player.playQueue([...liked.values()], 0); });
    fav.addEventListener('click', () => openPlaylist({ id: 'liked', title: 'Любимое', kind: 'Плейлист' }));
    grid.appendChild(fav);
    playlists.slice(0, 5).forEach(p => {
      const item = el('div', 'quick');
      item.innerHTML = `<div class="qc ${gradClass(p)}">${coverImg(firstCover(p))}</div><div class="qt">${esc(p.name)}</div><div class="qplay">${I.play}</div>`;
      item.querySelector('.qplay').addEventListener('click', e => { e.stopPropagation(); if (p.tracks?.length) player.playQueue(p.tracks, 0); else toast('Плейлист пуст'); });
      item.addEventListener('click', () => openUserPlaylist(p.id));
      grid.appendChild(item);
    });
    q.appendChild(grid); wrap.appendChild(q);
  }

  const dyn = el('div'); dyn.id = 'homeDynamic';
  wrap.appendChild(dyn);
  fillHome(dyn);
  return wrap;
}

// playlist cover = its first track's artwork (so user playlists look distinct)
function firstCover(p){
  const t = p.tracks?.find(x => x.artwork);
  return { id: p.id, artwork: t?.artwork, artworkFallbacks: t?.artworkFallbacks };
}

async function fillHome(host){
  const render = () => {
    host.innerHTML = '';
    const h = state.home;
    if (!h){
      const s = section('В тренде'); s.appendChild(skeletonRow()); host.appendChild(s);
      const s2 = section('Собрано для вас'); s2.appendChild(skeletonRow()); host.appendChild(s2);
      return;
    }
    if (h.trending?.length){
      const s = section('В тренде на этой неделе', 'Слушать');
      s.querySelector('a').addEventListener('click', () => player.playQueue(h.trending, 0));
      const row = el('div', 'row');
      h.trending.forEach((t, i) => row.appendChild(trackCard(t, h.trending, i)));
      s.appendChild(row); host.appendChild(s);
    }
    if (h.playlists?.length){
      const s = section('Собрано для вас');
      const row = el('div', 'row');
      h.playlists.forEach(p => row.appendChild(playlistCard(p)));
      s.appendChild(row); host.appendChild(s);
    }
    (h.genres || []).forEach(g => {
      if (!g.tracks?.length) return;
      const s = section(g.label);
      const row = el('div', 'row');
      g.tracks.forEach((t, i) => row.appendChild(trackCard(t, g.tracks, i)));
      s.appendChild(row); host.appendChild(s);
    });
    if (h.radio?.length){
      const s = section('Популярное радио');
      const row = el('div', 'row');
      h.radio.forEach((t, i) => row.appendChild(trackCard(t, h.radio, i)));
      s.appendChild(row); host.appendChild(s);
    }
  };

  render();
  if (state.home || state.homeLoading) return;
  state.homeLoading = true;
  try {
    const slice = (p, ms = 10000) => Promise.race([
      p,
      new Promise(resolve => setTimeout(() => resolve([]), ms)),
    ]);
    const [trending, plists, electronic, hiphop] = await Promise.all([
      homeWaveTracks(14),
      slice(audiusTrendingPlaylists(10)),
      slice(audiusTrending({ genre: 'Electronic', limit: 12 })),
      slice(audiusTrending({ genre: 'Hip-Hop/Rap', limit: 12 })),
    ]);
    state.home = {
      trending, playlists: plists,
      genres: [
        { label: 'Электроника в тренде', tracks: electronic },
        { label: 'Hip-Hop в тренде', tracks: hiphop },
      ],
      radio: [],
    };
    buildNotifications();
  } catch (e){
    console.warn(e);
    state.home = { trending: [], playlists: [], genres: [], radio: [] };
    toast('Часть источников недоступна — показываем что удалось загрузить');
  } finally {
    state.homeLoading = false;
    if (state.screen === 'home') render();
  }

  // Radio loads independently and is appended when (and if) it arrives.
  radioTop(12).then(radio => {
    if (state.home && radio.length){ state.home.radio = radio; if (state.screen === 'home') render(); }
  }).catch(() => {});
}

/* ============================================================
   Screens — Search
   ============================================================ */
const GENRES = [
  { t:'Электроника', q:'Electronic' }, { t:'Hip-Hop', q:'Hip-Hop' }, { t:'Lo-fi', q:'lofi' },
  { t:'Поп', q:'pop hits' }, { t:'Рок', q:'rock' }, { t:'Джаз', q:'jazz' },
  { t:'Чилл', q:'chill' }, { t:'Танцевальная', q:'dance' }, { t:'Инструментал', q:'instrumental' },
  { t:'Классика', q:'classical' }, { t:'Для тренировки', q:'workout' }, { t:'Acoustic', q:'acoustic' },
];

function renderSearch(){
  const wrap = el('div');
  const big = el('div', 'bigsearch');
  big.innerHTML = `${I.search}<input id="bigSearch" placeholder="Трек, исполнитель или жанр">`;
  big.style.marginBottom = '22px';
  wrap.appendChild(big);

  const resultsHost = el('div'); resultsHost.id = 'searchResults';
  wrap.appendChild(resultsHost);

  if (state.query){
    renderResults(resultsHost);
  } else {
    const s1 = section('Обзор жанров');
    const g = el('div', 'genre-grid');
    GENRES.forEach(ge => {
      const item = el('div', 'genre ' + gradClass({ id: ge.t }));
      item.innerHTML = `<h3>${ge.t}</h3>`;
      item.addEventListener('click', () => { setQuery(ge.q); });
      g.appendChild(item);
    });
    s1.appendChild(g); wrap.appendChild(s1);
  }

  setTimeout(() => {
    const input = $('#bigSearch');
    if (input){
      input.value = state.query;
      input.addEventListener('input', e => { mirrorSearch(e.target.value); debouncedSearch(e.target.value); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(e.target.value); });
      if (state.query) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  }, 0);
  return wrap;
}

function renderResults(host){
  host.innerHTML = '';
  if (isMobile()){ const g = document.getElementById('mGenres'); if (g) g.remove(); }
  if (state.searching && !state.results){
    host.appendChild(centerState({ spinner: true, title: 'Ищем музыку…', sub: `«${state.query}»` }));
    return;
  }
  if (state.results && state.results.length === 0){
    host.appendChild(centerState({ title: 'Ничего не найдено', sub: `По запросу «${state.query}» нет результатов. Попробуйте другую формулировку.` }));
    return;
  }
  if (!state.results) return;

  if (isMobile()){
    const head = el('div'); head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:4px 0 14px';
    head.innerHTML = `<div class="m-sec-t" style="margin:0">Результаты</div><span style="font-size:12.5px;color:var(--text-3)">${state.results.length}</span>`;
    host.appendChild(head);
    const playBtn = el('button', 'm-pl-play'); playBtn.style.cssText = 'width:48px;height:48px;margin-bottom:8px'; playBtn.innerHTML = mIc('play', 22, '#fff');
    playBtn.addEventListener('click', () => { player.playQueue(state.results, 0); openFS(); });
    host.appendChild(playBtn);
    const tl = el('div');
    state.results.forEach((t, i) => tl.appendChild(mTrackRow(t, state.results, i)));
    host.appendChild(tl);
    return;
  }

  const head = el('div', 'search-results-head');
  head.innerHTML = `<h2>Результаты</h2><span class="count">${state.results.length} · «${esc(state.query)}»</span>`;
  host.appendChild(head);

  const actions = el('div', 'pl-actions');
  actions.style.margin = '4px 0 14px';
  actions.innerHTML = `<button class="btn-play-lg">${I.play}</button>
    <button class="btn-ghost" title="Перемешать">${I.shuffle}</button>`;
  actions.querySelector('.btn-play-lg').addEventListener('click', () => player.playQueue(state.results, 0));
  actions.querySelector('.btn-ghost').addEventListener('click', () => { if (!player.shuffle) player.toggleShuffle(); player.playQueue(state.results, Math.floor(Math.random() * state.results.length)); });
  host.appendChild(actions);

  const tl = el('div', 'tracklist');
  state.results.forEach((t, i) => tl.appendChild(trackRow(t, i, state.results)));
  host.appendChild(tl);
}

/* ============================================================
   Screens — Library
   ============================================================ */
function renderLibrary(){
  const wrap = el('div');
  const top = el('div'); top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap';
  top.innerHTML = `<div class="greeting">Моя медиатека</div>`;
  const newBtn = el('button', 'btn-ghost txt');
  newBtn.innerHTML = `${I.plus} Новый плейлист`;
  newBtn.addEventListener('click', () => openCreatePlaylistModal());
  top.appendChild(newBtn);
  wrap.appendChild(top);

  const tabs = el('div', 'lib-tabs');
  const views = [['playlists', 'Плейлисты'], ['liked', 'Любимое'], ['recent', 'Недавние']];
  const body = el('div'); body.id = 'libBody';
  let active = wrap._view || 'playlists';
  views.forEach(([id, label]) => {
    const c = el('button', 'chip' + (id === active ? ' active' : ''));
    c.textContent = label;
    c.addEventListener('click', () => { wrap._view = id; tabs.querySelectorAll('.chip').forEach(x => x.classList.remove('active')); c.classList.add('active'); fillLib(body, id); });
    tabs.appendChild(c);
  });
  wrap.appendChild(tabs); wrap.appendChild(body);
  fillLib(body, active);
  return wrap;
}

function fillLib(host, view){
  host.innerHTML = '';
  if (view === 'playlists'){
    const grid = el('div', 'grid-cards');
    const fav = el('div', 'card');
    fav.innerHTML = `<div class="art" style="background:linear-gradient(135deg,#A78BFA,#6C3CE0);display:grid;place-items:center"><div style="color:#fff;width:54px;height:54px">${I.heartFill}</div><div class="play-fab">${I.play}</div></div><div class="t">Любимое</div><div class="s">${liked.size} треков</div>`;
    fav.querySelector('.play-fab').addEventListener('click', e => { e.stopPropagation(); player.playQueue([...liked.values()], 0); });
    fav.addEventListener('click', () => openPlaylist({ id: 'liked', title: 'Любимое', kind: 'Плейлист' }));
    grid.appendChild(fav);
    playlists.forEach(p => {
      const c = el('div', 'card');
      c.innerHTML = `<div class="art ${gradClass(p)}">${coverImg(firstCover(p))}<div class="play-fab">${I.play}</div></div><div class="t">${esc(p.name)}</div><div class="s">${p.tracks.length} треков</div>`;
      c.querySelector('.play-fab').addEventListener('click', e => { e.stopPropagation(); if (p.tracks.length) player.playQueue(p.tracks, 0); else toast('Плейлист пуст'); });
      c.addEventListener('click', () => openUserPlaylist(p.id));
      grid.appendChild(c);
    });
    host.appendChild(grid);
    if (!playlists.length){
      const hint = el('div'); hint.style.cssText = 'color:var(--text-3);font-size:14px;margin-top:18px';
      hint.textContent = 'Создайте свой первый плейлист кнопкой «Новый плейлист».';
      host.appendChild(hint);
    }
    return;
  }
  const list = view === 'liked' ? [...liked.values()] : recent;
  if (!list.length){
    host.appendChild(centerState({
      icon: view === 'liked' ? I.heart : I.clock,
      title: view === 'liked' ? 'Пока нет любимых треков' : 'История пуста',
      sub: view === 'liked' ? 'Нажимайте на сердечко рядом с треком — он появится здесь.' : 'Включите любой трек, и он окажется в недавних.',
    }));
    return;
  }
  if (view === 'liked'){
    const head = el('div', 'pl-actions'); head.style.margin = '4px 0 16px';
    head.innerHTML = `<button class="btn-play-lg">${I.play}</button><span style="color:var(--text-2);font-weight:600">${list.length} треков</span>`;
    head.querySelector('.btn-play-lg').addEventListener('click', () => player.playQueue(list, 0));
    host.appendChild(head);
  }
  const tl = el('div', 'tracklist');
  list.forEach((t, i) => tl.appendChild(trackRow(t, i, list)));
  host.appendChild(tl);
}

/* ============================================================
   Screens — Playlist
   ============================================================ */
async function renderPlaylist(ctx){
  const wrap = el('div');
  const isLiked = ctx.id === 'liked';
  const isUser = typeof ctx.id === 'string' && ctx.id.startsWith('user:');
  const userPl = isUser ? playlists.find(p => p.id === ctx.id) : null;
  const titleText = userPl ? userPl.name : ctx.title;

  const head = el('div', 'pl-header');
  const coverInner = isLiked
    ? `<div style="width:100%;height:100%;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#A78BFA,#6C3CE0)"><div style="width:72px;height:72px">${I.heartFill}</div></div>`
    : (userPl ? coverImg(firstCover(userPl)) : coverImg(ctx));
  head.innerHTML = `
    <div class="big-cover ${gradClass(userPl || ctx)}">${coverInner}</div>
    <div class="meta">
      <div class="kind">${esc(userPl ? 'Ваш плейлист' : (ctx.kind || 'Плейлист'))}</div>
      <h1>${esc(titleText)}</h1>
      <div class="desc">${esc(ctx.desc || ctx.subtitle || '')}</div>
      <div class="stats"><b>${esc(user?.name || 'FLOR')}</b><span class="dot"></span><span id="plCount">…</span></div>
    </div>`;
  wrap.appendChild(head);

  const actions = el('div', 'pl-actions');
  actions.innerHTML = `
    <button class="btn-play-lg">${I.play}</button>
    <button class="btn-ghost" title="Перемешать">${I.shuffle}</button>
    ${isUser ? `<button class="btn-ghost" id="plRename" title="Переименовать">${I.edit}</button>` : ''}
    ${isUser ? `<button class="btn-ghost danger" id="plDelete" title="Удалить плейлист">${I.trash}</button>` : ''}`;
  wrap.appendChild(actions);

  const body = el('div'); body.id = 'plBody';
  body.appendChild(centerState({ spinner: true, title: 'Загружаем треки…' }));
  wrap.appendChild(body);

  let tracks = [];
  try {
    if (isLiked) tracks = [...liked.values()];
    else if (userPl) tracks = userPl.tracks;
    else if (ctx.tracks) tracks = ctx.tracks;
    else if (ctx.rawId) tracks = await audiusPlaylistTracks(ctx.rawId);
  } catch (e){ console.warn(e); }

  body.innerHTML = '';
  const countEl = wrap.querySelector('#plCount');
  if (countEl) countEl.textContent = `${tracks.length} треков`;
  if (!tracks.length){
    body.appendChild(centerState({ title: 'Здесь пока пусто', sub: isUser ? 'Добавьте треки кнопкой «+» рядом с любым треком.' : (isLiked ? 'Добавьте любимые треки.' : 'Не удалось получить треки.') }));
  } else {
    const th = el('div', 'track-head');
    th.innerHTML = `<div>#</div><div></div><div>Название</div><div>Альбом</div><div class="r">${I.clock}</div><div></div>`;
    th.querySelector('.r').style.cssText = 'display:flex;justify-content:flex-end';
    const svg = th.querySelector('.r svg'); if (svg) svg.style.cssText = 'width:16px;height:16px';
    body.appendChild(th);
    const tl = el('div', 'tracklist');
    tracks.forEach((t, i) => tl.appendChild(trackRow(t, i, tracks, false, isUser ? { playlistId: ctx.id } : null)));
    body.appendChild(tl);
  }
  actions.querySelector('.btn-play-lg').addEventListener('click', () => tracks.length && player.playQueue(tracks, 0));
  actions.querySelector('.btn-ghost').addEventListener('click', () => { if (tracks.length){ if (!player.shuffle) player.toggleShuffle(); player.playQueue(tracks, Math.floor(Math.random() * tracks.length)); } });
  const del = wrap.querySelector('#plDelete');
  if (del) del.addEventListener('click', () => {
    if (confirm('Удалить этот плейлист?')){ deletePlaylist(ctx.id); toast('Плейлист удалён'); go('library'); }
  });
  const ren = wrap.querySelector('#plRename');
  if (ren) ren.addEventListener('click', () => openRenamePlaylistModal(ctx.id));
  return wrap;
}

/* ============================================================
   Screens — Profile (with account / auth)
   ============================================================ */
function renderProfile(){
  const wrap = el('div', 'settings');
  const top = el('div', 'profile-top');
  top.innerHTML = `
    <div class="avatar-wrap">
      ${avatarHTML(104, 'pa', 'Сменить фото')}
      <div class="av-badge" title="Сменить фото">${I.camera}</div>
    </div>
    <div>
      <div class="kind" style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text-3)">Профиль</div>
      <h1>${esc(user?.name || 'Гость')}</h1>
      <div class="ps">${user ? `${esc(user.email)} · ` : ''}<b>${liked.size}</b> любимых · <b>${playlists.length}</b> плейлистов · <b>FLOR Free</b></div>
      ${user ? `<button type="button" class="avatar-edit-btn" id="avChangeBtn">${I.camera} Сменить фото</button>` : ''}
    </div>`;
  top.querySelector('.pa').addEventListener('click', () => openAvatarModal());
  top.querySelector('.av-badge')?.addEventListener('click', () => openAvatarModal());
  top.querySelector('#avChangeBtn')?.addEventListener('click', () => openAvatarModal());
  wrap.appendChild(top);

  // Account
  const ga = el('div', 'set-group');
  ga.innerHTML = `<h3>Аккаунт</h3>`;
  const accRow = el('div', 'set-row'); accRow.style.cursor = 'pointer';
  if (user){
    accRow.innerHTML = `<div class="si" style="background:var(--accent-soft);color:var(--accent-2)">${I.user}</div><div class="st"><div class="a">Выйти из аккаунта</div><div class="b">${esc(user.email)}</div></div>`;
    accRow.addEventListener('click', () => { logout(); toast('Вы вышли из аккаунта'); render(); });
    ga.appendChild(accRow);
    const pwRow = el('div', 'set-row'); pwRow.style.cursor = 'pointer';
    pwRow.innerHTML = `<div class="si" style="background:var(--accent-soft);color:var(--accent-2)">${I.lock}</div><div class="st"><div class="a">Сменить пароль</div><div class="b">Нужен текущий пароль</div></div>`;
    pwRow.addEventListener('click', () => openChangePasswordModal());
    ga.appendChild(pwRow);
  } else {
    accRow.innerHTML = `<div class="si" style="background:var(--accent-soft);color:var(--accent-2)">${I.user}</div><div class="st"><div class="a">Войти или зарегистрироваться</div><div class="b">Сохраняйте профиль на этом устройстве</div></div><div class="badge" style="background:var(--accent);color:#fff">Войти</div>`;
    accRow.addEventListener('click', () => openAuthModal());
    ga.appendChild(accRow);
  }
  wrap.appendChild(ga);

  // Appearance
  const g2 = el('div', 'set-group');
  g2.innerHTML = `<h3>Внешний вид</h3>`;
  const themeRow = el('div', 'set-row');
  themeRow.innerHTML = `
    <div class="si" style="background:var(--accent-soft);color:var(--accent-2)">${I.moon}</div>
    <div class="st"><div class="a">Тема оформления</div><div class="b">Светлая или тёмная</div></div>
    <div class="seg"><button data-t="dark">Тёмная</button><button data-t="light">Светлая</button></div>`;
  themeRow.querySelectorAll('.seg button').forEach(b => {
    if (b.dataset.t === document.documentElement.dataset.theme) b.classList.add('on');
    b.addEventListener('click', () => setTheme(b.dataset.t));
  });
  g2.appendChild(themeRow);
  wrap.appendChild(g2);

  // Data
  const g3 = el('div', 'set-group');
  g3.innerHTML = `<h3>Данные</h3>`;
  const clearRow = el('div', 'set-row'); clearRow.style.cursor = 'pointer';
  clearRow.innerHTML = `<div class="si" style="background:var(--hover);color:var(--text-2)">${I.trash}</div><div class="st"><div class="a">Очистить любимое, плейлисты и историю</div><div class="b">Удаляет данные из этого браузера</div></div>`;
  clearRow.addEventListener('click', () => {
    if (!confirm('Очистить любимое, плейлисты и историю?')) return;
    liked.clear(); recent = []; playlists = [];
    saveJSON(LIKED_KEY, []); saveJSON(RECENT_KEY, []); saveJSON(PLAYLISTS_KEY, []); saveJSON(WAVE_KEY, []);
    if (user?.email){ saveJSON(libKey(PLAYLISTS_KEY), []); saveJSON(libKey(LIKED_KEY), []); }
    syncLibraryToServer();
    toast('Данные очищены'); render();
  });
  g3.appendChild(clearRow); wrap.appendChild(g3);
  return wrap;
}

/* ============================================================
   MOBILE UI — faithful port of the phone design (mobile-app.jsx),
   wired to the real player, library and search.
   ============================================================ */
function isMobile(){ return window.matchMedia('(max-width: 760px)').matches; }

function mIc(name, size = 22, color = 'currentColor'){
  return `<span class="ic" style="width:${size}px;height:${size}px;color:${color}">${I[name] || ''}</span>`;
}
function mCover(item, size, radius = 12, inner){
  const dim = `width:${size}px;height:${size}px;border-radius:${radius}px`;
  return `<div class="cv ${gradClass(item)}" style="${dim}">${inner != null ? inner : coverImg(item)}</div>`;
}
function mLabel(text){ const d = el('div', 'm-seclbl'); d.textContent = text; return d; }

function ensureHomeData(){
  if (state.home || state.homeLoading) return;
  state.homeLoading = true;
  (async () => {
    try {
      const slice = (p, ms = 10000) => Promise.race([
        p,
        new Promise(resolve => setTimeout(() => resolve([]), ms)),
      ]);
      const [trending, plists, electronic, hiphop] = await Promise.all([
        homeWaveTracks(14),
        slice(audiusTrendingPlaylists(10)),
        slice(audiusTrending({ genre: 'Electronic', limit: 12 })),
        slice(audiusTrending({ genre: 'Hip-Hop/Rap', limit: 12 })),
      ]);
      state.home = { trending, playlists: plists,
        genres: [{ label: 'Электроника в тренде', tracks: electronic }, { label: 'Hip-Hop в тренде', tracks: hiphop }],
        radio: [] };
      if (trending?.length && !loadJSON(WAVE_KEY, null)?.length) persistWave(trending);
      buildNotifications();
    } catch (e){
      console.warn(e);
      state.home = { trending: [], playlists: [], genres: [], radio: [] };
    } finally { state.homeLoading = false; if (state.screen === 'home') render(); }
    radioTop(12).then(radio => { if (state.home && radio.length){ state.home.radio = radio; if (state.screen === 'home') render(); } }).catch(() => {});
  })();
}

function mHomeHeader(greetText){
  const head = el('div', 'm-top');
  head.innerHTML = `<div class="m-greet">${esc(greetText)}</div>
    <div class="m-acts">
      <button class="m-ibtn" id="mBell">${mIc('bell', 20, 'var(--text-2)')}${unreadCount() ? '<span class="m-dot"></span>' : ''}</button>
      <div class="m-av${user?.avatar ? ' has-img' : ''}" id="mAv">${user?.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(userInitial())}</div>
    </div>`;
  head.querySelector('#mBell').addEventListener('click', e => { e.stopPropagation(); toggleNotifPanel(); });
  head.querySelector('#mAv').addEventListener('click', () => go('profile'));
  return head;
}

function mTrackRow(track, list, idx, ctx){
  const isCur = player.current?.id === track.id;
  const isLiked = liked.has(track.id);
  const r = el('div', 'm-trow' + (isCur ? ' cur' : ''));
  r.innerHTML = `${mCover(track, 46, 9)}
    <div class="tw"><div class="tt">${esc(track.title)}</div><div class="ta">${esc(track.artist)}</div></div>
    <div class="lk ${isLiked ? 'on' : ''}">${mIc(isLiked ? 'heartFill' : 'heart', 19)}</div>
    <button class="maddpl" title="В плейлист">${mIc('plus', 20, 'var(--accent-2)')}</button>
    <button class="mmore" title="Ещё">${mIc('more', 20)}</button>`;
  r.addEventListener('click', () => player.playQueue(list, idx));
  const lk = r.querySelector('.lk');
  lk.addEventListener('click', e => {
    e.stopPropagation(); toggleLike(track);
    const on = liked.has(track.id); lk.classList.toggle('on', on); lk.innerHTML = mIc(on ? 'heartFill' : 'heart', 19);
  });
  const add = r.querySelector('.maddpl');
  add.addEventListener('click', e => { e.stopPropagation(); quickAddToPlaylist(track, add); });
  const more = r.querySelector('.mmore');
  more.addEventListener('click', e => { e.stopPropagation(); openTrackMenu(track, more, ctx); });
  return r;
}

function mRow(title, items, kind){
  const s = el('div', 'm-sec');
  const t = el('div', 'm-sec-t'); t.textContent = title; s.appendChild(t);
  const hs = el('div', 'm-hs mscroll');
  items.forEach((it, i) => {
    const card = el('div', 'm-card');
    if (kind === 'playlist'){
      card.innerHTML = `${mCover(it, 130, 14)}<div class="ct">${esc(it.title)}</div><div class="cs">${esc(it.subtitle || it.desc || 'Плейлист')}</div>`;
      card.addEventListener('click', () => openPlaylist(it));
    } else {
      card.innerHTML = `${mCover(it, 130, 14)}<div class="ct">${esc(it.title)}</div><div class="cs">${esc(it.artist || '')}</div>`;
      card.addEventListener('click', () => player.playQueue(items, i));
    }
    hs.appendChild(card);
  });
  s.appendChild(hs);
  return s;
}

function renderMHome(){
  ensureHomeData();
  const w = el('div', 'mscreen');
  const hour = new Date().getHours();
  const greet = hour < 6 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
  w.appendChild(mHomeHeader(greet + (user?.name ? ', ' + user.name.split(' ')[0] : '')));

  const hero = el('div', 'm-hero');
  hero.innerHTML = `
    <div class="eyebrow">ПЕРСОНАЛЬНЫЙ ПОТОК</div>
    <h1>Моя волна</h1>
    <p>Музыка под настроение — в одном бесконечном потоке.</p>
    <div class="hrow">
      <button class="m-hbtn white" id="mPlayWave">${mIc('play', 16, '#3A1C8C')} Слушать</button>
      <button class="m-hbtn glass" id="mFindWave">${mIc('search', 16, '#fff')} Найти</button>
    </div>`;
  hero.querySelector('#mPlayWave').addEventListener('click', () => playMyWave());
  hero.querySelector('#mFindWave').addEventListener('click', () => go('search'));
  w.appendChild(hero);

  // quick 2x2 grid: Любимое + playlists
  const quick = el('div', 'm-quick');
  const fav = el('div', 'm-qtile');
  fav.innerHTML = `<div class="cv" style="width:48px;height:48px;background:linear-gradient(135deg,#A78BFA,#6C3CE0)"><div>${mIc('heartFill', 22, '#fff')}</div></div><span class="m-qname">Любимое</span>`;
  fav.addEventListener('click', () => openPlaylist({ id: 'liked', title: 'Любимое', kind: 'Плейлист' }));
  quick.appendChild(fav);
  const tiles = [];
  playlists.forEach(p => tiles.push({ user: p }));
  (state.home?.playlists || []).forEach(p => tiles.push({ audius: p }));
  tiles.slice(0, 3).forEach(o => {
    const t = el('div', 'm-qtile');
    if (o.audius){ const a = o.audius; t.innerHTML = `${mCover(a, 48, 0)}<span class="m-qname">${esc(a.title)}</span>`; t.addEventListener('click', () => openPlaylist(a)); }
    else { const p = o.user; t.innerHTML = `${mCover(firstCover(p), 48, 0)}<span class="m-qname">${esc(p.name)}</span>`; t.addEventListener('click', () => openUserPlaylist(p.id)); }
    quick.appendChild(t);
  });
  w.appendChild(quick);

  if (recent.length) w.appendChild(mRow('Вы недавно слушали', recent.slice(0, 10), 'track'));
  if (state.home?.trending?.length) w.appendChild(mRow('Новинки недели', state.home.trending, 'track'));
  if (state.home?.playlists?.length) w.appendChild(mRow('Собрано для вас', state.home.playlists, 'playlist'));
  (state.home?.genres || []).forEach(g => { if (g.tracks?.length) w.appendChild(mRow(g.label, g.tracks, 'track')); });
  if (state.home?.radio?.length) w.appendChild(mRow('Популярное радио', state.home.radio, 'track'));
  if (state.homeLoading) w.appendChild(centerState({ spinner: true, title: 'Загружаем…' }));
  else if (!state.home?.trending?.length && !state.home?.playlists?.length && !state.home?.radio?.length){
    w.appendChild(centerState({ title: 'Пока нет треков', sub: 'Попробуйте поиск или радио ниже' }));
  }
  return w;
}

function renderMSearch(){
  const w = el('div', 'mscreen');
  const h1 = el('div', 'm-h1'); h1.textContent = 'Поиск'; w.appendChild(h1);
  const box = el('div', 'm-searchbox');
  box.innerHTML = `${mIc('search', 21, 'var(--text-3)')}<input id="bigSearch" placeholder="Трек, исполнитель или жанр">`;
  w.appendChild(box);
  const results = el('div'); results.id = 'searchResults'; w.appendChild(results);

  if (state.query){ renderResults(results); }
  else {
    const sec = el('div'); sec.id = 'mGenres'; const st = el('div', 'm-sec-t'); st.textContent = 'Обзор жанров'; sec.appendChild(st);
    const grid = el('div', 'm-genres');
    GENRES.forEach(g => {
      const t = el('div', 'm-genre ' + gradClass({ id: g.t }));
      t.innerHTML = `<h3>${esc(g.t)}</h3><div class="deco"></div>`;
      t.addEventListener('click', () => setQuery(g.q));
      grid.appendChild(t);
    });
    sec.appendChild(grid); w.appendChild(sec);
  }
  setTimeout(() => {
    const input = $('#bigSearch');
    if (input){
      input.value = state.query;
      input.addEventListener('input', e => { mirrorSearch(e.target.value); debouncedSearch(e.target.value); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(e.target.value); });
      if (state.query){ input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  }, 0);
  return w;
}

function renderMLibrary(){
  const w = el('div', 'mscreen');
  const head = el('div', 'm-top');
  const h1 = el('div', 'm-h1'); h1.style.margin = '0'; h1.textContent = 'Медиатека'; head.appendChild(h1);
  const add = el('button', 'm-ibtn'); add.innerHTML = mIc('plus', 22, 'var(--text-2)');
  add.addEventListener('click', () => openCreatePlaylistModal());
  head.appendChild(add); w.appendChild(head);

  const tabs = el('div', 'm-ltabs mscroll');
  const views = [['playlists', 'Плейлисты'], ['liked', 'Любимое'], ['recent', 'Недавние']];
  const active = state._mlib || 'playlists';
  const body = el('div');
  views.forEach(([id, label]) => {
    const b = el('button', 'm-ltab' + (id === active ? ' on' : '')); b.textContent = label;
    b.addEventListener('click', () => { state._mlib = id; tabs.querySelectorAll('.m-ltab').forEach(x => x.classList.remove('on')); b.classList.add('on'); fillMLib(body, id); });
    tabs.appendChild(b);
  });
  w.appendChild(tabs); w.appendChild(body);
  fillMLib(body, active);
  return w;
}
function fillMLib(host, view){
  host.innerHTML = '';
  if (view === 'playlists'){
    const fav = el('div', 'm-lrow');
    fav.innerHTML = `<div class="cv" style="width:56px;height:56px;border-radius:12px;background:linear-gradient(135deg,#A78BFA,#6C3CE0)"><div>${mIc('heartFill', 24, '#fff')}</div></div>
      <div class="tw"><div class="lt">Любимое</div><div class="ls">Плейлист · ${liked.size} треков</div></div>${mIc('chevR', 20, 'var(--text-3)')}`;
    fav.addEventListener('click', () => openPlaylist({ id: 'liked', title: 'Любимое', kind: 'Плейлист' }));
    host.appendChild(fav);
    playlists.forEach(p => {
      const row = el('div', 'm-lrow');
      row.innerHTML = `${mCover(firstCover(p), 56, 12)}<div class="tw"><div class="lt">${esc(p.name)}</div><div class="ls">Плейлист · ${p.tracks.length} треков</div></div>${mIc('chevR', 20, 'var(--text-3)')}`;
      row.addEventListener('click', () => openUserPlaylist(p.id));
      host.appendChild(row);
    });
    if (!playlists.length){ const h = el('div', 'm-empty'); h.textContent = 'Создайте плейлист кнопкой + наверху.'; host.appendChild(h); }
    return;
  }
  const list = view === 'liked' ? [...liked.values()] : recent;
  if (!list.length){ const h = el('div', 'm-empty'); h.textContent = view === 'liked' ? 'Пока нет любимых треков ♥' : 'История пуста'; host.appendChild(h); return; }
  list.forEach((t, i) => host.appendChild(mTrackRow(t, list, i)));
}

function renderMPlaylist(ctx){
  const w = el('div', 'mscreen');
  const isLiked = ctx.id === 'liked';
  const isUser = typeof ctx.id === 'string' && ctx.id.startsWith('user:');
  const userPl = isUser ? playlists.find(p => p.id === ctx.id) : null;
  const title = userPl ? userPl.name : ctx.title;

  const back = el('div', 'm-pl-back');
  const bb = el('button', 'm-ibtn'); bb.innerHTML = mIc('chevL', 24, 'var(--text)');
  bb.addEventListener('click', () => go('library'));
  back.appendChild(bb); w.appendChild(back);

  const hero = el('div', 'm-pl-hero');
  const coverBlock = isLiked
    ? `<div class="m-pl-cover liked"><div class="m-pl-cover-fallback">${mIc('heartFill', 64, '#fff')}</div></div>`
    : mCover(userPl ? firstCover(userPl) : ctx, 188, 18);
  const desc = ctx.desc || ctx.subtitle || '';
  hero.innerHTML = `${coverBlock}
    <div class="m-pl-meta">
      <div class="m-pl-kind">${esc(userPl ? 'Ваш плейлист' : (ctx.kind || 'Плейлист'))}</div>
      <div class="m-pl-title">${esc(title)}</div>
      ${desc ? `<div class="m-pl-desc">${esc(desc)}</div>` : ''}
      <div class="m-pl-stats" id="mPlCount">…</div>
    </div>
    <div class="m-pl-actions">
      <div class="sm" id="mPlShuf">${mIc('shuffle', 22)}</div>
      <button class="m-pl-play" id="mPlPlay">${mIc('play', 26, '#fff')}</button>
      ${isUser ? `<div class="sm" id="mPlRen">${mIc('edit', 22)}</div>` : ''}
      ${isUser ? `<div class="sm" id="mPlDel">${mIc('trash', 22)}</div>` : `<div class="sm" id="mPlDl">${mIc('download', 22)}</div>`}
    </div>`;
  w.appendChild(hero);

  const listHost = el('div', 'm-pl-list');
  listHost.appendChild(centerState({ spinner: true, title: 'Загружаем треки…' }));
  w.appendChild(listHost);

  (async () => {
    let tracks = [];
    try {
      if (isLiked) tracks = [...liked.values()];
      else if (userPl) tracks = userPl.tracks;
      else if (ctx.tracks) tracks = ctx.tracks;
      else if (ctx.rawId) tracks = await audiusPlaylistTracks(ctx.rawId);
    } catch (e){ console.warn(e); }
    const cnt = w.querySelector('#mPlCount'); if (cnt) cnt.textContent = `${esc(user?.name || 'FLOR')} · ${tracks.length} треков`;
    listHost.innerHTML = '';
    if (!tracks.length){ const h = el('div', 'm-empty'); h.textContent = isUser ? 'Добавьте треки кнопкой «+» у любого трека.' : (isLiked ? 'Добавьте любимые треки ♥' : 'Не удалось получить треки.'); listHost.appendChild(h); }
    else tracks.forEach((t, i) => listHost.appendChild(mTrackRow(t, tracks, i, isUser ? { playlistId: ctx.id } : null)));
    const pp = w.querySelector('#mPlPlay'); if (pp) pp.addEventListener('click', () => { if (tracks.length){ player.playQueue(tracks, 0); openFS(); } });
    const sh = w.querySelector('#mPlShuf'); if (sh) sh.addEventListener('click', () => { if (tracks.length){ if (!player.shuffle) player.toggleShuffle(); player.playQueue(tracks, Math.floor(Math.random() * tracks.length)); } });
  })();

  const del = hero.querySelector('#mPlDel'); if (del) del.addEventListener('click', () => { if (confirm('Удалить этот плейлист?')){ deletePlaylist(ctx.id); toast('Плейлист удалён'); go('library'); } });
  const ren = hero.querySelector('#mPlRen'); if (ren) ren.addEventListener('click', () => openRenamePlaylistModal(ctx.id));
  const dl = hero.querySelector('#mPlDl'); if (dl) dl.addEventListener('click', () => toast('Скачивание недоступно'));
  return w;
}

function renderMProfile(){
  const w = el('div', 'mscreen');
  const top = el('div', 'm-prof-top');
  top.innerHTML = `<div class="m-prof-av-wrap">
      ${avatarHTML(96, 'm-prof-av', 'Сменить фото')}
      <div class="m-av-badge">${mIc('camera', 16, '#fff')}</div>
    </div>
    <div class="m-prof-name">${esc(user?.name || 'Гость')}</div>
    <div class="m-prof-sub">${user ? esc(user.email) + ' · ' : ''}<b>${liked.size}</b> любимых · <b>${playlists.length}</b> плейлистов · <b>FLOR Free</b></div>
    ${user ? `<button type="button" class="m-avatar-btn" id="mAvChange">${mIc('camera', 16, 'var(--accent-2)')} Сменить фото</button>` : ''}`;
  top.querySelector('.m-prof-av').addEventListener('click', () => openAvatarModal());
  top.querySelector('.m-av-badge')?.addEventListener('click', () => openAvatarModal());
  top.querySelector('#mAvChange')?.addEventListener('click', () => openAvatarModal());
  w.appendChild(top);

  w.appendChild(mLabel('Аккаунт'));
  const acc = el('div', 'm-card-row');
  if (user){
    acc.innerHTML = `<div class="ico">${mIc('user', 20)}</div><div class="tw"><div class="a">Выйти из аккаунта</div><div class="b">${esc(user.email)}</div></div>`;
    acc.addEventListener('click', () => { logout(); toast('Вы вышли из аккаунта'); render(); });
    w.appendChild(acc);
    const pw = el('div', 'm-card-row');
    pw.innerHTML = `<div class="ico">${mIc('lock', 20)}</div><div class="tw"><div class="a">Сменить пароль</div><div class="b">Нужен текущий пароль</div></div>`;
    pw.addEventListener('click', () => openChangePasswordModal());
    w.appendChild(pw);
  } else {
    acc.innerHTML = `<div class="ico">${mIc('user', 20)}</div><div class="tw"><div class="a">Войти или зарегистрироваться</div><div class="b">Сохраняйте профиль на этом устройстве</div></div><button class="m-badge-go">Войти</button>`;
    acc.addEventListener('click', () => openAuthModal());
  }
  w.appendChild(acc);

  w.appendChild(mLabel('Внешний вид'));
  const dark = document.documentElement.dataset.theme !== 'light';
  const th = el('div', 'm-card-row'); th.style.cursor = 'default';
  th.innerHTML = `<div class="ico">${mIc(dark ? 'moon' : 'sun', 20)}</div><div class="tw"><div class="a">Тема</div></div>
    <div class="m-seg"><button data-t="dark" class="${dark ? 'on' : ''}">Тёмная</button><button data-t="light" class="${!dark ? 'on' : ''}">Светлая</button></div>`;
  th.querySelectorAll('.m-seg button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); setTheme(b.dataset.t); }));
  w.appendChild(th);

  w.appendChild(mLabel('Данные'));
  const clear = el('div', 'm-card-row');
  clear.innerHTML = `<div class="ico" style="background:var(--hover);color:var(--text-2)">${mIc('trash', 20)}</div><div class="tw"><div class="a">Очистить любимое, плейлисты и историю</div><div class="b">Удаляет данные из этого браузера</div></div>`;
  clear.addEventListener('click', () => { if (!confirm('Очистить любимое, плейлисты и историю?')) return; liked.clear(); recent = []; playlists = []; saveJSON(LIKED_KEY, []); saveJSON(RECENT_KEY, []); saveJSON(PLAYLISTS_KEY, []); saveJSON(WAVE_KEY, []); if (user?.email){ saveJSON(libKey(PLAYLISTS_KEY), []); saveJSON(libKey(LIKED_KEY), []); } syncLibraryToServer(); toast('Данные очищены'); render(); });
  w.appendChild(clear);
  return w;
}

function renderMobile(){
  const s = state.screen;
  if (s === 'playlist') return renderMPlaylist(state.playlistCtx);
  if (s === 'search') return renderMSearch();
  if (s === 'library') return renderMLibrary();
  if (s === 'profile') return renderMProfile();
  return renderMHome();
}

/* ============================================================
   Render dispatcher
   ============================================================ */
function render(){
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.screen === state.screen));
  $$('.mtab').forEach(n => n.classList.toggle('active', n.dataset.screen === state.screen));
  $('#app').classList.toggle('on-search', state.screen === 'search');
  const host = $('#screens'); host.innerHTML = '';
  const scr = el('div', 'screen active');

  if (isMobile()){
    scr.appendChild(renderMobile());
    host.appendChild(scr);
    $('.content').scrollTop = 0;
    syncPlayerUI();
    renderSidePlaylists();
    return;
  }

  let node;
  if (state.screen === 'home') node = renderHome();
  else if (state.screen === 'search') node = renderSearch();
  else if (state.screen === 'library') node = renderLibrary();
  else if (state.screen === 'profile') node = renderProfile();
  else if (state.screen === 'playlist'){
    node = el('div'); node.appendChild(centerState({ spinner: true, title: 'Открываем…' }));
    renderPlaylist(state.playlistCtx).then(n => { node.innerHTML = ''; node.appendChild(n); });
  }
  scr.appendChild(node); host.appendChild(scr);
  $('.content').scrollTop = 0;
  syncPlayerUI();
  renderSidePlaylists();
}

function go(screen){ state.screen = screen; render(); }
function openPlaylist(ctx){ state.playlistCtx = ctx; state.screen = 'playlist'; render(); }
function openUserPlaylist(id){ openPlaylist({ id }); }

/* ============================================================
   Search controller
   ============================================================ */
let searchTimer = null, searchToken = 0;
function mirrorSearch(v){ const ts = $('#topSearch'), bs = $('#bigSearch'); if (ts && ts !== document.activeElement) ts.value = v; if (bs && bs !== document.activeElement) bs.value = v; }
function debouncedSearch(q){
  state.query = q;
  clearTimeout(searchTimer);
  if (!q.trim()){ state.results = null; state.searching = false; if (state.screen === 'search') refreshSearchResults(); return; }
  searchTimer = setTimeout(() => runSearch(q), 380);
}
function setQuery(q){
  state.query = q;
  if (state.screen !== 'search') state.screen = 'search';
  render();
  runSearch(q);
}

async function runSearch(q){
  q = (q || '').trim();
  state.query = q;
  if (!q){ state.results = null; state.searching = false; refreshSearchResults(); return; }

  state.searching = true; state.results = null;
  if (state.screen === 'search') refreshSearchResults();
  const token = ++searchToken;
  try {
    const res = await Promise.race([
      apiSearch(q, state.source, 40),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
    ]);
    if (token !== searchToken) return;
    state.results = res;
  } catch (e){
    if (token !== searchToken) return;
    state.results = []; toast('Ошибка поиска');
  } finally {
    if (token === searchToken){ state.searching = false; if (state.screen === 'search') refreshSearchResults(); }
  }
}
function refreshSearchResults(){
  const host = $('#searchResults');
  if (!host){ render(); return; }
  if (state.query) renderResults(host);
  else render();
}

/* ============================================================
   Like / recent
   ============================================================ */
function toggleLike(track){
  if (liked.has(track.id)){ liked.delete(track.id); toast('Удалено из любимого'); }
  else { liked.set(track.id, stripTrack(track)); toast('Добавлено в любимое'); }
  saveJSON(LIKED_KEY, [...liked.values()]);
  if (user?.email) saveJSON(libKey(LIKED_KEY), [...liked.values()]);
  syncLibraryToServer();
  syncPlayerUI(); refreshCurrentScreenLists();
}
function pushRecent(track){
  if (!track || track.isRadio) return;
  recent = [stripTrack(track), ...recent.filter(t => t.id !== track.id)].slice(0, 30);
  saveJSON(RECENT_KEY, recent);
}
function stripTrack(t){
  return { id:t.id, rawId:t.rawId, source:t.source, title:t.title, artist:t.artist,
    album:t.album, duration:t.duration, artwork:t.artwork, artworkFallbacks:t.artworkFallbacks || [],
    streamUrl:(t.source==='itunes'||t.source==='radio')?t.streamUrl:null, isFull:t.isFull, isRadio:t.isRadio };
}
function refreshCurrentScreenLists(){
  if (state.screen === 'search' && state.query) renderResults($('#searchResults'));
  else if (state.screen === 'library'){ const b = $('#libBody'); const active = $('.lib-tabs .chip.active')?.textContent; const v = active === 'Недавние' ? 'recent' : active === 'Любимое' ? 'liked' : 'playlists'; if (b) fillLib(b, v); }
  else if (state.screen === 'playlist') render();
}

/* ============================================================
   User playlists
   ============================================================ */
function savePlaylists(){
  saveJSON(PLAYLISTS_KEY, playlists);
  if (user?.email) saveJSON(libKey(PLAYLISTS_KEY), playlists);
  syncLibraryToServer();
}
function createPlaylist(name){
  const p = { id: 'user:' + Date.now().toString(36), name: name.trim() || 'Новый плейлист', tracks: [], createdAt: Date.now() };
  playlists.unshift(p); savePlaylists(); return p;
}
function renamePlaylist(plId, name){
  const p = playlists.find(x => x.id === plId);
  if (!p) return;
  const n = name.trim();
  if (!n || n === p.name) return;
  p.name = n.slice(0, 60);
  savePlaylists();
  toast('Название изменено');
  renderSidePlaylists();
  if (state.screen === 'playlist' && state.playlistCtx?.id === plId) render();
}
function addToPlaylist(plId, track){
  const p = playlists.find(x => x.id === plId); if (!p) return;
  if (p.tracks.some(t => t.id === track.id)){ toast('Уже в плейлисте'); return; }
  p.tracks.push(stripTrack(track)); savePlaylists();
  toast(`Добавлено в «${p.name}»`);
  if (state.screen === 'playlist' && state.playlistCtx?.id === plId) render();
  renderSidePlaylists();
}
function removeFromPlaylist(plId, trackId){
  const p = playlists.find(x => x.id === plId); if (!p) return;
  p.tracks = p.tracks.filter(t => t.id !== trackId); savePlaylists();
  toast('Убрано из плейлиста');
  if (state.screen === 'playlist') render();
}
function deletePlaylist(plId){ playlists = playlists.filter(p => p.id !== plId); savePlaylists(); renderSidePlaylists(); }

function quickAddToPlaylist(track, anchor){
  if (!playlists.length) return openCreatePlaylistModal(track);
  if (playlists.length === 1) return addToPlaylist(playlists[0].id, track);
  openPlaylistPicker(track, anchor);
}

function positionCtxMenu(menu, anchor){
  const sheet = isMobile() || document.body.classList.contains('fs-open');
  menu.classList.toggle('ctx-sheet', sheet);
  if (sheet){
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 240, mh = menu.offsetHeight || 200;
  let left = rect.right - mw; let top = rect.bottom + 6;
  if (top + mh > window.innerHeight) top = rect.top - mh - 6;
  if (left < 8) left = 8;
  menu.style.left = left + 'px';
  menu.style.top = Math.max(8, top) + 'px';
  menu.style.right = '';
  menu.style.bottom = '';
}

function openPlaylistPicker(track, anchor){
  const menu = $('#ctxMenu');
  let html = `<div class="ctx-label">Добавить в плейлист</div>`;
  playlists.forEach(p => { html += `<button data-pl="${esc(p.id)}">${I.music}<span>${esc(p.name)}</span></button>`; });
  html += `<button data-act="newpl">${I.plus}<span>Новый плейлист…</span></button>`;
  menu.innerHTML = html;
  menu.hidden = false;
  positionCtxMenu(menu, anchor);
  menu.querySelectorAll('button').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const pl = b.dataset.pl;
    if (pl) addToPlaylist(pl, track);
    else if (b.dataset.act === 'newpl') openCreatePlaylistModal(track);
    closeCtxMenu();
  }));
}

function openRenamePlaylistModal(plId){
  const p = playlists.find(x => x.id === plId);
  if (!p) return;
  const box = openModal(`
    <button class="modal-close" id="mClose">${I.shrink}</button>
    <h2>Переименовать плейлист</h2>
    <p class="modal-sub">Введите новое название.</p>
    <input class="modal-input" id="plRename" value="${esc(p.name)}" maxlength="60">
    <div class="modal-actions">
      <button class="btn-modal ghost" id="mCancel">Отмена</button>
      <button class="btn-modal primary" id="mSave">Сохранить</button>
    </div>`);
  box.querySelector('#mClose').addEventListener('click', closeModal);
  box.querySelector('#mCancel').addEventListener('click', closeModal);
  box.querySelector('#mSave').addEventListener('click', () => {
    renamePlaylist(plId, box.querySelector('#plRename').value);
    closeModal();
  });
  const inp = box.querySelector('#plRename');
  inp.focus(); inp.select();
  inp.addEventListener('keydown', e => { if (e.key === 'Enter'){ renamePlaylist(plId, inp.value); closeModal(); } });
}

/* ============================================================
   Context menu (track actions)
   ============================================================ */
function openTrackMenu(track, anchor, ctx){
  const menu = $('#ctxMenu');
  const inPl = ctx?.playlistId;
  const isLiked = liked.has(track.id);
  let html = `
    <button data-act="like">${isLiked ? I.heartFill : I.heart}<span>${isLiked ? 'Убрать из любимого' : 'В любимое'}</span></button>
    <button data-act="queue">${I.queue}<span>Играть следующим</span></button>
    <div class="ctx-sep"></div>
    <div class="ctx-label">Добавить в плейлист</div>`;
  playlists.forEach(p => { html += `<button data-pl="${esc(p.id)}">${I.music}<span>${esc(p.name)}</span></button>`; });
  html += `<button data-act="newpl">${I.plus}<span>Новый плейлист…</span></button>`;
  if (inPl) html += `<div class="ctx-sep"></div><button data-act="remove" class="danger">${I.minus}<span>Убрать из плейлиста</span></button>`;
  menu.innerHTML = html;

  menu.hidden = false;
  positionCtxMenu(menu, anchor);

  menu.querySelectorAll('button').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const act = b.dataset.act, pl = b.dataset.pl;
    if (pl) addToPlaylist(pl, track);
    else if (act === 'like') toggleLike(track);
    else if (act === 'queue'){ player.enqueueNext(track); toast('Играет следующим'); }
    else if (act === 'remove') removeFromPlaylist(ctx.playlistId, track.id);
    else if (act === 'newpl') openCreatePlaylistModal(track);
    closeCtxMenu();
  }));
}
function closeCtxMenu(){ const m = $('#ctxMenu'); if (m) m.hidden = true; }

/* ============================================================
   Modals (auth + create playlist)
   ============================================================ */
function openModal(html){ const box = $('#modalBox'); box.innerHTML = html; $('#modal').hidden = false; return box; }
function closeModal(){ $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }

function openCreatePlaylistModal(addTrack){
  const box = openModal(`
    <button class="modal-close" id="mClose">${I.shrink}</button>
    <h2>Новый плейлист</h2>
    <p class="modal-sub">Дайте название — плейлист появится в вашей медиатеке.</p>
    <input class="modal-input" id="plName" placeholder="Например: Для дороги" maxlength="60">
    <div class="modal-actions">
      <button class="btn-modal ghost" id="mCancel">Отмена</button>
      <button class="btn-modal primary" id="mCreate">Создать</button>
    </div>`);
  const input = box.querySelector('#plName'); input.focus();
  const submit = () => {
    const p = createPlaylist(input.value);
    if (addTrack) addToPlaylist(p.id, addTrack);
    closeModal(); renderSidePlaylists(); openUserPlaylist(p.id);
    toast('Плейлист создан');
  };
  box.querySelector('#mCreate').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  box.querySelector('#mCancel').addEventListener('click', closeModal);
  box.querySelector('#mClose').addEventListener('click', closeModal);
}

function openAuthModal(mode = 'login'){
  const EMAILRE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const data = { email: '', pass: '', name: '' };

  const api = async (path, body) => {
    try {
      const r = await fetch('/api/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok && j.ok, j };
    } catch {
      const hint = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'Запустите сервер: npm start'
        : 'Проверьте, что сервер запущен на ПК и телефон в той же Wi‑Fi сети';
      return { ok: false, j: { error: `Нет связи с сервером. ${hint}` } };
    }
  };
  const finish = async (j) => {
    user = { name: j.user.name, email: j.user.email, avatar: j.user.avatar || null };
    saveJSON(USER_KEY, user);
    reloadLocalLibrary();
    await loadLibraryFromServer(user.email);
    closeModal();
    updateAvatar();
    render();
    toast(`Добро пожаловать, ${user.name}!`);
  };

  const head = (sub) => `
    <button class="modal-close" id="mClose">${I.shrink}</button>
    <div class="auth-brand">${logoImg(44)}<div class="word">FL<b>OR</b></div></div>
    ${sub ? `<p class="modal-sub" style="text-align:center">${esc(sub)}</p>` : ''}`;
  const errBox = () => `<div class="auth-err" id="auErr" hidden></div>`;
  const wire = (box) => {
    box.querySelector('#mClose').addEventListener('click', closeModal);
    const e = box.querySelector('#auErr');
    return m => { if (e){ e.textContent = m; e.hidden = false; } };
  };
  const devNote = (j) => j && j.devCode ? `<div class="auth-note" style="color:var(--accent-2)">Почта не настроена — код для теста: <b>${esc(j.devCode)}</b></div>` : '';

  function loginView(){
    const box = openModal(`${head()}
      <div class="auth-tabs"><button class="on" data-m="login">Вход</button><button data-m="register">Регистрация</button></div>
      <input class="modal-input" id="auEmail" type="email" placeholder="Email" value="${esc(data.email)}" autocomplete="username">
      <input class="modal-input" id="auPass" type="password" placeholder="Пароль" autocomplete="current-password">
      ${errBox()}
      <div class="modal-actions"><button class="btn-modal primary wide" id="auSubmit">Войти</button></div>
      <div class="auth-links"><button class="auth-link" id="auByCode">Войти по коду из почты</button><button class="auth-link" id="auForgot">Забыли пароль?</button></div>`);
    const showErr = wire(box);
    box.querySelectorAll('.auth-tabs button').forEach(b => b.addEventListener('click', () => b.dataset.m === 'register' ? registerView() : loginView()));
    const submit = async () => {
      data.email = box.querySelector('#auEmail').value.trim().toLowerCase();
      data.pass = box.querySelector('#auPass').value;
      if (!EMAILRE.test(data.email)) return showErr('Некорректный email');
      if (!data.pass) return showErr('Введите пароль');
      const btn = box.querySelector('#auSubmit'); btn.disabled = true;
      const { ok, j } = await api('login', { email: data.email, pass: data.pass });
      btn.disabled = false;
      if (!ok) return showErr(j.error || 'Не удалось войти');
      finish(j);
    };
    box.querySelector('#auSubmit').addEventListener('click', submit);
    box.querySelector('#auPass').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    box.querySelector('#auByCode').addEventListener('click', () => codeRequestView('login'));
    box.querySelector('#auForgot').addEventListener('click', () => codeRequestView('reset'));
    box.querySelector('#auEmail').focus();
  }

  function registerView(){
    const box = openModal(`${head()}
      <div class="auth-tabs"><button data-m="login">Вход</button><button class="on" data-m="register">Регистрация</button></div>
      <input class="modal-input" id="auName" placeholder="Имя" maxlength="40" value="${esc(data.name)}">
      <input class="modal-input" id="auEmail" type="email" placeholder="Email" value="${esc(data.email)}" autocomplete="username">
      <input class="modal-input" id="auPass" type="password" placeholder="Пароль (мин. 4 символа)" autocomplete="new-password">
      ${errBox()}
      <div class="modal-actions"><button class="btn-modal primary wide" id="auSubmit">Создать аккаунт</button></div>
      <div class="auth-note">На указанный email придёт код подтверждения.</div>`);
    const showErr = wire(box);
    box.querySelectorAll('.auth-tabs button').forEach(b => b.addEventListener('click', () => b.dataset.m === 'login' ? loginView() : registerView()));
    const submit = async () => {
      data.name = box.querySelector('#auName').value.trim();
      data.email = box.querySelector('#auEmail').value.trim().toLowerCase();
      data.pass = box.querySelector('#auPass').value;
      if (!EMAILRE.test(data.email)) return showErr('Некорректный email');
      if (data.pass.length < 4) return showErr('Пароль слишком короткий (мин. 4 символа)');
      const btn = box.querySelector('#auSubmit'); btn.disabled = true;
      const { ok, j } = await api('register', { email: data.email, pass: data.pass, name: data.name });
      btn.disabled = false;
      if (!ok) return showErr(j.error || 'Не удалось зарегистрироваться');
      codeVerifyView('register', j);
    };
    box.querySelector('#auSubmit').addEventListener('click', submit);
    box.querySelector('#auPass').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    box.querySelector('#auName').focus();
  }

  function codeRequestView(purpose){
    const isReset = purpose === 'reset';
    const box = openModal(`${head(isReset ? 'Сброс пароля' : 'Вход по коду')}
      <p class="modal-sub">Укажите email — пришлём ${isReset ? 'код для сброса пароля' : 'код для входа'}.</p>
      <input class="modal-input" id="auEmail" type="email" placeholder="Email" value="${esc(data.email)}">
      ${errBox()}
      <div class="modal-actions"><button class="btn-modal ghost" id="auBack">Назад</button><button class="btn-modal primary" id="auSubmit">Отправить код</button></div>`);
    const showErr = wire(box);
    box.querySelector('#auBack').addEventListener('click', loginView);
    const submit = async () => {
      data.email = box.querySelector('#auEmail').value.trim().toLowerCase();
      if (!EMAILRE.test(data.email)) return showErr('Некорректный email');
      const btn = box.querySelector('#auSubmit'); btn.disabled = true;
      const { ok, j } = await api('code', { email: data.email, purpose });
      btn.disabled = false;
      if (!ok) return showErr(j.error || 'Не удалось отправить код');
      codeVerifyView(purpose, j);
    };
    box.querySelector('#auSubmit').addEventListener('click', submit);
    box.querySelector('#auEmail').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    box.querySelector('#auEmail').focus();
  }

  function codeVerifyView(purpose, reqJson){
    const needPass = purpose === 'reset';
    const box = openModal(`${head()}
      <p class="modal-sub">Введите код, отправленный на <b>${esc(data.email)}</b>.</p>
      ${devNote(reqJson)}
      <input class="modal-input" id="auCode" inputmode="numeric" maxlength="6" placeholder="6-значный код">
      ${needPass ? '<input class="modal-input" id="auNewPass" type="password" placeholder="Новый пароль (мин. 4 символа)" autocomplete="new-password">' : ''}
      ${errBox()}
      <div class="modal-actions"><button class="btn-modal ghost" id="auResend">Отправить снова</button><button class="btn-modal primary" id="auSubmit">Подтвердить</button></div>`);
    const showErr = wire(box);
    box.querySelector('#auResend').addEventListener('click', async () => {
      const { j } = purpose === 'register'
        ? await api('register', { email: data.email, pass: data.pass, name: data.name })
        : await api('code', { email: data.email, purpose });
      if (j && j.devCode) showErr('Код для теста: ' + j.devCode); else toast('Код отправлен снова');
    });
    const submit = async () => {
      const code = box.querySelector('#auCode').value.trim();
      if (!/^\d{4,6}$/.test(code)) return showErr('Введите код из письма');
      let path, body;
      if (purpose === 'register'){ path = 'register/verify'; body = { email: data.email, code }; }
      else if (purpose === 'login'){ path = 'code/verify'; body = { email: data.email, code }; }
      else { const np = box.querySelector('#auNewPass').value; if (np.length < 4) return showErr('Пароль слишком короткий (мин. 4 символа)'); path = 'reset'; body = { email: data.email, code, pass: np }; }
      const btn = box.querySelector('#auSubmit'); btn.disabled = true;
      const { ok, j } = await api(path, body);
      btn.disabled = false;
      if (!ok) return showErr(j.error || 'Неверный код');
      finish(j);
    };
    box.querySelector('#auSubmit').addEventListener('click', submit);
    box.querySelector('#auCode').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    box.querySelector('#auCode').focus();
  }

  (mode === 'register' ? registerView : loginView)();
}
function logout(){ user = null; try { localStorage.removeItem(USER_KEY); } catch {} updateAvatar(); }
function userInitial(){ return user?.name ? user.name[0].toUpperCase() : 'F'; }

function avatarHTML(size, className, title){
  const t = title ? ` title="${esc(title)}"` : '';
  if (user?.avatar) return `<div class="${className} has-img"${t}><img src="${esc(user.avatar)}" alt=""></div>`;
  return `<div class="${className}"${t}>${esc(userInitial())}</div>`;
}

async function syncUserAvatar(){
  if (!user?.email) return;
  try {
    const base = `/api/auth/avatar?email=${encodeURIComponent(user.email)}`;
    const r = await fetch(base + '&t=' + Date.now(), { method: 'HEAD' });
    if (r.ok) user.avatar = base + '&t=' + Date.now();
    else delete user.avatar;
    saveJSON(USER_KEY, user);
    updateAvatar();
  } catch {}
}

function resizeAvatarFile(file, maxPx = 256){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(maxPx / img.width, maxPx / img.height, 1);
      const w = Math.round(img.width * s), h = Math.round(img.height * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

function openAvatarModal(){
  if (!user) return openAuthModal();
  const box = openModal(`
    <button class="modal-close" id="mClose">${I.shrink}</button>
    <h2>Аватар</h2>
    <p class="modal-sub">Выберите фото и введите пароль для сохранения на сервере.</p>
    <div style="display:flex;justify-content:center;margin:16px 0">${avatarHTML(88, 'pa')}</div>
    <input class="modal-input" id="avPass" type="password" placeholder="Текущий пароль" autocomplete="current-password">
    <div class="auth-err" id="auErr" hidden></div>
    <div class="modal-actions">
      <button class="btn-modal ghost" id="avPick">Выбрать фото</button>
      <button class="btn-modal primary" id="avSave" disabled>Сохранить</button>
    </div>`);
  let picked = null;
  const showErr = m => { const e = box.querySelector('#auErr'); e.textContent = m; e.hidden = false; };
  box.querySelector('#mClose').addEventListener('click', closeModal);
  box.querySelector('#avPick').addEventListener('click', () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        picked = await resizeAvatarFile(f);
        const wrap = box.querySelector('.pa'); wrap.classList.add('has-img'); wrap.innerHTML = `<img src="${picked}" alt="">`;
        box.querySelector('#avSave').disabled = false;
      } catch { showErr('Не удалось загрузить изображение'); }
    };
    inp.click();
  });
  box.querySelector('#avSave').addEventListener('click', async () => {
    const pass = box.querySelector('#avPass').value;
    if (!picked) return showErr('Сначала выберите фото');
    if (!pass) return showErr('Введите пароль');
    const btn = box.querySelector('#avSave'); btn.disabled = true;
    try {
      const r = await fetch('/api/auth/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, pass, avatar: picked }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok){ btn.disabled = false; return showErr(j.error || 'Не удалось сохранить'); }
      user = { ...user, ...j.user }; saveJSON(USER_KEY, user);
      closeModal(); updateAvatar(); render(); toast('Аватар обновлён');
    } catch { btn.disabled = false; showErr('Нет связи с сервером'); }
  });
}

function openChangePasswordModal(){
  if (!user) return openAuthModal();
  const box = openModal(`
    <button class="modal-close" id="mClose">${I.shrink}</button>
    <h2>Сменить пароль</h2>
    <input class="modal-input" id="pwOld" type="password" placeholder="Текущий пароль" autocomplete="current-password">
    <input class="modal-input" id="pwNew" type="password" placeholder="Новый пароль (мин. 4 символа)" autocomplete="new-password">
    <input class="modal-input" id="pwNew2" type="password" placeholder="Повторите новый пароль" autocomplete="new-password">
    <div class="auth-err" id="auErr" hidden></div>
    <div class="modal-actions">
      <button class="btn-modal ghost" id="pwCancel">Отмена</button>
      <button class="btn-modal primary" id="pwSave">Сохранить</button>
    </div>`);
  const showErr = m => { const e = box.querySelector('#auErr'); e.textContent = m; e.hidden = false; };
  box.querySelector('#mClose').addEventListener('click', closeModal);
  box.querySelector('#pwCancel').addEventListener('click', closeModal);
  box.querySelector('#pwSave').addEventListener('click', async () => {
    const oldPass = box.querySelector('#pwOld').value;
    const newPass = box.querySelector('#pwNew').value;
    const new2 = box.querySelector('#pwNew2').value;
    if (!oldPass || !newPass) return showErr('Заполните все поля');
    if (newPass.length < 4) return showErr('Новый пароль слишком короткий');
    if (newPass !== new2) return showErr('Пароли не совпадают');
    const btn = box.querySelector('#pwSave'); btn.disabled = true;
    try {
      const r = await fetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, oldPass, newPass }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok){ btn.disabled = false; return showErr(j.error || 'Не удалось сменить пароль'); }
      closeModal(); toast('Пароль изменён');
    } catch { btn.disabled = false; showErr('Нет связи с сервером'); }
  });
  box.querySelector('#pwOld').focus();
}

function updateAvatar(){
  const av = $('#avatar');
  if (av){
    if (user?.avatar){ av.innerHTML = `<img src="${esc(user.avatar)}" alt="">`; av.classList.add('has-img'); }
    else { av.textContent = userInitial(); av.classList.remove('has-img'); }
  }
}

/* ============================================================
   Notifications
   ============================================================ */
let notifications = [];
function buildNotifications(){
  const base = [
    { id: 'welcome', icon: I.music, title: 'Добро пожаловать в FLOR MUSIC', body: 'Ищите и слушайте музыку бесплатно, без подписок.' },
    { id: 'tip-like', icon: I.heart, title: 'Сохраняйте любимое', body: 'Нажмите ♥ у трека — он появится в медиатеке.' },
    { id: 'tip-pl', icon: I.plus, title: 'Создавайте плейлисты', body: 'Кнопка «Новый плейлист» в медиатеке или «⋯» у трека.' },
  ];
  if (state.home?.trending?.[0]){
    const t = state.home.trending[0];
    base.unshift({ id: 'trend-' + t.id, icon: I.flow, title: 'В тренде сейчас', body: `Сейчас популярно: «${t.title}» — ${t.artist}`, track: t });
  }
  notifications = base;
  updateNotifDot();
  if (!$('#notifPanel').hidden) renderNotifPanel();
}
function unreadCount(){ return notifications.filter(n => !notifRead.has(n.id)).length; }
function updateNotifDot(){
  const n = unreadCount();
  const dot = $('#notifDot');
  if (dot) dot.hidden = n === 0;
  // Mobile bell is re-built on render — sync its dot in the live DOM.
  document.querySelectorAll('#mBell').forEach(bell => {
    let md = bell.querySelector('.m-dot');
    if (n === 0){ if (md) md.remove(); }
    else if (!md){ md = document.createElement('span'); md.className = 'm-dot'; bell.appendChild(md); }
  });
}
function renderNotifPanel(){
  const panel = $('#notifPanel');
  panel.innerHTML = `<div class="np-head"><span>Уведомления</span>${notifications.length ? '<button id="npReadAll">Прочитать все</button>' : ''}</div>`;
  if (!notifications.length){ panel.innerHTML += `<div class="np-empty">Пока нет уведомлений</div>`; return; }
  notifications.forEach(n => {
    const item = el('div', 'np-item' + (notifRead.has(n.id) ? '' : ' unread'));
    item.innerHTML = `<div class="np-ic">${n.icon || I.bell}</div><div class="np-tx"><div class="np-t">${esc(n.title)}</div><div class="np-b">${esc(n.body)}</div></div>`;
    item.addEventListener('click', () => { if (n.track) player.playQueue([n.track], 0); markRead(n.id); item.classList.remove('unread'); updateNotifDot(); });
    panel.appendChild(item);
  });
  const ra = panel.querySelector('#npReadAll');
  if (ra) ra.addEventListener('click', () => { notifications.forEach(n => markRead(n.id)); renderNotifPanel(); });
}
function markRead(id){ notifRead.add(id); saveJSON(NOTIF_READ_KEY, [...notifRead]); updateNotifDot(); }
function markAllNotifRead(){ notifications.forEach(n => markRead(n.id)); }
function toggleNotifPanel(){
  const panel = $('#notifPanel');
  if (panel.hidden){
    markAllNotifRead();
    renderNotifPanel();
    panel.hidden = false;
  } else panel.hidden = true;
}

/* ============================================================
   Sidebar playlists — ONLY user content (Liked + own playlists)
   ============================================================ */
function renderSidePlaylists(){
  const host = $('#sidePlaylists'); if (!host) return;
  host.innerHTML = '';
  const fav = el('div', 'pl-item');
  fav.innerHTML = `<div class="pl-cover" style="background:linear-gradient(135deg,#A78BFA,#6C3CE0);display:grid;place-items:center"><div style="width:20px;height:20px;color:#fff">${I.heartFill}</div></div><div class="pl-meta"><div class="t">Любимое</div><div class="s">Плейлист · ${liked.size} треков</div></div>`;
  fav.addEventListener('click', () => openPlaylist({ id: 'liked', title: 'Любимое', kind: 'Плейлист' }));
  host.appendChild(fav);
  playlists.forEach(p => {
    const it = el('div', 'pl-item');
    it.innerHTML = `<div class="pl-cover ${gradClass(p)}">${coverImg(firstCover(p))}</div><div class="pl-meta"><div class="t">${esc(p.name)}</div><div class="s">Плейлист · ${p.tracks.length} треков</div></div>`;
    it.addEventListener('click', () => openUserPlaylist(p.id));
    host.appendChild(it);
  });
  if (!playlists.length){
    const hint = el('div'); hint.style.cssText = 'padding:10px 16px;color:var(--text-3);font-size:12.5px;line-height:1.5';
    hint.textContent = 'Ваши плейлисты появятся здесь.';
    host.appendChild(hint);
  }
}

/* ============================================================
   Player UI sync
   ============================================================ */
function syncPlayerUI(){
  const c = player.current;
  const cover = $('#npCover');
  if (c){
    cover.className = 'npc ' + gradClass(c);
    cover.innerHTML = coverImg(c);
    $('#npTitle').textContent = c.title;
    $('#npArtist').textContent = c.artist + (c.isRadio ? '' : (c.isFull ? '' : ' · превью'));
    const lk = $('#npLike'); const isL = liked.has(c.id);
    lk.className = 'np-like' + (isL ? ' on' : ''); lk.innerHTML = isL ? I.heartFill : I.heart;
    const add = $('#npAdd');
    if (add){
      add.hidden = false;
      add.innerHTML = I.plus;
    }
  } else {
    cover.className = 'npc'; cover.innerHTML = '';
    $('#npTitle').textContent = 'Ничего не играет';
    $('#npArtist').textContent = 'Найдите трек для начала';
    $('#npLike').innerHTML = '';
    const add = $('#npAdd'); if (add){ add.hidden = true; add.innerHTML = ''; }
  }
  $('#npPlay').innerHTML = player.playing ? I.pause : I.play;
  $('#npPlay').classList.toggle('loading', player.loading);
  $('#shuffleBtn').classList.toggle('on', player.shuffle);
  $('#repeatBtn').classList.toggle('on', player.repeat !== 'off');
  $('#repeatBtn').innerHTML = player.repeat === 'one' ? I.repeatOne : I.repeat;
  updateProgressUI();
  updateVolumeUI();
  syncFS();
  highlightPlayingRows();
}

function highlightPlayingRows(){
  const id = player.current?.id;
  $$('.tracklist .track, .fs-queue .track').forEach(r => r.classList.toggle('playing', r._trackId === id && !!id));
}

function updateProgressUI(){
  const c = player.current;
  const live = c?.isRadio;
  const cur = player.currentTime, dur = player.duration, p = player.progress;
  if (live){
    $('#npFill').style.width = '100%'; $('#npKnob').style.left = '100%';
    $('#npCur').textContent = 'В эфире'; $('#npTot').textContent = 'LIVE';
  } else {
    $('#npFill').style.width = (p * 100) + '%'; $('#npKnob').style.left = (p * 100) + '%';
    $('#npCur').textContent = fmt(cur); $('#npTot').textContent = fmt(dur);
  }
  const ff = $('#fsFill');
  if (ff){
    if (live){ ff.style.width = '100%'; $('#fsKnob').style.left = '100%'; $('#fsCur').textContent = 'В эфире'; $('#fsTot').textContent = 'LIVE'; }
    else { ff.style.width = (p * 100) + '%'; $('#fsKnob').style.left = (p * 100) + '%'; $('#fsCur').textContent = fmt(cur); $('#fsTot').textContent = fmt(dur); }
  }
}
function updateVolumeUI(){
  const pct = (player.volume * 100) + '%';
  $('#volFill').style.width = pct;
  const vk = $('#volKnob'); if (vk) vk.style.left = pct;
  const btn = $('#volBtn');
  if (btn) btn.innerHTML = player.volume === 0 ? I.volumeMute : I.volume;
}

/* ============================================================
   Fullscreen player
   ============================================================ */
function openFS(){ if (!player.current) return; $('#fsplayer').classList.add('open'); document.body.classList.add('fs-open'); syncFS(); }
function closeFS(){ $('#fsplayer').classList.remove('open'); document.body.classList.remove('fs-open'); }

// The YouTube engine stays hidden off-screen; the player always shows artwork.
function updateYtMode(){ document.body.classList.remove('yt-mode'); }

const _artColorCache = new Map();
const ART_PALETTE = [
  [108,60,224], [224,164,88], [255,143,81], [78,200,192],
  [199,125,255], [162,62,108], [45,90,180], [230,90,120],
];

function gradTint(track){
  const key = track?.id || track?.title || '';
  let h = 0; for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [r, g, b] = ART_PALETTE[h % ART_PALETTE.length];
  return { r, g, b };
}

function extractArtColor(url, track){
  const cacheKey = url || track?.id || '';
  if (_artColorCache.has(cacheKey)) return Promise.resolve(_artColorCache.get(cacheKey));
  if (!url) return Promise.resolve(gradTint(track));
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        const s = 28;
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, s, s);
        const data = ctx.getImageData(0, 0, s, s).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4){
          if (data[i + 3] < 140) continue;
          const pr = data[i], pg = data[i + 1], pb = data[i + 2];
          const sum = pr + pg + pb;
          if (sum < 55 || sum > 700) continue;
          r += pr; g += pg; b += pb; n++;
        }
        const col = n ? { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) } : gradTint(track);
        _artColorCache.set(cacheKey, col);
        resolve(col);
      } catch { resolve(gradTint(track)); }
    };
    img.onerror = () => resolve(gradTint(track));
    img.src = url;
  });
}

function applyTrackTint(track, root){
  if (!root || !track) return;
  const url = track.artwork || track.artworkFallbacks?.[0];
  extractArtColor(url, track).then(({ r, g, b }) => {
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    root.style.setProperty('--fs-tint', `rgb(${r},${g},${b})`);
    root.style.setProperty('--fs-tint-soft', `rgba(${r},${g},${b},0.34)`);
    root.style.setProperty('--fs-tint-border', `rgba(${r},${g},${b},0.62)`);
    root.style.setProperty('--fs-tint-glow', `rgba(${r},${g},${b},0.42)`);
    root.style.setProperty('--fs-on-tint', lum > 0.68 ? '#1a1028' : '#ffffff');
  });
}

function syncFS(){
  const c = player.current; if (!c) return;
  const fsCover = $('#fsCover'); fsCover.className = 'fs-cover ' + gradClass(c); fsCover.innerHTML = coverImg(c);
  $('#fsTitle').textContent = c.title;
  $('#fsArtist').textContent = c.artist;
  const fsLk = $('#fsLike');
  if (fsLk){
    const isL = liked.has(c.id);
    fsLk.className = 'fs-like' + (isL ? ' on' : '');
    fsLk.innerHTML = isL ? I.heartFill : I.heart;
  }
  const fsAdd = $('#fsAdd');
  if (fsAdd) fsAdd.innerHTML = I.plus;
  const amb = $('#fsAmbient'); amb.className = 'ambient ' + gradClass(c);
  amb.style.backgroundImage = c.artwork ? `url("${c.artwork}")` : '';
  applyTrackTint(c, $('#fsplayer'));
  applyTrackTint(c, $('.player'));
  $('#fsPlay').innerHTML = player.playing ? I.pause : I.play;
  $('#fsShuffle').classList.toggle('on', player.shuffle);
  $('#fsRepeat').classList.toggle('on', player.repeat !== 'off');
  $('#fsRepeat').innerHTML = player.repeat === 'one' ? I.repeatOne : I.repeat;

  if (!$('#fsplayer').classList.contains('open')) return;

  if (state.fsTab === 'queue'){
    const q = $('#fsQueue'); q.innerHTML = '';
    if (!player.queue.length){ q.appendChild(centerState({ title: 'Очередь пуста' })); }
    player.queue.forEach((t, i) => { const r = trackRow(t, i, player.queue, true); q.appendChild(r); });
    highlightPlayingRows();
  } else {
    const info = $('#fsInfo');
    info.style.fontSize = '16px'; info.style.fontWeight = '500'; info.style.lineHeight = '1.8';
    info.innerHTML = `
      <p class="cur" style="font-size:22px;font-weight:700;color:var(--text)">${esc(c.title)}</p>
      <p>${esc(c.artist)}</p>
      <p>&nbsp;</p>
      <p>Альбом / жанр: ${esc(c.album || '—')}</p>
      ${c.isRadio ? '<p>Длительность: прямой эфир</p>' : `<p>Длительность: ${fmt(player.duration || c.duration)}</p>`}
      ${c.playCount ? `<p>Прослушиваний: ${c.playCount.toLocaleString('ru')}</p>` : ''}`;
  }
}

/* ============================================================
   Theme
   ============================================================ */
function setTheme(t){
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('flor-theme', t); } catch {}
  $('#tgDark').classList.toggle('on', t === 'dark');
  $('#tgLight').classList.toggle('on', t === 'light');
  if (state.screen === 'profile') render();
}

/* ============================================================
   Drag bars
   ============================================================ */
function wireBar(barEl, onSet){
  if (!barEl) return;
  barEl.style.touchAction = 'none';   // let us own the drag, no page scroll
  const at = clientX => { const r = barEl.getBoundingClientRect(); let p = (clientX - r.left) / r.width; return Math.max(0, Math.min(1, p)); };
  let dragging = false;
  barEl.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    try { barEl.setPointerCapture(e.pointerId); } catch {}
    onSet(at(e.clientX));
  });
  barEl.addEventListener('pointermove', e => { if (dragging) onSet(at(e.clientX)); });
  const end = () => { dragging = false; };
  barEl.addEventListener('pointerup', end);
  barEl.addEventListener('pointercancel', end);
}

/* ============================================================
   Toasts
   ============================================================ */
let toastTimer;
function toast(msg){
  const host = $('#toasts');
  host.innerHTML = `<div class="toast">${I.check}${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.innerHTML = ''; }, 2400);
}

/* ============================================================
   Init
   ============================================================ */
function lockAppGestures(){
  // iOS standalone: block pinch / double-tap page zoom
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']){
    document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  }
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
}

function updateVpnBanner(){
  const b = $('#vpnBanner');
  const t = $('#vpnBannerText');
  if (!b || !t) return;
  if (!netStatus.probed){ b.hidden = true; return; }
  if (netStatus.youtubeOk && netStatus.soundcloudOk){ b.hidden = true; return; }
  try { if (localStorage.getItem('flor-vpn-banner-dismiss')){ b.hidden = true; return; } } catch {}
  const parts = [];
  if (!netStatus.youtubeOk) parts.push('YouTube');
  if (!netStatus.soundcloudOk) parts.push('SoundCloud');
  if (!parts.length){ b.hidden = true; return; }
  if (netStatus.clientVpn && !netStatus.serverWorker && !netStatus.serverYoutube){
    t.textContent = 'VPN на телефоне не проксирует музыку — настройте Cloudflare Worker на сервере (proxy-config.json), иначе ' + parts.join(' / ') + ' не заиграют.';
  } else {
    t.textContent = `${parts.join(' и ')} недоступны с сервера. Настройте Cloudflare Worker или слушайте Audius / iTunes.`;
  }
  b.hidden = false;
}

async function init(){
  lockAppGestures();
  let t = 'dark'; try { t = localStorage.getItem('flor-theme') || 'dark'; } catch {}
  document.documentElement.dataset.theme = t;
  $('#brandMark').innerHTML = logoImg(34);
  updateAvatar();
  buildNotifications();
  if (user?.email) syncUserAvatar();

  $$('.nav-item').forEach(n => n.addEventListener('click', () => go(n.dataset.screen)));
  $$('.mtab').forEach(n => n.addEventListener('click', () => go(n.dataset.screen)));

  // re-render when crossing the mobile/desktop breakpoint
  let wasMobile = isMobile();
  loadProxyConfig();
  primeAudius();   // warm the Audius host so the first tap can play synchronously
  probeNetwork().then(() => updateVpnBanner()).catch(() => {});
  const vpnClose = $('#vpnBannerClose');
  if (vpnClose) vpnClose.addEventListener('click', () => {
    try { localStorage.setItem('flor-vpn-banner-dismiss', '1'); } catch {}
    const b = $('#vpnBanner'); if (b) b.hidden = true;
  });
  fetch('/api/health').catch(() => {
    const onPhone = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
    toast(onPhone
      ? 'Нет связи с сервером. Запустите npm start на ПК и откройте адрес из консоли сервера.'
      : 'Сервер не запущен. В терминале: npm start');
  });
  window.addEventListener('resize', () => { const m = isMobile(); if (m !== wasMobile){ wasMobile = m; render(); } });

  $('#tgDark').addEventListener('click', () => setTheme('dark'));
  $('#tgLight').addEventListener('click', () => setTheme('light'));
  $('#tgDark').classList.toggle('on', t === 'dark');
  $('#tgLight').classList.toggle('on', t === 'light');

  $('#avatar').addEventListener('click', () => go('profile'));
  $('#collapseBtn').addEventListener('click', () => $('#app').classList.toggle('collapsed'));
  $('#createPlaylist').addEventListener('click', () => openCreatePlaylistModal());

  // top search (mirrors without stripping, so spaces stay intact)
  const ts = $('#topSearch');
  ts.addEventListener('input', e => { if (state.screen !== 'search') go('search'); mirrorSearch(e.target.value); debouncedSearch(e.target.value); });
  ts.addEventListener('keydown', e => { if (e.key === 'Enter'){ if (state.screen !== 'search') go('search'); runSearch(e.target.value); } });

  // player controls
  $('#npPlay').addEventListener('click', () => player.toggle());
  $('#npPrev').addEventListener('click', () => player.prev());
  $('#npNext').addEventListener('click', () => player.next());
  $('#shuffleBtn').addEventListener('click', () => player.toggleShuffle());
  $('#repeatBtn').addEventListener('click', () => player.cycleRepeat());
  $('#npLike').addEventListener('click', () => { if (player.current) toggleLike(player.current); });
  $('#npAdd').addEventListener('click', e => {
    e.stopPropagation();
    if (player.current) quickAddToPlaylist(player.current, $('#npAdd'));
  });
  $('#expandBtn').addEventListener('click', openFS);
  $('#npCover').addEventListener('click', openFS);
  document.querySelector('.np-left .npmeta')?.addEventListener('click', () => { if (window.matchMedia('(max-width: 760px)').matches && player.current) openFS(); });
  $('#queueBtn').addEventListener('click', () => { state.fsTab = 'queue'; openFS(); });
  $('#volBtn').addEventListener('click', () => player.setVolume(player.volume === 0 ? 0.8 : 0));

  // notifications
  $('#notifBtn').addEventListener('click', e => { e.stopPropagation(); toggleNotifPanel(); });

  // fullscreen controls
  $('#fsClose').addEventListener('click', closeFS);
  $('#fsMinimize').addEventListener('click', closeFS);
  $('#fsPlay').addEventListener('click', () => player.toggle());
  $('#fsPrev').addEventListener('click', () => player.prev());
  $('#fsNext').addEventListener('click', () => player.next());
  $('#fsShuffle').addEventListener('click', () => player.toggleShuffle());
  $('#fsRepeat').addEventListener('click', () => player.cycleRepeat());
  $('#fsLike').addEventListener('click', () => { if (player.current) toggleLike(player.current); });
  $('#fsAdd').addEventListener('click', e => {
    e.stopPropagation();
    if (player.current) quickAddToPlaylist(player.current, $('#fsAdd'));
  });
  $$('.fs-rtabs button').forEach(b => b.addEventListener('click', () => {
    $$('.fs-rtabs button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    state.fsTab = b.dataset.tab;
    $('#fsQueue').style.display = state.fsTab === 'queue' ? 'block' : 'none';
    $('#fsInfo').style.display = state.fsTab === 'info' ? 'block' : 'none';
    syncFS();
  }));

  // bars
  wireBar($('#npBar'), p => player.seekFraction(p));
  wireBar($('#fsBar'), p => player.seekFraction(p));
  wireBar($('#volBar'), p => player.setVolume(p));

  // global click: close ctx menu / notif panel / modal backdrop
  document.addEventListener('click', e => {
    if (!e.target.closest('#ctxMenu') && !e.target.closest('.addpl') && !e.target.closest('.maddpl')
        && !e.target.closest('#npAdd') && !e.target.closest('#fsAdd')
        && !e.target.closest('.more') && !e.target.closest('.mmore')) closeCtxMenu();
    if (!e.target.closest('#notifPanel') && !e.target.closest('#notifBtn') && !e.target.closest('#mBell')) $('#notifPanel').hidden = true;
  });
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  // keyboard
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space'){ e.preventDefault(); player.toggle(); }
    if (e.code === 'Escape'){ closeFS(); closeModal(); closeCtxMenu(); }
    if (e.code === 'ArrowRight' && e.shiftKey) player.next();
    if (e.code === 'ArrowLeft' && e.shiftKey) player.prev();
  });

  // player events
  player.subscribe((type) => {
    if (type === 'progress'){ updateProgressUI(); return; }
    if (type === 'change' || type === 'queue') pushRecent(player.current);
    if (type === 'blocked'){
      const hint = netHint(player.current?.source);
      toast(hint || 'Источник недоступен в вашей сети');
      return;
    }
    if (type === 'mediaerror') toast('Источник недоступен, пропускаем');
    if (type === 'error' && player.queue.length <= 1) toast('Не удалось воспроизвести');
    updateYtMode();
    syncPlayerUI();
  });

  // Deep-link
  const params = new URLSearchParams(location.search);
  const q = params.get('q'); const src = params.get('src');
  if (src && SOURCES.some(s => s.id === src)) state.source = src;
  if (q){ state.screen = 'search'; state.query = q; }

  reloadLocalLibrary();
  if (user?.email) await loadLibraryFromServer(user.email);

  render();
  syncPlayerUI();
  if (q){ const tsi = $('#topSearch'); if (tsi) tsi.value = q; runSearch(q); }
}

document.addEventListener('DOMContentLoaded', init);
