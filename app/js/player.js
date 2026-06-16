/* ============================================================
   FLOR MUSIC — Audio playback engine
   All streams go through same-origin server proxy → background play on iOS/PWA.
   ============================================================ */
import { playUrl } from './api.js?v=19';

class Player {
  constructor(){
    this._audio = null;
    this.queue = [];
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';
    this.loading = false;
    this._listeners = new Set();
    this._loadToken = 0;
    this._lastLoadedId = null;
    this._volume = this._readVolume();
    this._intendedPlaying = false;

    if (document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', () => this._initAudio());
    } else {
      this._initAudio();
    }
  }

  _initAudio(){
    if (this._audio) return;
    const dom = document.getElementById('florAudio');
    this._audio = dom || new Audio();
    this._audio.preload = 'auto';
    this._audio.volume = this._volume;
    this._audio.playsInline = true;
    this._audio.setAttribute('playsinline', '');
    this._audio.setAttribute('webkit-playsinline', 'true');

    this._audio.addEventListener('timeupdate', () => {
      this._updatePositionState();
      this._emit('progress');
    });
    this._audio.addEventListener('durationchange', () => this._emit('progress'));
    this._audio.addEventListener('play',  () => { this._intendedPlaying = true; this._syncMediaSessionState(); this._emit('state'); });
    this._audio.addEventListener('pause', () => { this._syncMediaSessionState(); this._emit('state'); });
    this._audio.addEventListener('waiting', () => { this.loading = true; this._emit('state'); });
    this._audio.addEventListener('playing', () => { this.loading = false; this._syncMediaSessionState(); this._emit('state'); });
    this._audio.addEventListener('canplay', () => { this.loading = false; this._emit('state'); });
    this._audio.addEventListener('ended', () => this._onEnded());
    this._audio.addEventListener('error', () => this._onError());
    this._audio.addEventListener('stalled', () => {
      if (this._intendedPlaying && this._audio.paused) this._audio.play().catch(() => {});
    });

    this._bindBackgroundHelpers();
  }

  get audio(){
    if (!this._audio) this._initAudio();
    return this._audio;
  }

  _bindBackgroundHelpers(){
    document.addEventListener('visibilitychange', () => {
      if (!this.current) return;
      this._syncMediaSessionState();
      this._updatePositionState();
      if (this._intendedPlaying && this.audio.paused){
        this.audio.play().catch(() => {});
      }
    });
    window.addEventListener('pageshow', () => {
      if (!this.current) return;
      this._syncMediaSessionState();
      if (this._intendedPlaying && this.audio.paused){
        this.audio.play().catch(() => {});
      }
    });
  }

  _resetTrackRetries(track){
    if (!track || this._lastLoadedId === track.id) return;
    this._lastLoadedId = track.id;
    delete track._streamRetry;
  }

  subscribe(fn){ this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(type){ for (const fn of this._listeners) fn(type, this); }

  get current(){ return this.index >= 0 ? this.queue[this.index] : null; }
  get playing(){ return this._intendedPlaying && !this.audio.paused && !this.audio.ended; }
  get currentTime(){ return this.audio.currentTime || 0; }
  get duration(){
    const d = this.audio.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return this.current?.duration || 0;
  }
  get progress(){ const d = this.duration; return d ? Math.min(1, this.currentTime / d) : 0; }
  get volume(){ return this._volume; }
  get mode(){ return 'audio'; }

  async playQueue(tracks, startIndex = 0){
    if (!tracks?.length) return;
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

  async toggle(){
    if (!this.current) return;
    if (this.playing){ this._intendedPlaying = false; this.audio.pause(); }
    else { this._intendedPlaying = true; try { await this.audio.play(); } catch {} }
  }
  pause(){ this._intendedPlaying = false; this.audio.pause(); }

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
    this.audio.currentTime = Math.max(0, Math.min(1, f)) * d;
    this._updatePositionState();
    this._emit('progress');
  }
  setVolume(v){
    v = Math.max(0, Math.min(1, v));
    this._volume = v;
    this.audio.volume = v;
    this._saveVolume(v);
    this._emit('state');
  }
  toggleShuffle(){ this.shuffle = !this.shuffle; this._emit('state'); }
  cycleRepeat(){ this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off'; this._emit('state'); }

  _play(){
    this._intendedPlaying = true;
    this.audio.play().catch(() => {});
  }

  async _load(autoplay){
    const track = this.current;
    if (!track) return;
    const token = ++this._loadToken;
    this.loading = true;
    this._resetTrackRetries(track);

    const src = playUrl(track);
    if (!src){
      this.loading = false;
      this._emit('mediaerror');
      if (this.queue.length > 1) setTimeout(() => this.next(true), 400);
      return;
    }

    this._emit('change');
    this._emit('state');

    try {
      if (token !== this._loadToken) return;
      this.audio.src = src;
      this.audio.volume = this._volume;
      this.audio.load();
      this._updateMediaSession(track);
      if (autoplay){
        this._intendedPlaying = true;
        try { await this.audio.play(); } catch { this._intendedPlaying = false; }
      }
      if (token === this._loadToken) this.loading = false;
    } catch (e){
      if (token !== this._loadToken) return;
      this.loading = false;
      if (track && !track._streamRetry){
        track._streamRetry = true;
        track.streamUrl = null;
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
    if (t && !t._streamRetry){
      t._streamRetry = true;
      t.streamUrl = null;
      this._load(true);
      return;
    }
    this._intendedPlaying = false;
    this._emit('mediaerror');
    if (this.queue.length > 1) setTimeout(() => this.next(true), 400);
  }

  _syncMediaSessionState(){
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    } catch {}
  }

  _updatePositionState(){
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    const d = this.duration;
    if (!d || !Number.isFinite(d)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: 1,
        position: Math.min(this.currentTime, d),
      });
    } catch {}
  }

  _updateMediaSession(track){
    if (!track || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album || 'FLOR MUSIC',
        artwork: track.artwork ? [{ src: track.artwork, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => { this._intendedPlaying = true; this.audio.play().catch(() => {}); });
      navigator.mediaSession.setActionHandler('pause', () => { this._intendedPlaying = false; this.audio.pause(); });
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
      navigator.mediaSession.setActionHandler('seekto', d => {
        if (d?.seekTime != null) this.audio.currentTime = d.seekTime;
      });
      this._syncMediaSessionState();
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
          title: track.title, artist: track.artist, album: track.album || 'FLOR MUSIC',
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
