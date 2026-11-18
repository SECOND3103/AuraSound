import { AudioPlayer } from './audio-player.js';

export class WebAudioPlayer extends AudioPlayer {
  constructor(readAudioFile) {
    super();
    this.readAudioFile = readAudioFile;
    this.element = new window.Audio();
    this.element.preload = 'metadata';
    this.loadRequest = 0;

    this.element.addEventListener('loadedmetadata', () => {
      if (!this.src) return;
      this.duration = Number.isFinite(this.element.duration) ? this.element.duration : 0;
      if (this.duration > 0) this.emit('loadedmetadata', this.duration);
      this.updateTime();
    });
    this.element.addEventListener('timeupdate', () => this.updateTime());
    this.element.addEventListener('play', () => this.updatePlayState());
    this.element.addEventListener('pause', () => this.updatePlayState());
    this.element.addEventListener('ended', () => {
      this.updatePlayState();
      if (this.src && this.element.ended) this.emit('ended', this.currentTrackId);
    });
  }

  async loadTrack(track, startPosition = 0) {
    this.setSrc('');
    this.currentTrackId = track.id;
    const request = this.loadRequest;
    let file;
    try {
      file = await this.readAudioFile(track.id);
    } catch (error) {
      if (request === this.loadRequest) this.emit('playbackerror', error);
      return false;
    }
    if (request !== this.loadRequest) return false;
    if (!file) {
      this.emit('playbackerror', new Error('Audio file missing from browser storage'));
      return false;
    }

    this.src = URL.createObjectURL(file);
    this.duration = Number(track.duration) || 0;
    this.element.src = this.src;
    this.element.playbackRate = this.playbackRate;
    this.element.currentTime = Math.max(0, Number(startPosition) || 0);
    this.updateTime();
    this.updatePlayState();
    return true;
  }

  async play() {
    if (!this.src) return;
    const source = this.src;
    try {
      await this.element.play();
    } catch (error) {
      if (source === this.src && error.name !== 'AbortError') {
        this.updatePlayState();
        this.emit('playbackerror', error);
      }
    }
  }

  pause() {
    this.element.pause();
  }

  getCurrentTime() {
    return this.element.currentTime;
  }

  seekTo(seconds) {
    if (!this.src || !Number.isFinite(seconds)) return;
    this.element.currentTime = Math.max(0, Math.min(this.duration || Infinity, seconds));
    this.updateTime();
  }

  setVolume(percent) {
    super.setVolume(percent);
    this.element.volume = this.volume;
  }

  setPlaybackRate(speed) {
    super.setPlaybackRate(speed);
    this.element.playbackRate = this.playbackRate;
  }

  setSrc(value) {
    if (value) return;
    this.loadRequest++;
    this.element.pause();
    if (this.src) {
      this.element.removeAttribute('src');
      this.element.load();
      URL.revokeObjectURL(this.src);
    }
    this.duration = 0;
    super.setSrc('');
  }

  releaseTrack(trackId) {
    if (String(this.currentTrackId) !== String(trackId)) return;
    this.setSrc('');
    super.releaseTrack(trackId);
  }

  updateTime() {
    if (!this.src) return;
    this.currentTime = this.getCurrentTime();
    this.emit('timeupdate', { currentTime: this.currentTime, duration: this.duration });
  }

  updatePlayState() {
    this.paused = this.element.paused || this.element.ended;
    const playing = !this.paused;
    if (this._notifiedPlaying !== playing || this._notifiedTrackId !== this.currentTrackId) {
      this.emit('playstate', playing);
    }
  }

  destroy() {
    this.setSrc('');
    super.destroy();
  }
}
