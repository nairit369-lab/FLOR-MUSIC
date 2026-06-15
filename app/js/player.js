/* ============================================================
   FLOR MUSIC — Audio playback engine (dual backend)
   - HTML5 <audio> for Audius / iTunes / Radio
   - Official YouTube IFrame Player for YouTube (full songs, no key)
   ============================================================ */
import { audiusStreamUrl, audiusStreamUrlSync, youtubePipedAudioUrl, soundcloudStreamUrl } from './api.js?v=16';

class Player {
  constructor(){
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';          // 'off' | 'all' | 'one'
    this.loading = false;
    this.mode = 'audio';          // 'audio' | 'yt'
    this._listeners = new Set();
    this._loadToken = 0;

    // YouTube backend
    this.yt = null;
    this.ytReady = false;
    this._ytState = -1;
    this._pendingYT = null;
    this._ytPoll = null;

    this._volume = this._readVolume();
    this.audio.volume = this._volume;

    this.audio.addEventListener('timeupdate', () => { if (this.mode === 'audio') this._emit('progress'); });
    this.audio.addEventListener('durationchange', () => { if (this.mode === 'audio') this._emit('progress'); });
    this.audio.addEventListener('play',  () => { if (this.mode === 'audio') this._emit('state'); });
    this.audio.addEventListener('pause', () => { if (this.mode === 'audio') this._emit('state'); });
    this.audio.addEventListener('waiting', () => { if (this.mode === 'audio'){ this.loading = true; this._emit('state'); } });
    this.audio.addEventListener('playing', () => { if (this.mode === 'audio'){ this.loading = false; this._emit('state'); } });
    this.audio.addEventListener('canplay', () => { if (this.mode === 'audio'){ this.loading = false; this._emit('state'); } });
    this.audio.addEventListener('ended', () => { if (this.mode === 'audio') this._onEnded(); });
    this.audio.addEventListener('error', () => { if (this.mode === 'audio') this._onError(); });

    this._loadYouTubeAPI();
  }

  /* ---------- subscription ---------- */
  subscribe(fn){ this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(type){ for (const fn of this._listeners) fn(type, this); }

  /* ---------- getters ---------- */
  get current(){ return this.index >= 0 ? this.queue[this.index] : null; }
  get playing(){
    if (this.mode === 'yt') return this._ytState === 1 || this._ytState === 3;
    return !this.audio.paused && !this.audio.ended;
  }
  get currentTime(){
    if (this.mode === 'yt') return (this.yt && this.yt.getCurrentTime) ? this.yt.getCurrentTime() : 0;
    return this.audio.currentTime || 0;
  }
  get duration(){
    if (this.mode === 'yt'){ const d = this.yt && this.yt.getDuration ? this.yt.getDuration() : 0; return d > 0 ? d : (this.current?.duration || 0); }
    const d = this.audio.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return this.current?.duration || 0;
  }
  get progress(){ const d = this.duration; return d ? Math.min(1, this.currentTime / d) : 0; }
  get volume(){ return this._volume; }

  /* ---------- queue control ---------- */
  async playQueue(tracks, startIndex = 0){
    if (!tracks || !tracks.length) return;
    this.queue = tracks.slice();
    this.index = Math.max(0, Math.min(startIndex, tracks.length - 1));
    await this._load(true);
    this._emit('queue');
  }
  async playTrack(track){
    const i = this.queue.findIndex(t => t.id === track.id);
    if (i >= 0) this.index = i; else { this.queue = [track]; this.index = 0; }
    await this._load(true);
    this._emit('queue');
  }
  enqueueNext(track){
    if (this.index < 0){ this.queue = [track]; this.index = 0; this._load(true); }
    else this.queue.splice(this.index + 1, 0, track);
    this._emit('queue');
  }

  /* ---------- transport ---------- */
  async toggle(){
    if (!this.current) return;
    if (this.mode === 'yt'){
      if (!this.yt) return;
      if (this.playing) this.yt.pauseVideo(); else this.yt.playVideo();
      return;
    }
    if (this.playing) this.audio.pause();
    else { try { await this.audio.play(); } catch {} }
  }
  pause(){ if (this.mode === 'yt'){ this.yt && this.yt.pauseVideo(); } else this.audio.pause(); }

  async next(auto = false){
    if (!this.queue.length) return;
    if (this.repeat === 'one' && auto){ this.seekFraction(0); this._play(); return; }
    let n;
    if (this.shuffle){
      if (this.queue.length === 1) n = this.index;
      else { do { n = Math.floor(Math.random() * this.queue.length); } while (n === this.index); }
    } else {
      n = this.index + 1;
      if (n >= this.queue.length){
        if (this.repeat === 'all') n = 0;
        else { this.pause(); return; }
      }
    }
    this.index = n;
    await this._load(true);
    this._emit('queue');
  }
  async prev(){
    if (!this.queue.length) return;
    if (this.currentTime > 3){ this.seekFraction(0); return; }
    let n = this.index - 1;
    if (n < 0) n = this.repeat === 'all' ? this.queue.length - 1 : 0;
    this.index = n;
    await this._load(true);
    this._emit('queue');
  }

  seekFraction(f){
    const d = this.duration; if (!d) return;
    const t = Math.max(0, Math.min(1, f)) * d;
    if (this.mode === 'yt'){ this.yt && this.yt.seekTo(t, true); }
    else this.audio.currentTime = t;
    this._emit('progress');
  }
  setVolume(v){
    v = Math.max(0, Math.min(1, v));
    this._volume = v;
    this.audio.volume = v;
    if (this.ytReady && this.yt) this.yt.setVolume(v * 100);
    this._saveVolume(v);
    this._emit('state');
  }
  toggleShuffle(){ this.shuffle = !this.shuffle; this._emit('state'); }
  cycleRepeat(){ this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off'; this._emit('state'); }

  _play(){ if (this.mode === 'yt'){ this.yt && this.yt.playVideo(); } else this.audio.play().catch(() => {}); }

  /* ---------- internals: loading ---------- */
  async _load(autoplay){
    const track = this.current;
    if (!track) return;
    const token = ++this._loadToken;
    this.loading = true;

    if (track.source === 'youtube' && !track.streamUrl){
      // Fallback only: no proxied audio URL → use the YouTube IFrame backend.
      this.mode = 'yt';
      try { this.audio.pause(); } catch {}
      this._emit('change'); this._emit('state');
      if (this.ytReady && this.yt){ this.yt.loadVideoById(track.rawId); this.yt.setVolume(this._volume * 100); }
      else { this._pendingYT = { rawId: track.rawId, autoplay }; }
      this._startYTPoll();
      this._ytLoadTimer = setTimeout(() => { if (this.loading && this.mode === 'yt') this._onError(); }, 18000);
      return;
    }

    // HTML5 audio backend.
    this.mode = 'audio';
    this._stopYTPoll();
    if (this.ytReady && this.yt){ try { this.yt.stopVideo(); } catch {} }
    this._ytState = -1;
    this._emit('change'); this._emit('state');

    try {
      const resolveSrc = async () => {
        let src = track.streamUrl;
        if (!src && track.source === 'audius'){
          src = audiusStreamUrlSync(track.rawId);
          if (src) track.streamUrl = src;
        }
        if (!src && track.source === 'audius'){
          src = await audiusStreamUrl(track.rawId);
          track.streamUrl = src;
        }
        if (!src && track.source === 'soundcloud'){
          src = await soundcloudStreamUrl(track.rawId);
          track.streamUrl = src;
        }
        return src;
      };
      const src = await Promise.race([
        resolveSrc(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);
      if (token !== this._loadToken) return;
      if (!src) throw new Error('no source');
      this.audio.src = src;
      this.audio.volume = this._volume;
      this.audio.load();
      this._updateMediaSession(track);
      if (autoplay){ try { await this.audio.play(); } catch {} }
    } catch (e){
      if (token !== this._loadToken) return;
      this.loading = false;
      const t = this.current;
      if (t && t.source === 'audius' && !t._streamRetry){
        t._streamRetry = true;
        t.streamUrl = null;
        this._load(true);
        return;
      }
      if (t && t.source === 'soundcloud' && !t._streamRetry){
        t._streamRetry = true;
        t.streamUrl = null;
        this._load(true);
        return;
      }
      this._emit('mediaerror');
      if (this.queue.length > 1) setTimeout(() => this.next(true), 400);
    }
  }

  _onEnded(){ this.next(true); }
  async _onError(){
    this.loading = false;
    const t = this.current;
    if (t && t.source === 'audius' && !t._streamRetry){
      t._streamRetry = true;
      t.streamUrl = null;
      const fresh = await audiusStreamUrl(t.rawId);
      if (fresh){ t.streamUrl = fresh; this._load(true); return; }
    }
    if (t && t.source === 'soundcloud' && !t._streamRetry){
      t._streamRetry = true;
      t.streamUrl = null;
      const fresh = await soundcloudStreamUrl(t.rawId);
      if (fresh){ t.streamUrl = fresh; this._load(true); return; }
    }
    // YouTube IFrame failed (blocked on some ISPs) — try Piped from the browser,
    // then the server proxy as a last resort.
    if (t && t.source === 'youtube' && this.mode === 'yt' && !t._proxyTried){
      t._proxyTried = true;
      const piped = await youtubePipedAudioUrl(t.rawId);
      t.streamUrl = piped || ('/api/yt/audio?id=' + t.rawId);
      this._load(true);
      return;
    }
    this._emit('mediaerror');
    if (this.queue.length > 1) setTimeout(() => this.next(true), 400);
  }

  /* ---------- internals: YouTube ---------- */
  _loadYouTubeAPI(){
    if (window.YT && window.YT.Player){ this._initYT(); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (typeof prev === 'function') prev(); this._initYT(); };
    if (!document.getElementById('yt-iframe-api')){
      const s = document.createElement('script');
      s.id = 'yt-iframe-api';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  }
  _initYT(){
    if (this.yt || !window.YT || !window.YT.Player) return;
    const mount = document.getElementById('ytplayer');
    if (!mount) return;
    this.yt = new window.YT.Player('ytplayer', {
      height: '180', width: '320',
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          this.ytReady = true;
          this.yt.setVolume(this._volume * 100);
          if (this._pendingYT){ const { rawId } = this._pendingYT; this._pendingYT = null; this.yt.loadVideoById(rawId); }
        },
        onStateChange: (e) => {
          this._ytState = e.data;
          if (e.data === 3){ this.loading = true; }                 // buffering
          if (e.data === 1){ this.loading = false; this._updateMediaSession(this.current); } // playing
          if (e.data === 0){ this._onEnded(); }                     // ended
          this._emit('state');
        },
        onError: () => { this._onError(); },
      },
    });
  }
  _startYTPoll(){ this._stopYTPoll(); this._ytPoll = setInterval(() => { if (this.mode === 'yt') this._emit('progress'); }, 500); }
  _stopYTPoll(){ if (this._ytPoll){ clearInterval(this._ytPoll); this._ytPoll = null; } if (this._ytLoadTimer){ clearTimeout(this._ytLoadTimer); this._ytLoadTimer = null; } }

  /* ---------- media session ---------- */
  _updateMediaSession(track){
    if (!track || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title, artist: track.artist, album: track.album || 'FLOR',
        artwork: track.artwork ? [{ src: track.artwork, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('play',  () => this.toggle());
      navigator.mediaSession.setActionHandler('pause', () => this.toggle());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
      // Many covers aren't square (YouTube 16:9 etc.), which the iOS player shows
      // letterboxed with black bars. Re-draw to a centred square so the system
      // player always gets clean square artwork.
      this._squareArtwork(track);
    } catch {}
  }

  _squareArtwork(track){
    if (!track.artwork) return;
    const id = track.id;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.current?.id !== id) return;
      try {
        const S = 512, c = document.createElement('canvas');
        c.width = c.height = S;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#1a1426'; ctx.fillRect(0, 0, S, S);
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, S, S);
        const url = c.toDataURL('image/jpeg', 0.9);
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title, artist: track.artist, album: track.album || 'FLOR',
          artwork: [{ src: url, sizes: '512x512', type: 'image/jpeg' }],
        });
      } catch {}
    };
    img.src = '/api/img?u=' + encodeURIComponent(track.artwork);
  }

  _readVolume(){ const v = parseFloat(localStorage.getItem('flor-vol')); return Number.isFinite(v) ? v : 0.8; }
  _saveVolume(v){ try { localStorage.setItem('flor-vol', String(v)); } catch {} }
}

export const player = new Player();
