export class AudioPlayer {
  constructor() {
    this.listeners = {};
    this.currentTrackId = null;
    this.currentTime = 0;
    this.duration = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.src = '';
    this.volume = 1;
    this.lastStateAt = 0;
    this.lastStatePosition = 0;
    this.clockRunning = false;
    this.timeTimer = null;

    this.audio = {
      get currentTime() {
        return this._owner.getCurrentTime();
      },
      set currentTime(value) {
        this._owner.seekTo(value);
      },
      get duration() {
        return this._owner.duration;
      },
      get playbackRate() {
        return this._owner.playbackRate;
      },
      set playbackRate(value) {
        this._owner.setPlaybackRate(value);
      },
      get paused() {
        return this._owner.paused;
      },
      get src() {
        return this._owner.src;
      },
      set src(value) {
        this._owner.setSrc(value);
      },
      play: () => this.play(),
      pause: () => this.pause(),
      fastSeek: value => this.seekTo(value),
      _owner: this
    };

    window.__auraSoundNativePlaybackState = (
      playing,
      positionMs,
      durationMs,
      playbackSpeed,
      nativeTrackId = ''
    ) => {
      const activeTrackId = window.app?.state?.currentTrackId;
      if (activeTrackId && String(nativeTrackId || '') !== String(activeTrackId)) {
        return;
      }
      if (nativeTrackId) {
        this.currentTrackId = String(nativeTrackId);
        this.src = `native://${nativeTrackId}`;
      }
      this.paused = !playing;
      this.clockRunning = Boolean(playing);
      this.lastStatePosition = Math.max(0, positionMs / 1000);
      this.currentTime = this.lastStatePosition;
      this.duration = Math.max(0, durationMs / 1000);
      this.playbackRate = playbackSpeed > 0 ? playbackSpeed : 1;
      this.lastStateAt = performance.now();

      if (playing) this.startTimeUpdates();
      else this.stopTimeUpdates();

      this.emit('timeupdate', {
        currentTime: this.getCurrentTime(),
        duration: this.duration
      });
      if (this._notifiedPlaying !== Boolean(playing) || this._notifiedTrackId !== this.currentTrackId) {
        this.emit('playstate', playing);
      }

      if (this.duration > 0 && (this._metadataDuration !== this.duration || this._metadataTrackId !== this.currentTrackId)) {
        this.emit('loadedmetadata', this.duration);
      }
    };

  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (event === 'playstate') {
      this._notifiedPlaying = Boolean(data);
      this._notifiedTrackId = this.currentTrackId;
    } else if (event === 'loadedmetadata') {
      this._metadataDuration = data;
      this._metadataTrackId = this.currentTrackId;
    }
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => callback(data));
    }
  }


  send(type, payload = {}) {
    if (
      window.app &&
      typeof window.app.sendNativeMessage === 'function'
    ) {
      window.app.sendNativeMessage(type, payload);
    }
  }

  async loadTrack(track, startPosition = 0, options = {}) {
    if (!track || !track.filePath) return;

    this.currentTrackId = track.id;
    this.src = `native://${track.id}`;
    this.paused = true;
    this.clockRunning = false;
    const initialPosition = Math.max(0, Number(startPosition) || 0);
    this.currentTime = initialPosition;
    this.duration = Number(track.duration) || 0;
    this.lastStatePosition = initialPosition;
    this.lastStateAt = performance.now();

    if (!options.skipNativeLoad) {
      this.send('track', {
        trackId: track.id,
        title: track.title || 'AuraSound',
        artist: track.artist || '',
        album: track.album || '',
        artworkData: track.artworkData || '',
        filePath: track.filePath,
        position: initialPosition
      });
    }
  }

  async playTrack(track) {
    await this.loadTrack(track);
    this.play();
  }

  releaseTrack(trackId) {
    if (String(this.currentTrackId) !== String(trackId)) return;
    this.send('stop');
    this.currentTrackId = null;
    this.src = '';
    this.paused = true;
    this.currentTime = 0;
    this.duration = 0;
    this.lastStateAt = 0;
    this.lastStatePosition = 0;
    this.clockRunning = false;
    this.stopTimeUpdates();
    this.emit('playstate', false);
  }

  play() {
    if (!this.src) return Promise.resolve();

    const position = Math.max(0, this.getCurrentTime());
    this.currentTime = position;
    this.lastStatePosition = position;
    this.lastStateAt = performance.now();
    this.paused = false;
    this.emit('timeupdate', { currentTime: position, duration: this.duration });
    this.emit('playstate', true);
    this.send('play');
    return Promise.resolve();
  }

  pause() {
    if (!this.src) return;

    const position = Math.max(0, this.getCurrentTime());
    this.currentTime = position;
    this.lastStatePosition = position;
    this.lastStateAt = performance.now();
    this.paused = true;
    this.clockRunning = false;
    this.stopTimeUpdates();
    this.emit('timeupdate', { currentTime: position, duration: this.duration });
    this.emit('playstate', false);
    this.send('pause', { position });
  }

  togglePlay() {
    if (this.paused) this.play();
    else this.pause();
  }

  getCurrentTime() {
    if (this.clockRunning && this.lastStateAt) {
      const elapsed = (performance.now() - this.lastStateAt) / 1000;
      return Math.min(
        this.duration || Infinity,
        this.lastStatePosition + elapsed * this.playbackRate
      );
    }
    return this.currentTime;
  }

  seekTo(seconds) {
    if (!Number.isFinite(seconds)) return;
    const position = Math.max(0, Math.min(
      this.duration || Number.MAX_SAFE_INTEGER,
      seconds
    ));
    this.currentTime = position;
    this.lastStatePosition = position;
    this.lastStateAt = performance.now();
    this.send('seek', { position });
    this.emit('timeupdate', {
      currentTime: position,
      duration: this.duration
    });
  }

  seek(percent) {
    if (!this.duration) return;
    this.seekTo((percent / 100) * this.duration);
  }

  setVolume(percent) {
    this.volume = Math.max(0, Math.min(1, percent / 100));
    this.send('volume', { volume: this.volume });
  }

  setPlaybackRate(speed) {
    if (!Number.isFinite(speed) || speed <= 0) return;
    this.playbackRate = speed;
    this.send('speed', { speed });
  }

  cycleSpeed() {
    const speeds = [0.5, 1.0, 1.25, 1.5, 2.0];
    const index = speeds.findIndex(value => value === this.playbackRate);
    const next = speeds[(index < 0 ? 1 : index + 1) % speeds.length];
    this.setPlaybackRate(next);
    return next;
  }

  setSrc(value) {
    if (!value) {
      this.src = '';
      this.paused = true;
      this.clockRunning = false;
      this.stopTimeUpdates();
      this.send('stop');
      return;
    }
    this.clockRunning = false;
    this.stopTimeUpdates();
    this.src = value;
  }

  startTimeUpdates() {
    if (this.timeTimer || document.visibilityState === 'hidden') return;
    this.timeTimer = window.setInterval(() => {
      if (this.paused) return;
      const currentTime = this.getCurrentTime();
      this.currentTime = currentTime;
      this.emit('timeupdate', {
        currentTime,
        duration: this.duration
      });
    }, 250);
  }

  stopTimeUpdates() {
    if (!this.timeTimer) return;
    clearInterval(this.timeTimer);
    this.timeTimer = null;
  }

  setVisible(visible) {
    if (!visible) {
      this.stopTimeUpdates();
    } else if (this.clockRunning && !this.paused) {
      this.startTimeUpdates();
      this.emit('timeupdate', { currentTime: this.getCurrentTime(), duration: this.duration });
    }
  }

  destroy() {
    this.stopTimeUpdates();
    this.send('stop');
    this.src = '';
    this.paused = true;
    this.clockRunning = false;
  }
}
