(function applyDarkThemeEarly() {
  document.documentElement.setAttribute('data-theme', 'dark');
})();

window.__auraSoundNativeAction = function(action, value) {
  try {
    if (!window.app || !window.app.player) return;

    switch (action) {
      case 'ended': {
        const endedTrackId = String(value || '');
        const current = window.app.getCurrentTrack();
        if (!current || (endedTrackId && endedTrackId !== window.app.state.currentTrackId)) break;

        if (window.app.state.repeatMode === 'one') {
          if (window.app._repeatRestarting) break;
          window.app._repeatRestarting = true;
          window.app.player.seekTo(0);
          window.app.player.play();
          setTimeout(() => { window.app._repeatRestarting = false; }, 100);
        } else {
          window.app.playNext(false);
          window.app.refreshQueueIfOpen();
        }
        break;
      }
      case 'error': {
        const errorTrackId = String(value || '');
        if (errorTrackId && errorTrackId !== window.app.state.currentTrackId) break;
        window.app.player.paused = true;
        window.app.player.clockRunning = false;
        window.app.player.stopTimeUpdates();
        window.app.player.emit('playstate', false);
        break;
      }
      case 'nativeTransition': {
        const trackId = String(value || '');
        const index = window.app.state.queue.findIndex(track => track.id === trackId);
        if (index < 0) break;
        const track = window.app.state.queue[index];
        if (!track) break;
        window.app.state.queueIndex = index;
        window.app.state.currentTrackId = track.id;
        window.app.state.currentPlaybackPosition = 0;
        window.app.player.currentTrackId = track.id;
        window.app.player.src = `native://${track.id}`;
        window.app.player.duration = Number(track.duration) || 0;
        window.app.player.currentTime = 0;
        window.app.player.lastStatePosition = 0;
        window.app.player.lastStateAt = performance.now();
        void window.app.storage.savePlaybackState(track.id, 0);
        track.playCount = (track.playCount || 0) + 1;
        track.lastPlayedAt = Date.now();
        void window.app.storage.saveTrack(track);
        void window.app.storage.saveStateKey('queueIndex', index);
        window.app.updatePlayerUI(track);
        window.app.refreshQueueIfOpen();
        window.app.renderHome();
        break;
      }
      case 'back':
        window.app.handleBackNavigation();
        break;
    }
  } catch (err) {
    console.warn('[AuraSound Native Media]', err);
  }
};

const APP_VERSION = '1.0.2';
const SPLIT_PLAYER_QUERY = '(min-width: 840px)';

import { StorageManager } from './storage.js';
import { AudioPlayer } from './audio-player.js';
import { WebAudioPlayer } from './web-audio-player.js';
import { NativeMusicStorage } from './native-storage.js';
import {
  buildTrackSearchText,
  escapeHtml,
  formatBytes,
  formatTime,
  formatTotalTime,
  getTrackFolderName
} from './utils.js';

function showAuraDialog(message, { confirm = false, title = 'AuraSound' } = {}) {
  return new Promise((resolve) => {
    const previous = document.getElementById('aura-native-dialog-overlay');
    if (previous?._auraFinish) { previous._auraFinish(false); previous.remove(); }
    else previous?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'aura-native-dialog-overlay';
    overlay.className = 'aura-native-dialog-overlay';
    overlay.innerHTML = `
      <section class="aura-native-dialog" role="alertdialog" aria-modal="true" aria-labelledby="aura-native-dialog-title" aria-describedby="aura-native-dialog-message">
        <div class="aura-native-dialog-mark"><span class="material-symbols-rounded">${confirm ? 'help' : 'graphic_eq'}</span></div>
        <h2 id="aura-native-dialog-title"></h2>
        <p id="aura-native-dialog-message"></p>
        <div class="aura-native-dialog-actions">
          ${confirm ? '<button type="button" class="aura-native-dialog-cancel">취소</button>' : ''}
          <button type="button" class="aura-native-dialog-accept">${confirm ? '확인' : '확인'}</button>
        </div>
      </section>`;
    overlay.querySelector('#aura-native-dialog-title').textContent = title;
    overlay.querySelector('#aura-native-dialog-message').textContent = String(message ?? '');

    const finish = (result) => {
      overlay.classList.remove('visible');
      window.setTimeout(() => overlay.remove(), 160);
      document.removeEventListener('keydown', onKeyDown, true);
      resolve(result);
    };
    overlay._auraFinish = finish;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === 'Enter' && !confirm) {
        event.preventDefault();
        finish(true);
      }
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay && confirm) finish(false);
    });
    overlay.querySelector('.aura-native-dialog-accept').addEventListener('click', () => finish(true));
    overlay.querySelector('.aura-native-dialog-cancel')?.addEventListener('click', () => finish(false));
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      overlay.querySelector('.aura-native-dialog-accept')?.focus();
    });
  });
}

window.alert = (message) => { void showAuraDialog(message); };

class App {
  constructor() {
    this.browserAudio = !NativeMusicStorage.isAvailable() && typeof window.Audio === 'function';
    this.storage = new StorageManager({ browserAudio: this.browserAudio });
    this.player = this.browserAudio
      ? new WebAudioPlayer(id => this.storage.getBrowserAudioFile(id))
      : new AudioPlayer();
    if (this.browserAudio) {
      this.player.on('ended', id => window.__auraSoundNativeAction('ended', id));
      this.player.on('playbackerror', error => {
        alert(error.name === 'NotAllowedError'
          ? '브라우저에서 재생을 시작하지 못했습니다. 재생 버튼을 다시 눌러 주세요.'
          : '이 음악 파일을 재생할 수 없습니다. 파일이 저장되어 있는지와 브라우저가 지원하는 형식인지 확인해 주세요.');
      });
    }
    this.overlayStack = [];
    this.coverIconResizeObserver = null;
    this.coverIconMutationObserver = null;
    this.coverIconObserved = new WeakSet();
    this.lastPlaybackPositionPersistAt = 0;
    this.localStorageObjectCache = new Map();

    this.state = {
      tracks: [],
      playlists: [],

      currentTrackId: null,
      currentPlaybackPosition: 0,

      queue: [],
      queueIndex: -1,
      playbackContext: null,

      isPlaying: false,
      isShuffle: false,
      repeatMode: 'off',

      activeView: 'home',
      activeTab: 'home',
      previousView: 'home',
      detailBackView: 'home',
      detailBackStack: [],

      activeFilter: 'all',
      activeSort: 'addedAt_desc',
      librarySortMode: 'addedAt_desc',
      activeViewMode: 'list',

      activePlaylistId: null,

      detailTrackId: null,

      artistDetailId: null,
      albumDetailId: null,
      folderDetailId: null,

      playlistSortMode: 'default',
      artistSortMode: 'default',

      selectionMode: false,
      selectedTrackIds: new Set(),

      settings: {
        theme: 'dark'
      }
    };

    this.sortOptions = {
      recent_desc: '최근',
      addedAt_desc: '최근 추가순',
      title_asc: '알파벳 순'
    };

    this.playlistSortOptions = {
      default: '기본순 (사용자 지정)',
      recent_desc: '최근',
      addedAt_desc: '최근 추가순',
      title_asc: '알파벳 순'
    };

    this.artistSortOptions = {
      default: '기본순 (사용자 지정)',
      recent_desc: '최근',
      addedAt_desc: '최근 추가순',
      title_asc: '알파벳 순'
    };
  }

  async init() {
    this.initCoverIconSizing();
    await this.storage.init();

    [this.state.tracks, this.state.playlists] = await Promise.all([
      this.storage.getAllTracks(),
      this.storage.getAllPlaylists()
    ]);

    this.migrateTrackData();
    await this.migratePlaylistData();
    await this.migrateTracksToNativeStorage();
    await this.ensureTrackDurations();

    const savedState = new Map((await this.storage.getAllState()).map(entry => [entry.key, entry.value]));
    const getSavedState = key => savedState.has(key) ? savedState.get(key) : null;

    this.setTheme();

    const savedVolume =
      getSavedState('volume');

    const vol =
      savedVolume !== null
        ? savedVolume
        : 15;

    this.player.setVolume(vol);

    document.getElementById('volume-bar').value = vol;

    const savedViewMode =
      getSavedState('viewMode');

    if (savedViewMode) {
      this.state.activeViewMode = savedViewMode;
    }

    this.applyViewModeUI();

    const savedSort =
      getSavedState('activeSort');

    if (savedSort) {
      this.state.activeSort = savedSort === 'artist_asc' ? 'title_asc' : savedSort;
    }
    if (!['recent_desc', 'addedAt_desc', 'title_asc'].includes(this.state.activeSort)) {
      this.state.activeSort = 'addedAt_desc';
    }
    this.state.librarySortMode = this.state.activeSort;

    const savedRepeat =
      getSavedState('repeatMode');

    if (savedRepeat) {
      this.state.repeatMode = savedRepeat;
    }

    const savedShuffle =
      getSavedState('isShuffle');

    if (savedShuffle !== null) {
      this.state.isShuffle = savedShuffle;
    }

    this.initializeDynamicUI();
    this.bindEvents();
    this.setupMarqueeObserver();
    this.setupSwipeDismissals();

    this.renderAll();
    this.updateSettingsUI();

    const lastTrackId =
      getSavedState('lastTrackId');

    const savedPlaybackPosition =
      getSavedState('lastPlaybackPosition');

    let restoredPlaybackPosition = Number.isFinite(Number(savedPlaybackPosition))
      ? Math.max(0, Number(savedPlaybackPosition))
      : 0;

    try {
      const nativeBridge = window.AuraSoundNative;
      if (nativeBridge && typeof nativeBridge.getSavedPlaybackState === 'function') {
        const nativeState = JSON.parse(nativeBridge.getSavedPlaybackState() || '{}');
        if (nativeState.trackId && nativeState.trackId === lastTrackId) {
          const nativePosition = Number(nativeState.position);
          if (Number.isFinite(nativePosition) && nativePosition >= 0) {
            restoredPlaybackPosition = nativePosition;
          }
        }
      }
    } catch (_) {}

    this.state.currentPlaybackPosition = restoredPlaybackPosition;

    const savedQueue =
      getSavedState('queue');

    const savedQueueIdx =
      getSavedState('queueIndex');

    const savedPlaybackContext =
      getSavedState('sourcePlaylist');

    if (lastTrackId) {
      this.state.currentTrackId = lastTrackId;

      if (savedQueue) {
        this.state.queue = savedQueue;
      }

      if (savedQueueIdx !== null) {
        this.state.queueIndex = savedQueueIdx;
      }

      if (savedPlaybackContext) {
        const currentForContext = this.getCurrentTrack();
        this.state.playbackContext = this.normalizePlaybackContext(savedPlaybackContext, currentForContext);
      }

      const track = this.getCurrentTrack();

      if (track) {
        await this.player.loadTrack(
          track,
          this.state.currentPlaybackPosition,
          { skipNativeLoad: true }
        );
        this.syncNativeQueue();
        this.sendNativeMessage('repeat', { mode: this.state.repeatMode });
        this.sendNativeMessage('shuffle', { enabled: this.state.isShuffle });

        this.updatePlayerUI(track);
        this.updateMediaSession(track);
      }
    }
  }

  async persistPlaybackPosition(position = this.player.getCurrentTime()) {
    if (!this.state.currentTrackId) return;

    const numericPosition = Number(position);
    if (!Number.isFinite(numericPosition) || numericPosition < 0) return;

    this.state.currentPlaybackPosition = numericPosition;
    this.lastPlaybackPositionPersistAt = performance.now();

    const trackId = this.state.currentTrackId;
    await this.storage.savePlaybackState(trackId, numericPosition);
  }

  syncNativeQueue() {
    let nativeQueue = [...this.state.queue];
    let nativeIndex = this.state.queueIndex;
    const currentTrack = this.getCurrentTrack();
    const artworkLookup = this.buildArtworkLookup();

    const currentIndex = currentTrack ? nativeQueue.findIndex(track => track.id === currentTrack.id) : -1;
    if (currentTrack && currentIndex < 0) {
      nativeQueue.unshift(currentTrack);
      nativeIndex = 0;
    } else if (currentTrack) {
      if (currentIndex >= 0) {
        nativeIndex = currentIndex;
        this.state.queueIndex = currentIndex;
      }
    }

    this.sendNativeMessage('queue', {
      items: nativeQueue.map(track => ({
        trackId: track.id,
        title: track.title || 'AuraSound',
        artist: track.artist || '',
        album: track.album || '',
        artworkData: this.getTrackArtworkData(track, artworkLookup),
        filePath: track.filePath || ''
      })),
      index: nativeIndex,
      currentTrackId: currentTrack?.id || '',
      repeatMode: this.state.repeatMode,
      shuffle: this.state.isShuffle,
      position: this.state.currentPlaybackPosition
    });
  }

  sendNativeMessage(type, payload = {}) {
    const message =
      JSON.stringify({
        type,
        ...payload
      });

    try {
      if (
        window.AuraSoundNative &&
        typeof window.AuraSoundNative.postMessage === 'function'
      ) {
        window.AuraSoundNative.postMessage(message);
        return true;
      }

      if (
        window.Android &&
        typeof window.Android.handleMediaEvent === 'function'
      ) {
        window.Android.handleMediaEvent(message);
        return true;
      }
    } catch (err) {
      console.warn(
        '[AuraSound Native Bridge]',
        err
      );
    }

    return false;
  }

  setTheme() {
    this.state.settings.theme = 'dark';
    localStorage.setItem('theme', 'dark');
    void this.storage.saveStateKey('theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
  }


  bindEvents() {
    const updateHoverInput = event => {
      const hovering = event.pointerType === 'mouse' || (event.pointerType === 'pen' && event.buttons === 0);
      document.documentElement.classList.toggle('can-hover', hovering);
    };
    for (const type of ['pointerover', 'pointerdown', 'pointermove']) {
      document.addEventListener(type, updateHoverInput, { capture: true, passive: true });
    }
    document
      .querySelectorAll('.nav-btn[data-target-view]')
      .forEach(btn => {
        btn.addEventListener(
          'click',
          e => {
            this.closeCreateMenu();
            this.switchView(e.currentTarget.dataset.targetView);
          }
        );
      });

    document.getElementById('btn-profile')?.addEventListener('click', () => this.openProfileDrawer());
    document.getElementById('btn-close-profile-drawer')?.addEventListener('click', () => this.closeProfileDrawer());
    document.getElementById('profile-drawer-overlay')?.addEventListener('click', event => {
      if (event.target === event.currentTarget) this.closeProfileDrawer();
    });
    document.getElementById('btn-profile-settings')?.addEventListener('click', () => {
      this.closeProfileDrawer();
      this.switchView('settings');
    });
    document.getElementById('btn-settings-back')?.addEventListener('click', () => this.backFromSettings());
    document.getElementById('btn-nav-create')?.addEventListener('click', () => this.toggleCreateMenu());
    document.getElementById('btn-library-add')?.addEventListener('click', () => {
      const overlay = document.getElementById('library-add-sheet-overlay');
      overlay.classList.add('active');
      const sheet = overlay.querySelector('.bottom-sheet');
      sheet.classList.add('is-opening');
      window.setTimeout(() => sheet.classList.remove('is-opening'), 320);
    });
    for (const [prefix, close, duration] of [
      ['btn-create-', () => this.closeCreateMenu(), 220],
      ['btn-library-add-', () => this.closeOverlayWithAnimation('library-add-sheet-overlay'), 290]
    ]) {
      document.getElementById(prefix + 'playlist')?.addEventListener('click', () => {
        close();
        window.setTimeout(() => this.openCreatePlaylistModal(), duration);
      });
      document.getElementById(prefix + 'music')?.addEventListener('click', () => {
        close();
        document.getElementById('audio-file-input')?.click();
      });
      document.getElementById(prefix + 'import')?.addEventListener('click', () => {
        close();
        this.importBackup();
      });
    }
    this.bindProfileDrawerGestures();

    document.querySelectorAll('.view .btn-back').forEach(button => {
      button.addEventListener('click', () => this.navigateBackFromDetail());
    });

    document
      .getElementById('btn-modal-cancel')
      .addEventListener('click', () => {
        document.getElementById('modal-overlay')?.classList.remove('active');
        this.sendNativeMessage('overlay', { open: false, type: 'modal' });
      });

    document
      .getElementById('audio-file-input')
      .addEventListener(
        'change',
        e => this.handleFileImport(e)
      );

    document
      .getElementById('btn-export-backup')
      .addEventListener('click', () => this.exportBackup());

    document
      .getElementById('btn-import-backup')
      .addEventListener('click', () => this.importBackup());

    const libSearchInput =
      document.getElementById(
        'library-search-input'
      );

    const libClearBtn =
      document.getElementById(
        'btn-clear-lib-search'
      );

    document.getElementById('btn-library-search')?.addEventListener('click', event => {
      const box = document.getElementById('library-search-box');
      const opening = box.classList.toggle('hidden') === false;
      event.currentTarget.setAttribute('aria-expanded', String(opening));
      if (opening) {
        this.scrollMainContentToTop();
        libSearchInput.focus();
      } else {
        libClearBtn.click();
      }
    });

    libSearchInput.addEventListener(
      'input',
      e => {
        libClearBtn.classList.toggle(
          'hidden',
          !e.target.value
        );

        this.renderLibrary(
          e.target.value
        );
      }
    );

    libClearBtn.addEventListener(
      'click',
      () => {
        libSearchInput.value = '';
        libClearBtn.classList.add('hidden');

        this.renderLibrary('');
      }
    );

    document
      .querySelectorAll('.chip-filter')
      .forEach(chip => {
        chip.addEventListener(
          'click',
          e => {
            const filterButton = e.currentTarget;
            document
              .querySelectorAll('.chip-filter')
              .forEach(c =>
                c.classList.remove('active')
              );

            filterButton.classList.add('active');

            this.state.activeFilter =
              filterButton.dataset.filter;

            this.renderLibrary(
              libSearchInput.value
            );
          }
        );
      });

    this.bindDetailSearch('playlist-search-input', 'btn-clear-playlist-search', query => {
      if (this.state.activePlaylistId) {
        this.renderPlaylistTracks(this.getPlaylist(this.state.activePlaylistId), query);
      }
    });
    this.bindCollectionDetailScroll();

    document
      .getElementById('btn-open-sort')
      .addEventListener(
        'click',
        () => this.openSortSheet('library')
      );

    document
      .getElementById('btn-open-pl-sort')
      .addEventListener(
        'click',
        () => this.openSortSheet('playlist')
      );

    const playlistTools = {
      'btn-detail-pl-add': playlist => this.modalAddMusicToPlaylist(playlist),
      'btn-detail-pl-edit': playlist => this.modalEditPlaylist(playlist),
      'btn-detail-pl-info': playlist => this.modalEditPlaylistName(playlist)
    };
    for (const [id, open] of Object.entries(playlistTools)) {
      document.getElementById(id)?.addEventListener('click', () => {
        const playlist = this.getPlaylist(this.state.activePlaylistId);
        if (playlist) open(playlist);
      });
    }

    document.getElementById('btn-library-layout').addEventListener('click', () => {
      this.setViewMode(this.state.activeViewMode === 'grid' ? 'list' : 'grid');
    });

    document
      .getElementById('btn-select')
      .addEventListener(
        'click',
        () => this.toggleSelectionMode()
      );

    document
      .getElementById('mini-player-clickable')
      .addEventListener(
        'click',
        () => this.openFullPlayer()
      );

    document
      .getElementById('btn-close-full-player')
      .addEventListener(
        'click',
        () => this.closeFullPlayer()
      );

    for (const id of ['btn-mini-more', 'btn-full-more']) {
      document.getElementById(id)?.addEventListener('click', event => {
        event.stopPropagation();
        const current = this.getCurrentTrack();
        if (current) this.openTrackContextMenu(current);
      });
    }

    document.getElementById('mini-output').addEventListener('click', () => window.AuraSoundNative?.openAudioOutput?.());
    window.AuraSoundNative?.requestAudioOutput?.();
    const playerLayout = window.matchMedia(SPLIT_PLAYER_QUERY);
    const fullPlayer = document.getElementById('full-player');
    document.getElementById('btn-expand-player').addEventListener('click', () => {
      if (playerLayout.matches && fullPlayer.classList.contains('active') && !fullPlayer.classList.contains('is-dismissing')) {
        this.setPlayerExpanded(!fullPlayer.classList.contains('player-expanded'));
      }
    });
    playerLayout.addEventListener('change', () => {
      this.setPlayerExpanded(false);
    });
    fullPlayer.addEventListener('transitionend', event => {
      if (event.target === fullPlayer && event.propertyName === 'width') this.safeApplyMarquee();
    });

    const toggle = e => {
      e.stopPropagation();
      this.player.togglePlay();
    };

    document
      .getElementById('btn-mini-play')
      .addEventListener('click', toggle);

    document
      .getElementById('btn-full-play')
      .addEventListener('click', toggle);

    document
      .getElementById('btn-next')
      .addEventListener(
        'click',
        () => this.playNext(true)
      );

    document
      .getElementById('btn-prev')
      .addEventListener(
        'click',
        () => this.playPrev()
      );

    document
      .getElementById('btn-shuffle')
      .addEventListener(
        'click',
        () => this.toggleShuffle()
      );

    document
      .getElementById('btn-repeat')
      .addEventListener(
        'click',
        () => this.toggleRepeat()
      );

    document
      .getElementById('full-seek-bar')
      .addEventListener(
        'input',
        e => this.player.seek(e.target.value)
      );

    document
      .getElementById('volume-bar')
      .addEventListener(
        'input',
        e => {
          const vol = e.target.value;

          this.player.setVolume(vol);

          this.storage.saveStateKey(
            'volume',
            vol
          );
        }
      );

    document
      .getElementById('btn-speed-toggle')
      .addEventListener(
        'click',
        e => {
          e.target.textContent =
            `${this.player.cycleSpeed().toFixed(1)}x`;
        }
      );

    let timeUiFrame = 0;
    let lastMediaPositionUpdate = 0;
    let latestTimeUiState = null;

    this.player.on(
      'timeupdate',
      ({ currentTime, duration }) => {
        const pct = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
        latestTimeUiState = { currentTime, duration, pct };

        if (!timeUiFrame) {
          timeUiFrame = requestAnimationFrame(() => {
            timeUiFrame = 0;
            const latest = latestTimeUiState;
            if (!latest) return;

            const seekBar = document.getElementById('full-seek-bar');
            const progress = document.getElementById('mini-progress-fill');
            const currentLabel = document.getElementById('time-current');
            const durationLabel = document.getElementById('time-duration');

            if (seekBar) {
              seekBar.value = latest.pct;
              seekBar.style.setProperty('--seek-progress', `${latest.pct}%`);
            }
            if (progress) progress.style.setProperty('--mini-progress', String(latest.pct / 100));
            document.getElementById('mini-player')?.style.setProperty('--mini-progress', String(latest.pct / 100));
            const currentText = formatTime(latest.currentTime);
            const durationText = formatTime(latest.duration);
            if (currentLabel && currentLabel.textContent !== currentText) currentLabel.textContent = currentText;
            if (durationLabel && durationLabel.textContent !== durationText) durationLabel.textContent = durationText;
          });
        }

        const now = performance.now();
        this.state.currentPlaybackPosition = Math.max(0, currentTime);

        if (
          now - this.lastPlaybackPositionPersistAt >= 1000 &&
          this.state.currentTrackId
        ) {
          void this.persistPlaybackPosition(currentTime);
        }

        if (
          duration > 0 && now - lastMediaPositionUpdate >= 500 &&
          !window.AuraSoundNative &&
          'mediaSession' in navigator &&
          'setPositionState' in navigator.mediaSession
        ) {
          lastMediaPositionUpdate = now;
          try {
            navigator.mediaSession.setPositionState({
              duration,
              playbackRate: this.player.audio.playbackRate || 1,
              position: Math.min(currentTime, duration)
            });
          } catch (_) {}
        }
      }
    );

    this.player.on(
      'loadedmetadata',
      duration => {
        document
          .getElementById('time-duration')
          .textContent =
          formatTime(duration);

        if (this.state.currentTrackId) {
          const track =
            this.getCurrentTrack();

          if (
            track &&
            track.duration !== duration
          ) {
            track.duration = duration;

            this.storage.saveTrack(track);
          }
        }
      }
    );

    this.player.on(
      'playstate',
      isPlaying => {
        this.state.isPlaying = isPlaying;

        const icon =
          isPlaying
            ? 'pause'
            : 'play_arrow';

        document
          .querySelector('#btn-mini-play span')
          .textContent = icon;

        document
          .querySelector('#btn-full-play span')
          .textContent = icon;

        this.updatePlaylistPlayButton();

        this.updateActiveTrackHighlights();
        this.updateHomeNowPlayingIndicators();

        if (!isPlaying && this.state.currentTrackId) {
          void this.persistPlaybackPosition(this.player.getCurrentTime());
        }

        const current =
          this.getCurrentTrack();

        if (current) {
          this.updateMediaSession(current);
        }
      }
    );



    document
      .querySelectorAll(
        '.bottom-sheet-overlay, .modal-overlay'
      )
      .forEach(el => {
        el.addEventListener(
          'click',
          e => {
            if (e.target === el) {
              if (el.classList.contains('bottom-sheet-overlay')) {
                this.closeOverlayWithAnimation(el.id);
              } else {
                el.classList.remove('active');
              }
            }
          }
        );
      });

    document.addEventListener(
      'keydown',
      e => {
        if (e.key === 'Escape') {
          document
            .querySelectorAll('.active')
            .forEach(el => {
              if (
                el.classList.contains(
                  'bottom-sheet-overlay'
                ) ||
                el.classList.contains(
                  'modal-overlay'
                )
              ) {
                el.classList.remove('active');
              }
            });
        }
      }
    );

    document
      .getElementById('btn-open-queue')
      .addEventListener(
        'click',
        () => {
          this.renderQueueSheet();

          document
            .getElementById('queue-sheet-overlay')
            .classList.add('active');
        }
      );

    document
      .getElementById('btn-playlist-more')
      .addEventListener(
        'click',
        () => this.openPlaylistMenu()
      );

    document
      .getElementById('btn-reset-data')
      .addEventListener(
        'click',
        () => this.resetAppData()
      );

    window.addEventListener(
      'resize',
      () => this.safeApplyMarquee()
    );

    document
      .getElementById('btn-clear-queue')
      .addEventListener(
        'click',
        async () => {
          this.state.queue = [];
          this.state.queueIndex = -1;

          await this.storage.saveStateKey(
            'queue',
            []
          );

          await this.storage.saveStateKey(
            'queueIndex',
            -1
          );
          this.syncNativeQueue();

          this.renderQueueSheet();
        }
      );

    this.setupQueueDragAndDrop();
  }

  async ensureTrackDurations() {
    const tracksWithMissingDuration = this.state.tracks.filter(
      track => !Number.isFinite(Number(track.duration)) || Number(track.duration) <= 0
    );

    for (const track of tracksWithMissingDuration) {
      try {
        const duration = await this.resolveTrackDuration(track);
        if (duration > 0 && duration !== track.duration) {
          track.duration = duration;
          await this.storage.saveTrack(track);
        }
      } catch (error) {
        console.warn('[AuraSound Duration] 곡 길이 확인 실패:', track.fileName, error);
      }
    }
  }

  async resolveTrackDuration(track) {
    let blob = track.fileBlob || (this.browserAudio ? await this.storage.getBrowserAudioFile(track.id) : null);

    if (!blob && track.filePath && NativeMusicStorage.isAvailable()) {
      const duration = NativeMusicStorage.getDuration(track.filePath);
      if (duration > 0) return duration;
      blob = await NativeMusicStorage.readAsBlob(
        track.filePath,
        track.fileType || 'audio/*'
      );
    }

    if (!blob) return 0;

    const url = URL.createObjectURL(blob);

    try {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.src = url;

      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
          audio.removeEventListener('error', handleError);
          audio.removeAttribute('src');
          audio.load();
        };

        const handleLoadedMetadata = () => {
          const duration = Number(audio.duration);
          cleanup();
          resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
        };

        const handleError = () => {
          cleanup();
          reject(new Error('오디오 메타데이터를 읽을 수 없습니다.'));
        };

        audio.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
        audio.addEventListener('error', handleError, { once: true });
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async exportBackup() {
    if (!NativeMusicStorage.isAvailable() || typeof window.AuraSoundNative?.exportBackup !== 'function') {
      alert('이 기능은 AuraSound Android 앱에서 사용할 수 있습니다.');
      return;
    }

    try {
      const [tracks, playlists, appState] = await Promise.all([
        this.storage.getAllTracks(),
        this.storage.getAllPlaylists(),
        this.storage.getAllState()
      ]);
      const exportTracks = tracks.map((track, index) => ({
        ...track,
        backupFile: `${String(index + 1).padStart(4, '0')}_${(track.id || `track_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_')}_${(track.fileName || 'audio').replace(/[^a-zA-Z0-9._-]/g, '_')}`
      }));

      window.__auraSoundBackupBusy = true;
      window.AuraSoundNative.exportBackup(JSON.stringify({
        tracks: exportTracks,
        playlists,
        appState,
        artistCovers: JSON.parse(localStorage.getItem('auraArtistCovers') || '{}'),
        albumCovers: this.getStoredAlbumCovers(),
        albumTrackOrder: this.getStoredAlbumTrackOrders()
      }));
    } catch (error) {
      window.__auraSoundBackupBusy = false;
      console.error('[AuraSound Backup] 내보내기 준비 실패:', error);
      alert('백업을 준비하지 못했습니다.');
    }
  }

  async importBackup() {
    if (!NativeMusicStorage.isAvailable() || typeof window.AuraSoundNative?.importBackup !== 'function') {
      alert('이 기능은 AuraSound Android 앱에서 사용할 수 있습니다.');
      return;
    }

    if (!(await showAuraDialog('백업 파일의 음악과 플레이리스트를 현재 라이브러리에 추가할까요?\n기존 데이터는 삭제되지 않습니다.', { confirm: true, title: '백업 불러오기' }))) return;
    window.__auraSoundBackupBusy = true;
    window.AuraSoundNative.importBackup();
  }

  ensureImportProgressUI() {
    let panel = document.getElementById('aura-import-progress');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'aura-import-progress';
    panel.className = 'aura-import-progress-overlay';
    panel.innerHTML = `
      <section class="aura-import-progress-panel" role="dialog" aria-modal="true" aria-labelledby="aura-import-title">
        <h2 id="aura-import-title">백업 불러오기</h2>
        <p id="aura-import-message">불러오기를 준비하고 있습니다.</p>
        <div class="aura-import-progress-track"><div id="aura-import-progress-fill"></div></div>
        <div class="aura-import-progress-meta"><span id="aura-import-percent">0%</span><span id="aura-import-count"></span></div>
        <div id="aura-import-results" class="aura-import-results" aria-live="polite"></div>
        <button id="aura-import-close" class="btn-primary" type="button" hidden>닫기</button>
      </section>`;
    document.body.appendChild(panel);
    panel.querySelector('#aura-import-close').addEventListener('click', () => panel.remove());
    return panel;
  }

  updateImportProgress(payload) {
    let data = {};
    try { data = JSON.parse(payload || '{}'); } catch (_) {}
    const panel = this.ensureImportProgressUI();
    const percent = Math.max(0, Math.min(100, Number(data.percent) || 0));
    panel.querySelector('#aura-import-message').textContent = data.message || '불러오는 중입니다.';
    panel.querySelector('#aura-import-progress-fill').style.width = `${percent}%`;
    panel.querySelector('#aura-import-percent').textContent = `${percent}%`;
    panel.querySelector('#aura-import-close').hidden = true;
  }

  showImportSummary(results, addedTracks, addedPlaylists) {
    const panel = this.ensureImportProgressUI();
    panel.querySelector('#aura-import-message').textContent = `완료: 음악 ${addedTracks}곡, 플레이리스트 ${addedPlaylists}개 추가`;
    panel.querySelector('#aura-import-progress-fill').style.width = '100%';
    panel.querySelector('#aura-import-percent').textContent = '100%';
    const successCount = results.filter(item => item.status === 'success').length;
    const failedCount = results.filter(item => item.status === 'failed').length;
    const skippedCount = results.filter(item => item.status === 'skipped').length;
    panel.querySelector('#aura-import-count').textContent = `성공 ${successCount} · 실패 ${failedCount} · 건너뜀 ${skippedCount}`;
    const list = panel.querySelector('#aura-import-results');
    list.replaceChildren();
    if (!results.length) {
      const empty = document.createElement('p');
      empty.textContent = '곡별 결과가 없습니다.';
      list.appendChild(empty);
    } else {
      results.forEach(item => {
        const row = document.createElement('div');
        row.className = `aura-import-result ${item.status || 'failed'}`;
        const title = document.createElement('span');
        title.className = 'aura-import-result-title';
        title.textContent = item.title || item.fileName || '이름 없는 곡';
        const status = document.createElement('span');
        status.className = 'aura-import-result-status';
        status.textContent = item.status === 'success' ? '성공' : item.status === 'skipped' ? '건너뜀' : '실패';
        row.append(title, status);
        if (item.reason) {
          const reason = document.createElement('small');
          reason.textContent = item.reason;
          row.appendChild(reason);
        }
        list.appendChild(row);
      });
    }
    panel.querySelector('#aura-import-close').hidden = false;
  }

  async handleBackupResult(type, payload) {
    if (type === 'progress') {
      this.updateImportProgress(payload);
      return;
    }
    window.__auraSoundBackupBusy = false;
    if (type === 'cancel') { document.getElementById('aura-import-progress')?.remove(); return; }
    if (type === 'error') {
      const panel = document.getElementById('aura-import-progress');
      if (panel) panel.querySelector('#aura-import-message').textContent = `불러오기 실패: ${payload || '알 수 없는 오류'}`;
      console.error('[AuraSound Backup]', payload);
      if (panel) { panel.querySelector('#aura-import-close').hidden = false; panel.querySelector('#aura-import-progress-fill').style.width = '100%'; }
      else alert(`백업 처리에 실패했습니다.\n${payload || ''}`.trim());
      return;
    }
    if (type === 'exported') {
      alert('AuraSound 백업 파일을 저장했습니다.');
      return;
    }
    if (type !== 'imported') return;

    try {
      const data = JSON.parse(payload || '{}');
      const importedTracks = Array.isArray(data.tracks) ? data.tracks : [];
      const importedPlaylists = Array.isArray(data.playlists) ? data.playlists : [];
      const importedState = Array.isArray(data.appState) ? data.appState : [];
      const importedArtistCovers = data.artistCovers && typeof data.artistCovers === 'object' ? data.artistCovers : {};
      const importedAlbumCovers = data.albumCovers && typeof data.albumCovers === 'object' ? data.albumCovers : {};
      const importedAlbumTrackOrder = data.albumTrackOrder && typeof data.albumTrackOrder === 'object' ? data.albumTrackOrder : {};
      const trackResults = Array.isArray(data.trackResults) ? data.trackResults.map(item => ({ ...item })) : [];
      const resultById = new Map(trackResults.filter(item => item.id).map(item => [item.id, item]));

      const existingIds = new Set(this.state.tracks.map(track => track.id));
      const importedIdMap = new Map();
      let addedTracks = 0;

      for (const track of importedTracks) {
        if (!track?.id) continue;
        if (existingIds.has(track.id)) {
          const previous = resultById.get(track.id);
          if (previous) { previous.status = 'skipped'; previous.reason = '같은 ID의 곡이 이미 보관함에 있습니다.'; }
          else { const skipped = { id: track.id, title: track.title || track.fileName || '이름 없는 곡', status: 'skipped', reason: '같은 ID의 곡이 이미 보관함에 있습니다.' }; trackResults.push(skipped); resultById.set(track.id, skipped); }
          continue;
        }
        this.state.tracks.push(track);
        existingIds.add(track.id);
        importedIdMap.set(track.id, track.id);
        const successfulResult = resultById.get(track.id);
        if (successfulResult) { successfulResult.status = 'success'; successfulResult.reason = '불러오기 성공'; }
        else { const addedResult = { id: track.id, title: track.title || track.fileName || '이름 없는 곡', status: 'success', reason: '불러오기 성공' }; trackResults.push(addedResult); resultById.set(track.id, addedResult); }
        await this.storage.saveTrack(track);
        addedTracks++;
      }

      const existingPlaylistIds = new Set(this.state.playlists.map(playlist => playlist.id));
      let addedPlaylists = 0;
      for (const playlist of importedPlaylists) {
        if (!playlist?.id || existingPlaylistIds.has(playlist.id)) continue;
        const trackIds = Array.isArray(playlist.trackIds)
          ? playlist.trackIds.filter(id => importedIdMap.has(id) || existingIds.has(id))
          : [];
        const nextPlaylist = { ...playlist, trackIds };
        this.state.playlists.push(nextPlaylist);
        existingPlaylistIds.add(nextPlaylist.id);
        await this.storage.savePlaylist(nextPlaylist);
        addedPlaylists++;
      }

      const existingArtistCovers = JSON.parse(localStorage.getItem('auraArtistCovers') || '{}');
      Object.entries(importedArtistCovers).forEach(([artistName, coverData]) => {
        if (artistName && coverData) existingArtistCovers[artistName] = coverData;
      });
      localStorage.setItem('auraArtistCovers', JSON.stringify(existingArtistCovers));
      const existingAlbumCovers = this.getStoredAlbumCovers();
      Object.entries(importedAlbumCovers).forEach(([albumId, coverData]) => {
        if (albumId && coverData) existingAlbumCovers[albumId] = coverData;
      });
      localStorage.setItem('auraAlbumCovers', JSON.stringify(existingAlbumCovers));
      const existingAlbumTrackOrder = this.getStoredAlbumTrackOrders();
      Object.entries(importedAlbumTrackOrder).forEach(([albumId, order]) => {
        if (albumId && Array.isArray(order)) existingAlbumTrackOrder[albumId] = order;
      });
      localStorage.setItem('auraAlbumTrackOrder', JSON.stringify(existingAlbumTrackOrder));

      for (const item of importedState) {
        if (!item?.key) continue;
        const exists = await this.storage.getStateKey(item.key);
        if (exists === null || exists === undefined) {
          await this.storage.saveStateKey(item.key, item.value);
        }
      }

      this.renderAll();
      this.updateSettingsUI();
      this.showImportSummary(trackResults, addedTracks, addedPlaylists);
    } catch (error) {
      console.error('[AuraSound Backup] 불러오기 적용 실패:', error);
      const panel = document.getElementById('aura-import-progress');
      if (panel) { panel.querySelector('#aura-import-message').textContent = '백업 파일을 적용하지 못했습니다.'; panel.querySelector('#aura-import-close').hidden = false; }
      else alert('백업 파일을 적용하지 못했습니다.');
    }
  }

  async migrateTracksToNativeStorage() {
    if (!NativeMusicStorage.isAvailable()) return;

    let changed = false;

    for (const track of this.state.tracks) {
      if (track.filePath && !track.fileBlob) continue;
      if (!track.fileBlob) continue;

      try {
        const relativePath = await NativeMusicStorage.importFile(
          track.fileBlob,
          track.id
        );

        track.filePath = relativePath;
        track.folderPath = 'Music';
        track.folderName = 'AuraSound Music';
        track.fileSize = track.fileBlob.size;
        track.fileType = track.fileBlob.type || track.fileType || 'audio/*';
        delete track.fileBlob;

        await this.storage.saveTrack(track);
        changed = true;
      } catch (error) {
        console.error('[AuraSound Storage] 기존 음악 이전 실패:', track.fileName, error);
      }
    }

    if (changed) this.updateSettingsUI();
  }

  migrateTrackData() {
    this.state.tracks.forEach(t => {
      if (t.album === 'Local File') {
        t.album = '';
      }

      t.albumArtist =
        t.albumArtist || '';

      t.genre =
        t.genre || '';

      t.year =
        t.year || '';

      t.trackNumber =
        t.trackNumber || '';

      t.discNumber =
        t.discNumber || '';

      t.comment =
        t.comment || '';

      t.artworkData =
        t.artworkData || '';
      t.customCoverData = t.customCoverData || '';
      if (typeof t.coverFollowsAlbum !== 'boolean') t.coverFollowsAlbum = true;

      t.fileSize =
        t.fileSize ||
        (t.fileBlob?.size || 0);

      t.fileType =
        t.fileType ||
        t.fileBlob?.type ||
        'audio/*';
    });
  }

  async migratePlaylistData() {
    for (const playlist of this.state.playlists) {
      let changed = false;
      if (!('coverData' in playlist)) {
        playlist.coverData = '';
        changed = true;
      }
      if ('pinned' in playlist) {
        delete playlist.pinned;
        changed = true;
      }
      if (changed) await this.storage.savePlaylist(playlist);
    }
  }

  initializeDynamicUI() {
    const info =
      document.querySelector(
        '#view-settings .settings-section:last-child .desc'
      );

    if (info) {
      info.textContent = `AuraSound v${APP_VERSION}`;
    }

    this.ensureSelectionToolbar();
  }

  ensureSelectionToolbar() {
    const library =
      document.getElementById(
        'view-library'
      );

    if (
      !library ||
      document.getElementById(
        'selection-bar'
      )
    ) {
      return;
    }

    const bar =
      document.createElement('div');

    bar.id =
      'selection-bar';

    bar.className =
      'selection-bar hidden';

    bar.innerHTML = `
      <strong id="selection-count">
        0곡 선택
      </strong>

      <button
        class="btn-secondary clickable"
        id="select-all">
        전체 선택
      </button>

      <button
        class="btn-secondary clickable"
        id="select-edit">
        정보 편집
      </button>

      <button
        class="btn-secondary clickable"
        id="select-playlist">
        플레이리스트
      </button>

      <button
        class="btn-secondary clickable"
        id="select-delete">
        삭제
      </button>

      <button
        class="btn-icon clickable"
        id="select-close">
        <span class="material-symbols-rounded">
          close
        </span>
      </button>
    `;

    library.insertBefore(
      bar,
      library.querySelector(
        '.library-content-list'
      )
    );

    bar
      .querySelector('#select-all')
      .onclick =
      () => this.selectAllVisibleTracks();

    bar
      .querySelector('#select-edit')
      .onclick =
      () => {
        const ids =
          [...this.state.selectedTrackIds];

        if (ids.length) {
          const first = this.getTrackById(ids[0]);

          this.openTrackEditor(
            first,
            ids
          );
        }
      };

    bar
      .querySelector('#select-playlist')
      .onclick =
      () => this.addSelectedToPlaylist();

    bar
      .querySelector('#select-delete')
      .onclick =
      () => this.deleteSelectedTracks();

    bar
      .querySelector('#select-close')
      .onclick =
      () => this.toggleSelectionMode(false);
  }

  toggleSelectionMode(force) {
    this.state.selectionMode =
      typeof force === 'boolean'
        ? force
        : !this.state.selectionMode;

    if (!this.state.selectionMode) {
      this.state.selectedTrackIds.clear();
    }

    document
      .getElementById('selection-bar')
      ?.classList.toggle(
        'hidden',
        !this.state.selectionMode
      );

    if (this.state.activeView === 'library') {
      this.renderLibrary(
        document.getElementById(
          'library-search-input'
        ).value
      );
    }

    this.updateSelectionBar();
  }

  updateSelectionBar() {
    const bar =
      document.getElementById(
        'selection-bar'
      );

    if (!bar) return;

    bar.classList.toggle(
      'hidden',
      !this.state.selectionMode
    );

    const count =
      document.getElementById(
        'selection-count'
      );

    if (count) {
      count.textContent =
        `${this.state.selectedTrackIds.size}곡 선택`;
    }
  }

  toggleTrackSelection(id, checked) {
    if (checked) {
      this.state.selectedTrackIds.add(id);
    } else {
      this.state.selectedTrackIds.delete(id);
    }

    this.updateSelectionBar();
  }

  selectAllVisibleTracks() {
    const q =
      (
        document.getElementById(
          'library-search-input'
        ).value || ''
      )
        .toLowerCase()
        .trim();

    const tracks =
      this.state.tracks.filter(
        t =>
          !q ||
          buildTrackSearchText(t)
            .includes(q)
      );

    tracks.forEach(t =>
      this.state.selectedTrackIds.add(
        t.id
      )
    );

    this.renderLibrary(q);
    this.updateSelectionBar();
  }

  async addSelectedToPlaylist() {
    if (!this.state.selectedTrackIds.size) {
      alert('먼저 곡을 선택해주세요.');
      return;
    }

    this.openAddTracksToPlaylistModal(
      [...this.state.selectedTrackIds]
    );
  }

  openAddTracksToPlaylistModal(ids) {
    let html =
      this.state.playlists
        .map(
          p => `
            <button
              class="btn-secondary clickable"
              style="width:100%;margin-bottom:8px;text-align:left"
              data-id="${p.id}">
              ${escapeHtml(p.name)}
            </button>
          `
        )
        .join('');

    if (!html) {
      html =
        '<p>플레이리스트가 없습니다.</p>';
    }

    this.showModal(
      '선택한 곡을 플레이리스트에 추가',
      `
        <div class="modal-body-scroll">
          ${html}
        </div>
      `,
      null
    );

    document
      .querySelectorAll(
        '#modal-body button[data-id]'
      )
      .forEach(btn => {
        btn.onclick =
          async () => {
            const playlist =
              this.getPlaylist(
                btn.dataset.id
              );

            if (playlist) {
              ids.forEach(id => {
                if (
                  !playlist.trackIds.includes(id)
                ) {
                  playlist.trackIds.push(id);
                }
              });

              await this.storage.savePlaylist(
                playlist
              );

              this.toggleSelectionMode(false);

              document
                .getElementById(
                  'modal-overlay'
                )
                .classList.remove('active');

              this.renderAll();
            }
          };
      });

    document
      .getElementById(
        'btn-modal-confirm'
      )
      .style.display = 'none';
  }

  async deleteSelectedTracks() {
    const ids =
      [...this.state.selectedTrackIds];

    if (!ids.length) {
      alert('먼저 곡을 선택해주세요.');
      return;
    }

    if (!(await showAuraDialog(
      `${ids.length}곡을 보관함에서 삭제하시겠습니까?`,
      { confirm: true, title: '곡 삭제' }
    ))) return;

    for (const id of ids) {
      await this.deleteTrackById(id);
    }

    this.toggleSelectionMode(false);

    this.renderAll();
    this.updateSettingsUI();
  }

  async deleteTrackById(id) {
    const track = this.getTrackById(id);
    if (!track) return;

    if (typeof this.player.releaseTrack === 'function') this.player.releaseTrack(id);

    if (track.filePath) {
      const deletionResult = NativeMusicStorage.deleteFile(track.filePath);
      if (deletionResult === false) {
        throw new Error(`음악 파일을 기기에서 삭제하지 못했습니다: ${track.title || track.fileName || ''}`);
      }
    }
    await this.storage.deleteTrack(id);

    this.state.tracks =
      this.state.tracks.filter(
        t => t.id !== id
      );

    for (
      const playlist of this.state.playlists
    ) {
      if (
        playlist.trackIds.includes(id)
      ) {
        playlist.trackIds =
          playlist.trackIds.filter(
            x => x !== id
          );

        await this.storage.savePlaylist(
          playlist
        );
      }
    }

    if (
      this.state.currentTrackId === id
    ) {
      this.player.audio.pause();
      this.player.audio.src = '';

      this.state.currentTrackId = null;

      document
        .getElementById('mini-player')
        .classList.add('hidden');
      this.closeFullPlayer();
    }

    this.state.queue =
      this.state.queue.filter(
        t => t.id !== id
      );

    await this.storage.saveStateKey(
      'queue',
      this.state.queue
    );
    this.syncNativeQueue();
  }

  setAudioOutput(kind, name, canSwitch) {
    const connected = kind === 'bluetooth' || kind === 'wired';
    const player = document.getElementById('mini-player');
    player.classList.toggle('has-headphones', connected);
    document.getElementById('mini-output-name').textContent = name;
    document.getElementById('mini-output-symbol').textContent = kind === 'bluetooth' ? 'bluetooth' : 'headphones';
    const button = document.getElementById('mini-output');
    button.disabled = !canSwitch;
    button.setAttribute('aria-label', (connected ? name : '이 기기') + (canSwitch ? ' · 오디오 출력 변경' : '에서 재생'));
    button.firstElementChild.textContent = connected ? 'headphones' : 'devices';
    this.safeApplyMarquee();
  }

  updateMiniPlayerColor(artwork = '') {
    const playerStyle = document.documentElement.style;
    const artworkKey = artwork || '';
    if (this._miniPlayerColorArtwork === artworkKey) return;
    this._miniPlayerColorArtwork = artworkKey;
    const requestId = (this._miniPlayerColorRequest || 0) + 1;
    this._miniPlayerColorRequest = requestId;
    playerStyle.removeProperty('--playing-artwork-color');
    playerStyle.removeProperty('--mini-cover-color');
    if (!artworkKey) return;

    const fallback = () => {
      if (this._miniPlayerColorRequest === requestId && /^data:image\/[^,]*;base64,/i.test(artworkKey)) {
        window.AuraSoundNative?.getArtworkPaletteColor?.(artworkKey, String(requestId));
      }
    };
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (this._miniPlayerColorRequest !== requestId) return;
      const color = this.sampleArtworkColor(image);
      if (color) this.setMiniPlayerPaletteColor(requestId, color);
      else fallback();
    };
    image.onerror = fallback;
    image.src = artworkKey;
  }

  sampleArtworkColor(image) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 112;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Map();
      let dominant = null;
      for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3] / 255;
        if (alpha < .08) continue;
        const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
        const key = ((red >> 5) * 8 + (green >> 5)) * 8 + (blue >> 5);
        let group = colors.get(key);
        if (!group) {
          group = { red: 0, green: 0, blue: 0, weight: 0 };
          colors.set(key, group);
        }
        group.red += red * alpha;
        group.green += green * alpha;
        group.blue += blue * alpha;
        group.weight += alpha;
        if (!dominant || group.weight > dominant.weight) dominant = group;
      }
      if (!dominant) return null;
      let selected = dominant;
      let best = 0;
      for (const group of colors.values()) {
        const channels = [group.red, group.green, group.blue].map(sum => sum / group.weight);
        const peak = Math.max(...channels);
        const chroma = peak - Math.min(...channels);
        if (chroma < 20 || group.weight < pixels.length / 4 * .008) continue;
        const midtone = Math.min(1, peak / 80, (255 - peak) / 65);
        const score = chroma * Math.sqrt(group.weight) * midtone;
        if (score > best) {
          best = score;
          selected = group;
        }
      }
      return '#' + ['red', 'green', 'blue'].map(channel =>
        Math.round(selected[channel] / selected.weight).toString(16).padStart(2, '0')
      ).join('');
    } catch (_) {
      return null;
    }
  }

  setMiniPlayerPaletteColor(requestId, color) {
    if (Number(requestId) !== this._miniPlayerColorRequest || !/^#[\da-f]{6}$/i.test(color || '')) return;
    const style = document.documentElement.style;
    style.setProperty('--playing-artwork-color', color);
    const rgb = color.slice(1).match(/../g).map(pair => parseInt(pair, 16));
    const peak = Math.max(...rgb);
    const saturation = peak ? 1 - Math.min(...rgb) / peak : 0;
    // Keep muted artwork muted. Increase the contrast of stronger accent colors gradually.
    const intensity = Math.max(0, Math.min(1, (saturation - .42) / .12));
    const gain = Math.min(1 / (saturation || 1), 1 + .16 * intensity);
    const ceiling = 84 - 9 * intensity;
    const scale = ceiling / Math.max(ceiling, peak);
    const background = rgb.map(value => Math.round((peak - (peak - value) * gain) * scale));
    style.setProperty('--mini-cover-color', 'rgb(' + background.join(',') + ')');
  }

  initCoverIconSizing() {
    const coverSelector = [
      '.quick-card-art',
      '.media-card-art',
      '.track-artwork',
      '.mini-album-art',
      '.playlist-cover-large',
      '.artist-home-art',
      '.artist-list-art',
      '.track-detail-art'
    ].join(',');

    const pendingCovers = new Set();
    let sizingFrame = 0;
    const resizeCoverIcon = element => {
      if (!element) return;
      pendingCovers.add(element);
      if (sizingFrame) return;
      sizingFrame = requestAnimationFrame(() => {
        sizingFrame = 0;
        const measurements = [];
        for (const cover of pendingCovers) {
          if (!cover.isConnected) continue;
          const icon = cover.querySelector(':scope > .material-symbols-rounded');
          if (!icon) continue;
          const rect = cover.getBoundingClientRect();
          const size = Math.min(rect.width, rect.height) / 2.5;
          if (size > 0) measurements.push({ icon, fontSize: `${size}px` });
        }
        pendingCovers.clear();
        for (const { icon, fontSize } of measurements) {
          if (icon.style.fontSize !== fontSize) icon.style.fontSize = fontSize;
        }
      });
    };

    const observeCover = element => {
      if (!element || this.coverIconObserved.has(element)) return;
      this.coverIconObserved.add(element);
      resizeCoverIcon(element);
      this.coverIconResizeObserver?.observe(element);
    };

    if (typeof ResizeObserver !== 'undefined') {
      this.coverIconResizeObserver = new ResizeObserver(entries => {
        entries.forEach(entry => resizeCoverIcon(entry.target));
      });
    }

    const scan = root => {
      if (!root) return;
      if (root.nodeType === Node.ELEMENT_NODE && root.matches(coverSelector)) observeCover(root);
      root.querySelectorAll?.(coverSelector).forEach(observeCover);
    };

    scan(document.body);

    if (typeof MutationObserver !== 'undefined') {
      this.coverIconMutationObserver = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          if (mutation.target.matches?.(coverSelector)) resizeCoverIcon(mutation.target);
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) scan(node);
          });
          mutation.removedNodes.forEach(node => {
            if (node.nodeType !== Node.ELEMENT_NODE || node.isConnected) return;
            const covers = [...node.querySelectorAll(coverSelector)];
            if (node.matches(coverSelector)) covers.push(node);
            covers.forEach(cover => {
              this.coverIconResizeObserver?.unobserve(cover);
              this.coverIconObserved.delete(cover);
              pendingCovers.delete(cover);
            });
          });
        });
      });
      this.coverIconMutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    if (!this.coverIconResizeObserver) {
      window.addEventListener('resize', () => {
        document.querySelectorAll(coverSelector).forEach(resizeCoverIcon);
      });
    }
  }

  setCoverElement(
    element,
    data,
    icon = 'music_note'
  ) {
    if (!element) return;

    element.innerHTML = '';

    if (data) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = data;
      img.addEventListener('error', () => {
        element.innerHTML = `<span class="material-symbols-rounded">${icon}</span>`;
      }, { once: true });
      element.appendChild(img);
      return;
    }

    element.innerHTML = `
      <span class="material-symbols-rounded">
        ${icon}
      </span>
    `;
  }

  buildArtworkLookup() {
    const artworkByAlbum = new Map();
    this.state.tracks.forEach(item => {
      if (!item?.artworkData) return;
      const albumName = (item.album || '').trim();
      if (!albumName || albumName.toLowerCase() === 'local file') return;
      const artist = (item.artist || 'Unknown Artist').trim() || 'Unknown Artist';
      const albumId = JSON.stringify([albumName.toLocaleLowerCase(), artist.toLocaleLowerCase()]);
      if (!artworkByAlbum.has(albumId)) artworkByAlbum.set(albumId, item.artworkData);
    });
    return {
      artworkByAlbum,
      albumCovers: this.getStoredAlbumCovers()
    };
  }

  getTrackArtworkData(track, artworkLookup = null) {
    if (!track) return '';
    if (track.coverFollowsAlbum !== false) {
      const albumName = (track.album || '').trim();
      if (!albumName || albumName.toLowerCase() === 'local file') return '';
      const artist = (track.artist || 'Unknown Artist').trim() || 'Unknown Artist';
      const albumId = JSON.stringify([albumName.toLocaleLowerCase(), artist.toLocaleLowerCase()]);
      const albumCovers = artworkLookup ? artworkLookup.albumCovers : this.getStoredAlbumCovers();
      const albumCover = albumCovers[albumId];
      if (albumCover) return albumCover;
      if (artworkLookup) return artworkLookup.artworkByAlbum.get(albumId) || '';
      const matchingTrack = this.state.tracks.find(item =>
        (item.album || '').trim().toLocaleLowerCase() === albumName.toLocaleLowerCase()
        && ((item.artist || 'Unknown Artist').trim() || 'Unknown Artist').toLocaleLowerCase() === artist.toLocaleLowerCase()
        && !!item.artworkData
      );
      return matchingTrack?.artworkData || '';
    }
    return track.customCoverData || '';
  }

  createCoverFilePickerMarkup(inputId) {
    return `
      <div class="cover-file-picker">
        <input class="cover-file-input" id="${inputId}" type="file" accept="image/*" aria-label="커버 이미지 파일 선택">
        <label class="cover-file-button" for="${inputId}">파일 선택</label>
        <button type="button" class="cover-adjust-button clickable" id="${inputId}-adjust">
          <span class="material-symbols-rounded">crop</span><span>사진 조절</span>
        </button>
      </div>`;
  }

  async prepareCoverSource(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'));
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.readAsDataURL(file);
    });
    const image = await this.loadCoverImage(dataUrl);
    const maxDimension = 1200;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이미지 조절을 지원하지 않습니다.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.84);
  }

  loadCoverImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
      image.src = dataUrl;
    });
  }

  async openCoverEditor(options) {
    const {
      title, inputId, previewId, icon = 'music_note', cropShape = 'square', currentData = '',
      sourceDataFallback = currentData, sourceKey, extraHTML = '',
      followCheckboxId = '', followAlbumPreviewData = '', onSave, afterSave
    } = options;
    let sourceRecord = null;
    try { sourceRecord = await this.storage.getCoverSource(sourceKey); } catch (_) {}
    let sourceData = sourceRecord?.sourceData || sourceDataFallback || '';
    let settings = { zoom: 1, x: 50, y: 50, ...(sourceRecord?.settings || {}) };
    let sourceImage = sourceData ? await this.loadCoverImage(sourceData).catch(() => null) : null;
    let cropData = '';

    const body = `
      <div class="modal-body-scroll cover-editor-body">
        <div class="art-preview" id="${previewId}"></div>
        ${this.createCoverFilePickerMarkup(inputId)}
        ${extraHTML}
        <div class="cover-crop-panel" id="${inputId}-crop-panel" hidden>
          <p class="editor-help-text">한 손가락으로 사진을 이동하고, 두 손가락을 오므리거나 벌려 확대·축소하세요. 두 손가락을 함께 움직이면 위치도 조절할 수 있어요.</p>
          <div class="cover-crop-viewport${cropShape === 'circle' ? ' is-circle' : ''}">
            <canvas class="cover-crop-canvas" id="${inputId}-crop-canvas" width="320" height="320" aria-label="사진 자르기 미리보기. 드래그하여 사진 위치 조절" tabindex="0"></canvas>
          </div>
          <div class="cover-crop-actions"><button type="button" class="btn-secondary clickable" id="${inputId}-reset-crop"><span class="material-symbols-rounded">restart_alt</span> 처음으로</button></div>
          <p class="editor-help-text">${cropShape === 'circle' ? '원 안에 보이는 영역이 아티스트 사진에 표시돼요.' : '미리보기 안에 보이는 영역이 커버로 저장돼요.'} 사진 조절을 다시 열면 이전 설정을 이어서 바꿀 수 있습니다.</p>
        </div>
      </div>`;

    this.showModal(title, body, async () => {
      const followsAlbum = followCheckboxId && document.getElementById(followCheckboxId)?.checked;
      if (!sourceData && !followsAlbum) { alert('먼저 사진 파일을 선택해주세요.'); return; }
      if (sourceData && !sourceImage) { sourceImage = await this.loadCoverImage(sourceData).catch(() => null); }
      if (sourceImage) cropData = this.renderCoverCrop(sourceImage, settings, document.getElementById(`${inputId}-crop-canvas`), true);
      try {
        await onSave({ cropData, sourceData, settings, followsAlbum });
        if (sourceData && sourceKey) {
          await this.storage.saveCoverSource({ id: sourceKey, sourceData, settings });
        }
        document.getElementById('modal-overlay').classList.remove('active');
        if (typeof afterSave === 'function') await afterSave();
      } catch (error) {
        if (error?.message && !String(error.message).includes('커버 이미지가 없습니다')) console.error('[AuraSound Cover Editor]', error);
        if (error?.message && !String(error.message).includes('커버 이미지가 없습니다')) alert(error.message);
      }
    });

    const preview = document.getElementById(previewId);
    this.setCoverElement(preview, currentData || '', icon);
    const panel = document.getElementById(`${inputId}-crop-panel`);
    const canvas = document.getElementById(`${inputId}-crop-canvas`);
    const input = document.getElementById(inputId);
    let previewFrame = 0;
    const updatePreview = () => {
      if (previewFrame) return;
      previewFrame = requestAnimationFrame(() => {
        previewFrame = 0;
        if (!canvas?.isConnected || !preview?.isConnected) return;
        if (sourceImage) {
          cropData = this.renderCoverCrop(sourceImage, settings, canvas, true);
          if (!(followCheckboxId && document.getElementById(followCheckboxId)?.checked)) this.setCoverElement(preview, cropData, icon);
        }
      });
    };
    const adjustButton = document.getElementById(`${inputId}-adjust`);
    adjustButton?.addEventListener('click', () => {
      if (!sourceImage) {
        input?.click();
        return;
      }
      panel.hidden = !panel.hidden;
      if (!panel.hidden) updatePreview();
    });
    input?.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        sourceData = await this.prepareCoverSource(file);
        sourceImage = await this.loadCoverImage(sourceData);
        settings = { zoom: 1, x: 50, y: 50 };
        if (followCheckboxId) {
          const follow = document.getElementById(followCheckboxId);
          if (follow) follow.checked = false;
        }
        panel.hidden = false;
        updatePreview();
      } catch (error) {
        alert(error?.message || '이미지를 불러오지 못했습니다.');
      }
    });
    if (canvas) {
      canvas.style.touchAction = 'none';
      const pointers = new Map();
      let gesture = null;
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const getCanvasRect = () => canvas.getBoundingClientRect();
      const panBy = (dx, dy) => {
        if (!sourceImage) return;
        const rect = getCanvasRect();
        if (!rect.width || !rect.height) return;
        const side = Math.min(sourceImage.naturalWidth, sourceImage.naturalHeight) / Math.max(1, Number(settings.zoom) || 1);
        settings.x = Math.max(0, Math.min(100, settings.x - dx * side / rect.width / sourceImage.naturalWidth * 100));
        settings.y = Math.max(0, Math.min(100, settings.y - dy * side / rect.height / sourceImage.naturalHeight * 100));
      };
      const updateGestureBaseline = () => {
        const points = [...pointers.values()];
        if (points.length >= 2) {
          gesture = { type: 'pinch', midpoint: midpoint(points[0], points[1]), distance: Math.max(1, distance(points[0], points[1])) };
        } else if (points.length === 1) {
          gesture = { type: 'pan', point: { ...points[0] } };
        } else gesture = null;
      };
      canvas.addEventListener('pointerdown', event => {
        if (!sourceImage) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
        canvas.classList.add('is-dragging');
        updateGestureBaseline();
        event.preventDefault();
      });
      canvas.addEventListener('pointermove', event => {
        if (!pointers.has(event.pointerId) || !sourceImage) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const points = [...pointers.values()];
        if (points.length >= 2) {
          const mid = midpoint(points[0], points[1]);
          const nextDistance = Math.max(1, distance(points[0], points[1]));
          if (gesture?.type === 'pinch') {
            const ratio = nextDistance / Math.max(1, gesture.distance);
            settings.zoom = Math.max(1, Math.min(3, settings.zoom * ratio));
            panBy(mid.x - gesture.midpoint.x, mid.y - gesture.midpoint.y);
          }
          gesture = { type: 'pinch', midpoint: mid, distance: nextDistance };
        } else if (points.length === 1) {
          const point = points[0];
          if (gesture?.type === 'pan') panBy(point.x - gesture.point.x, point.y - gesture.point.y);
          gesture = { type: 'pan', point: { ...point } };
        }
        updatePreview();
        event.preventDefault();
      });
      const finishCropPointer = event => {
        pointers.delete(event.pointerId);
        updateGestureBaseline();
        if (!pointers.size) canvas.classList.remove('is-dragging');
      };
      canvas.addEventListener('pointerup', finishCropPointer);
      canvas.addEventListener('pointercancel', finishCropPointer);
      canvas.addEventListener('lostpointercapture', finishCropPointer);
    }
    document.getElementById(`${inputId}-reset-crop`)?.addEventListener('click', () => {
      settings = { zoom: 1, x: 50, y: 50 };
      updatePreview();
    });
    if (followCheckboxId) {
      document.getElementById(followCheckboxId)?.addEventListener('change', event => {
        if (event.target.checked) this.setCoverElement(preview, followAlbumPreviewData || '', icon);
        else if (sourceImage) updatePreview();
        else this.setCoverElement(preview, '', icon);
      });
    }
    if (sourceImage) updatePreview();
  }

  renderCoverCrop(image, settings, canvas, asDataUrl = false) {
    if (!image || !canvas) return '';
    const context = canvas.getContext('2d');
    if (!context) return '';
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const side = Math.min(width, height) / Math.max(1, Number(settings.zoom) || 1);
    const maxX = Math.max(0, width - side);
    const maxY = Math.max(0, height - side);
    const centerX = width * (Math.max(0, Math.min(100, Number(settings.x) || 0)) / 100);
    const centerY = height * (Math.max(0, Math.min(100, Number(settings.y) || 0)) / 100);
    const sx = Math.max(0, Math.min(maxX, centerX - side / 2));
    const sy = Math.max(0, Math.min(maxY, centerY - side / 2));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
    return asDataUrl ? canvas.toDataURL('image/jpeg', 0.9) : '';
  }

  addPlaylistCoverButton(playlist) {
    const actions =
      document.querySelector(
        '#view-playlist-detail .playlist-action-btns'
      );

    if (!actions) return;

    let button =
      document.getElementById(
        'btn-playlist-cover-edit'
      );

    if (!button) {
      button =
        document.createElement('button');

      button.id =
        'btn-playlist-cover-edit';

      button.className =
        'btn-secondary clickable';

      button.textContent =
        '커버 변경';

      actions.appendChild(button);
    }

    button.onclick =
      () =>
        this.openPlaylistCoverEditor(
          playlist
        );
  }

  addPlaylistCoverButtonToMenu(
    playlist
  ) {
    const host =
      document
        .getElementById(
          'btn-pl-edit-name'
        )
        ?.parentElement;

    if (!host) return;

    host
      .querySelector(
        '.menu-cover'
      )
      ?.remove();

    const button =
      document.createElement('div');

    button.className =
      'sheet-menu-item clickable menu-cover';

    button.innerHTML = `
      <span class="material-symbols-rounded">
        image
      </span>
      <span>
        커버 변경하기
      </span>
    `;

    button.onclick =
      () => {
        this.closeSheet(
          'playlist-sheet-overlay'
        );

        this.openPlaylistCoverEditor(
          playlist
        );
      };

    host.insertBefore(
      button,
      document.getElementById(
        'btn-pl-add-music'
      )
    );
  }

  openPlaylistCoverEditor(playlist) {
    this.openCoverEditor({
      title: '플레이리스트 커버 변경', inputId: 'playlist-cover-file', previewId: 'playlist-cover-preview',
      icon: 'queue_music', currentData: playlist.coverData || '', sourceKey: `playlist:${playlist.id}`,
      onSave: async ({ cropData }) => {
        if (!cropData) { alert('이미지를 선택하거나 기존 사진을 조절해주세요.'); throw new Error('커버 이미지가 없습니다.'); }
        playlist.coverData = cropData;
        await this.storage.savePlaylist(playlist);
      },
      afterSave: async () => {
        this.openPlaylistDetail(playlist);
        this.renderLibrary(document.getElementById('library-search-input')?.value || '');
      }
    });
  }

  openTrackCoverEditor(track) {
    const currentTrack = this.getTrackById(track?.id) || track;
    if (!currentTrack) return;
    const followsAlbum = currentTrack.coverFollowsAlbum !== false;
    const albumCover = this.getAlbumForTrack(currentTrack)?.coverData || '';
    this.openCoverEditor({
      title: '음악 커버 변경', inputId: 'track-cover-file', previewId: 'track-cover-preview', icon: 'music_note',
      currentData: followsAlbum ? albumCover : (currentTrack.customCoverData || ''),
      sourceDataFallback: currentTrack.customCoverData || '', sourceKey: `track:${currentTrack.id}`,
      extraHTML: `<label class="custom-checkbox-label" style="margin:12px 0;"><input type="checkbox" id="track-cover-follow-album" ${followsAlbum ? 'checked' : ''}><span>앨범 커버를 따르기</span></label><p class="editor-help-text">켜면 해당 곡의 앨범 커버를 사용합니다. 끄면 직접 설정한 커버를 사용하며, 직접 설정한 커버가 없으면 기본 커버가 표시됩니다.</p>`,
      followCheckboxId: 'track-cover-follow-album', followAlbumPreviewData: albumCover,
      onSave: async ({ cropData, sourceData, followsAlbum: follow }) => {
        const storedTrack = this.getTrackById(currentTrack.id) || currentTrack;
        if (cropData && sourceData) storedTrack.customCoverData = cropData;
        storedTrack.coverFollowsAlbum = !!follow;
        await this.storage.saveTrack(storedTrack);
        Object.assign(currentTrack, storedTrack);
      },
      afterSave: async () => {
        this.renderAll();
        this.syncNativeQueue();
        this.refreshQueueIfOpen();
      }
    });
  }

  openTrackEditor(
    track,
    selectedIds = null
  ) {
    const ids =
      selectedIds || [track.id];

    const first = track;

    const body = `
      <div class="modal-body-scroll">

        <p
          style="color:var(--text-secondary);margin-bottom:10px">
          ${
            ids.length > 1
              ? `${ids.length}곡에 적용됩니다.`
              : '음악 정보를 수정합니다.'
          }
        </p>

        <input
          class="form-input"
          id="edit-title"
          value="${escapeHtml(first.title || '')}"
          placeholder="곡 제목">

        <input
          class="form-input"
          id="edit-artist"
          value="${escapeHtml(first.artist || '')}"
          placeholder="아티스트">

        <input
          class="form-input"
          id="edit-album"
          value="${escapeHtml(first.album || '')}"
          placeholder="앨범">

        <input
          class="form-input"
          id="edit-genre"
          value="${escapeHtml(first.genre || '')}"
          placeholder="장르">

        <input
          class="form-input"
          id="edit-year"
          value="${escapeHtml(first.year || '')}"
          placeholder="연도">

        <input
          class="form-input"
          id="edit-track-number"
          value="${escapeHtml(first.trackNumber || '')}"
          placeholder="트랙 번호">

        <input
          class="form-input"
          id="edit-disc-number"
          value="${escapeHtml(first.discNumber || '')}"
          placeholder="디스크 번호">

        <textarea
          class="form-input"
          id="edit-comment"
          placeholder="설명 / 메모">${escapeHtml(first.comment || '')}</textarea>

      </div>
    `;

    this.showModal(
      ids.length > 1
        ? '선택한 음악 정보 편집'
        : '음악 정보 편집',
      body,
      async () => {
        const data = {
          title:
            document.getElementById(
              'edit-title'
            ).value.trim(),

          artist:
            document.getElementById(
              'edit-artist'
            ).value.trim(),

          album:
            document.getElementById(
              'edit-album'
            ).value.trim(),

          genre:
            document.getElementById(
              'edit-genre'
            ).value.trim(),

          year:
            document.getElementById(
              'edit-year'
            ).value.trim(),

          trackNumber:
            document.getElementById(
              'edit-track-number'
            ).value.trim(),

          discNumber:
            document.getElementById(
              'edit-disc-number'
            ).value.trim(),

          comment:
            document.getElementById(
              'edit-comment'
            ).value.trim()
        };

        const editedTracks = [];
        for (const id of ids) {
          const t = this.getTrackById(id);

          if (!t) continue;

          Object.entries(data)
            .forEach(([key, value]) => {
              if (
                ids.length === 1 ||
                value !== ''
              ) {
                t[key] = value;
              }
            });

          editedTracks.push(t);
        }
        await this.storage.saveTracks(editedTracks);

        this.state.tracks =
          await this.storage.getAllTracks();

        document
          .getElementById(
            'modal-overlay'
          )
          .classList.remove('active');

        this.renderAll();

        this.toggleSelectionMode(false);
      }
    );
  }


  async openFileInfo(track) {
    let context = null;
    let bitrate =
      '확인 불가';

    let sampleRate =
      '확인 불가';

    let channels =
      '확인 불가';

    try {
      if (window.AudioContext && (track.fileBlob || track.filePath)) {
        context = new AudioContext();
        const fileBlob = track.fileBlob || await NativeMusicStorage.readAsBlob(track.filePath, track.fileType);

        const buffer =
          await context.decodeAudioData(
            await fileBlob.arrayBuffer()
          );

        sampleRate =
          `${buffer.sampleRate.toLocaleString()} Hz`;

        channels =
          `${buffer.numberOfChannels}ch`;

        if (track.duration) {
          bitrate =
            `약 ${Math.round(
              (track.fileBlob?.size || track.fileSize || fileBlob.size) *
              8 /
              track.duration /
              1000
            )} kbps`;
        }

      }
    } catch (_) {
      if (track.duration) {
        bitrate =
          `약 ${Math.round(
            (track.fileBlob?.size || track.fileSize || 0) *
            8 /
            track.duration /
            1000
          )} kbps`;
      }
    } finally {
      if (context) {
        try { await context.close(); } catch (_) {}
      }
    }

    const date =
      track.addedAt
        ? new Date(
            track.addedAt
          ).toLocaleString('ko-KR')
        : '-';

    this.showModal(
      '음악 파일 정보',
      `
        <div class="modal-body-scroll">

          <div class="info-grid">

            <div class="info-item">
              <small>파일명</small>
              ${escapeHtml(
                track.fileName || '-'
              )}
            </div>

            <div class="info-item">
              <small>형식</small>
              ${escapeHtml(
                track.fileType || '-'
              )}
            </div>

            <div class="info-item">
              <small>파일 크기</small>
              ${formatBytes(
                track.fileSize ||
                track.fileBlob?.size ||
                0
              )}
            </div>

            <div class="info-item">
              <small>재생 시간</small>
              ${formatTime(
                track.duration || 0
              )}
            </div>

            <div class="info-item">
              <small>비트레이트</small>
              ${bitrate}
            </div>

            <div class="info-item">
              <small>샘플레이트</small>
              ${sampleRate}
            </div>

            <div class="info-item">
              <small>채널</small>
              ${channels}
            </div>

            <div class="info-item">
              <small>추가 날짜</small>
              ${date}
            </div>

            <div
              class="info-item"
              style="grid-column:1/-1">

              <small>파일 경로</small>

              ${escapeHtml(
                track.filePath ||
                (track.folderPath
                  ? `${track.folderPath}/${track.fileName || ''}`
                  : `앱 내부 저장소 / ${track.fileName || ''}`)
              )}

            </div>

          </div>

        </div>
      `,
      null
    );

    document
      .getElementById(
        'btn-modal-confirm'
      )
      .style.display = 'none';
  }

  async setViewMode(mode) {
    this.state.activeViewMode =
      mode;

    await this.storage.saveStateKey(
      'viewMode',
      mode
    );

    this.applyViewModeUI();

    this.renderLibrary(
      document.getElementById(
        'library-search-input'
      ).value
    );
  }

  applyViewModeUI() {
    const toggle = document.getElementById('btn-library-layout');
    const grid = this.state.activeViewMode === 'grid';
    toggle.setAttribute('aria-label', grid ? '목록 보기' : '그리드 보기');
    toggle.firstElementChild.textContent = grid ? 'view_list' : 'grid_view';
  }

  handleFileImport(e) {
    const files =
      Array.from(
        e.target.files
      );

    if (!files.length) {
      return;
    }

    const pendingTracks =
      files.map(file => {
        let title =
          file.name.replace(
            /\.[^/.]+$/,
            ''
          );

        let artist =
          'Unknown Artist';

        if (title.includes('-')) {
          const parts =
            title.split('-');

          artist =
            parts[0].trim();

          title =
            parts
              .slice(1)
              .join('-')
              .trim();
        }

        return {
          id:
            'track_' +
            Date.now() +
            '_' +
            Math.random()
              .toString(36)
              .substr(2, 5),

          title,
          artist,

          album: '',
          albumArtist: '',
          genre: '',
          year: '',
          trackNumber: '',
          discNumber: '',
          comment: '',

          artworkData: '',

          duration: 0,

          addedAt:
            Date.now(),

          playCount: 0,
          lastPlayedAt: null,

          fileName:
            file.name,

          fileType:
            file.type ||
            'audio/*',

          fileSize:
            file.size,

          folderPath:
            file.webkitRelativePath
              ? file.webkitRelativePath.split('/').slice(0, -1).join('/')
              : '',

          filePath:
            file.webkitRelativePath ||
            file.name,

          folderName:
            file.webkitRelativePath
              ? file.webkitRelativePath
                  .split('/')
                  .slice(0, -1)
                  .join('/')
              : '추가된 음악',

          fileBlob:
            file,

          _checked: true
        };
      });

    this.openAddMusicModal(
      pendingTracks
    );

    e.target.value = '';
  }

  openAddMusicModal(
    pendingTracks
  ) {
    const renderList =
      tracks => {
        if (!tracks.length) {
          return `
            <p class="empty-state">
              검색 결과가 없습니다.
            </p>
          `;
        }

        return tracks
          .map(
            t => `
              <label class="custom-checkbox-label">

                <input
                  type="checkbox"
                  value="${t.id}"
                  class="pending-track-checkbox"
                  ${t._checked ? 'checked' : ''}>

                <div
                  class="track-artwork"
                  style="
                    width:40px;
                    height:40px;
                    flex-shrink:0">

                  <span
                    class="material-symbols-rounded">
                    music_note
                  </span>

                </div>

                <div
                  style="
                    flex:1;
                    overflow:hidden">

                  <div
                    class="truncate"
                    style="font-weight:500">

                    ${escapeHtml(
                      t.title
                    )}

                  </div>

                  <div
                    class="truncate"
                    style="
                      font-size:.8rem;
                      color:var(--text-secondary)">

                    ${escapeHtml(
                      t.artist
                    )}

                  </div>

                </div>

              </label>
            `
          )
          .join('');
      };

    const bodyHtml = `
      <div
        class="modal-body-scroll"
        style="
          max-height:400px;
          display:flex;
          flex-direction:column;
          gap:12px">

        <div
          class="library-search-wrapper"
          style="
            margin-bottom:0;
            flex-shrink:0">

          <span
            class="material-symbols-rounded search-icon">
            search
          </span>

          <input
            type="text"
            id="pending-search-input"
            placeholder="곡 제목, 아티스트 검색">

        </div>

        <div
          id="pending-list-container"
          style="
            display:flex;
            flex-direction:column;
            gap:8px;
            overflow-y:auto">

          ${renderList(
            pendingTracks
          )}

        </div>

      </div>
    `;

    this.showModal(
      '음악 추가',
      bodyHtml,
      async () => {
        const selectedIds = new Set(
          Array.from(
            document.querySelectorAll(
              '.pending-track-checkbox:checked'
            )
          ).map(
            cb => cb.value
          ));

        const selectedTracks =
          pendingTracks.filter(
            t =>
              selectedIds.has(
                t.id
              )
          );

        for (const track of selectedTracks) {
          try {
            if (!track.duration || track.duration <= 0) {
              track.duration = await this.resolveTrackDuration(track);
            }

            if (NativeMusicStorage.isAvailable()) {
              track.filePath = await NativeMusicStorage.importFile(
                track.fileBlob,
                track.id
              );
              track.folderPath = 'Music';
              track.folderName = 'AuraSound Music';
              track.fileSize = track.fileBlob.size;
              track.fileType = track.fileBlob.type || track.fileType || 'audio/*';
              delete track.fileBlob;
            }

            if (this.browserAudio) {
              await this.storage.saveBrowserTrack(track);
              delete track.fileBlob;
            } else {
              await this.storage.saveTrack(track);
            }
            this.state.tracks.push(track);
          } catch (error) {
            console.error('[AuraSound Storage] 음악 저장 실패:', track.fileName, error);
            alert(`${track.fileName}을(를) 저장하지 못했습니다.`);
          }
        }

        this.renderAll();
        this.updateSettingsUI();

        document
          .getElementById(
            'modal-overlay'
          )
          .classList.remove(
            'active'
          );
      }
    );

    document
      .getElementById(
        'pending-search-input'
      )
      .addEventListener(
        'input',
        e => {
          const q =
            e.target.value
              .toLowerCase();

          const currentChecked =
            new Set(
              Array.from(
                document.querySelectorAll(
                  '.pending-track-checkbox:checked'
                )
              ).map(
                cb => cb.value
              )
            );

          const currentUnchecked =
            new Set(
              Array.from(
                document.querySelectorAll(
                  '.pending-track-checkbox:not(:checked)'
                )
              ).map(
                cb => cb.value
              )
            );

          pendingTracks.forEach(t => {
            if (
              currentChecked.has(
                t.id
              )
            ) {
              t._checked = true;
            }

            if (
              currentUnchecked.has(
                t.id
              )
            ) {
              t._checked = false;
            }
          });

          const filtered =
            pendingTracks.filter(
              t =>
                t.title
                  .toLowerCase()
                  .includes(q) ||
                t.artist
                  .toLowerCase()
                  .includes(q)
            );

          document
            .getElementById(
              'pending-list-container'
            )
            .innerHTML =
            renderList(
              filtered
            );
        }
      );
  }

  normalizePlaybackContext(sourceContext, track) {
    const source = sourceContext && typeof sourceContext === 'object' ? sourceContext : {};
    const trackTitle = (track?.title || '').trim();
    const trackArtist = (track?.artist || '').trim();
    const trackAlbum = (track?.album || '').trim();
    let type = source.type;

    if (!['playlist', 'artist', 'album', 'library', 'folder'].includes(type)) {
      const playlist = this.state.playlists.find(item => item.id === source.id);
      if (Array.isArray(source.trackIds) || playlist) type = 'playlist';
      else if (String(source.id || '').startsWith('folder_')) type = 'folder';
      else if (String(source.id || '').startsWith('artist:') || (source.name && source.name === trackArtist)) type = 'artist';
      else if (source.name && source.name === trackAlbum) type = 'album';
      else type = 'library';
    }

    let name = (source.name || '').trim();
    if (type === 'playlist') {
      const playlist = this.state.playlists.find(item => item.id === source.id);
      name = (playlist?.name || name || '플레이리스트').trim();
    } else if (type === 'artist') {
      name = (name || trackArtist || trackTitle).trim();
    } else if (type === 'album') {
      const album = source.id ? this.getAlbumGroups().find(item => item.id === source.id) : null;
      name = (album?.name || name || trackAlbum || trackTitle).trim();
    } else if (type === 'folder') {
      name = (name || trackTitle).trim();
    } else {
      type = 'library';
      name = trackTitle;
    }

    return { ...source, type, name, id: source.id ?? null };
  }

  async playTrack(
    track,
    queueList = [],
    index = 0,
    sourceContext = null
  ) {
    const playbackRequest = this.browserAudio ? (this.browserPlaybackRequest || 0) + 1 : null;
    if (this.browserAudio) this.browserPlaybackRequest = playbackRequest;
    this.state.currentTrackId =
      track.id;
    this.state.currentPlaybackPosition = 0;
    const loaded = await this.player.loadTrack(track, 0, { skipNativeLoad: true });
    if (loaded === false || (this.browserAudio && this.browserPlaybackRequest !== playbackRequest)) return;

    this.state.queue =
      queueList.length
        ? queueList
        : [track];

    this.state.queueIndex =
      index;

    let normalizedPlaybackContext = this.normalizePlaybackContext(sourceContext, track);
    this.state.playbackContext = normalizedPlaybackContext;

    if (normalizedPlaybackContext.type === 'playlist') {
      const sourcePlaylist = this.state.playlists.find(playlist => playlist.id === normalizedPlaybackContext.id);
      if (sourcePlaylist) {
        sourcePlaylist.lastPlayedAt = Date.now();
        normalizedPlaybackContext = { ...sourcePlaylist, type: 'playlist' };
        this.state.playbackContext = normalizedPlaybackContext;
        await this.storage.savePlaylist(sourcePlaylist);
      }
    }

    this.syncNativeQueue();

    track.playCount =
      (track.playCount || 0) + 1;

    track.lastPlayedAt =
      Date.now();

    await this.storage.saveTrack(
      track
    );

    if (this.browserAudio && this.browserPlaybackRequest !== playbackRequest) return;
    await this.storage.saveStateEntries([
      { key: 'lastTrackId', value: track.id },
      { key: 'lastPlaybackPosition', value: 0 },
      { key: 'queue', value: this.state.queue },
      { key: 'queueIndex', value: this.state.queueIndex },
      { key: 'sourcePlaylist', value: this.state.playbackContext }
    ]);

    if (this.browserAudio && this.browserPlaybackRequest !== playbackRequest) return;
    this.player.play();

    this.updatePlayerUI(
      track
    );
    this.refreshQueueIfOpen();

    this.updateMediaSession(
      track
    );

    this.renderHome();
  }

  playNext(force = false) {
    if (!this.state.queue.length) {
      return;
    }

    let nextIdx =
      this.state.queueIndex + 1;

    if (this.state.isShuffle) {
      nextIdx =
        Math.floor(
          Math.random() *
          this.state.queue.length
        );
    } else if (
      nextIdx >=
      this.state.queue.length
    ) {
      if (
        this.state.repeatMode ===
        'all'
      ) {
        nextIdx = 0;
      } else if (force) {
        nextIdx = 0;
      } else {
        return;
      }
    }

    this.playTrack(
      this.state.queue[nextIdx],
      this.state.queue,
      nextIdx,
      this.state.playbackContext
    );
  }

  playPrev() {
    if (!this.state.queue.length) {
      return;
    }

    let prevIdx =
      this.state.queueIndex - 1;

    if (prevIdx < 0) {
      prevIdx =
        this.state.queue.length - 1;
    }

    this.playTrack(
      this.state.queue[prevIdx],
      this.state.queue,
      prevIdx,
      this.state.playbackContext
    );
  }

  getTrackById(id) {
    const tracks = this.state.tracks;
    if (this._indexedTracks !== tracks || this._indexedTrackCount !== tracks.length) {
      this._trackById = new Map();
      for (const track of tracks) {
        if (!this._trackById.has(track.id)) this._trackById.set(track.id, track);
      }
      this._indexedTracks = tracks;
      this._indexedTrackCount = tracks.length;
    }
    return this._trackById.get(id);
  }

  getCurrentTrack() {
    return this.getTrackById(this.state.currentTrackId);
  }

  getPlaylist(id) {
    return this.state.playlists.find(
      p => p.id === id
    );
  }

  switchView(viewName) {
    if (
      this.state.activeView !==
      viewName
    ) {
      this.state.previousView =
        this.state.activeView;
    }

    if (['home', 'library', 'settings'].includes(viewName) && this.state.activeView !== viewName) {
      this.state.detailBackStack = [];
      this.state.detailBackView = viewName;
    }

    this.state.activeView =
      viewName;

    this.sendNativeMessage('view', { view: viewName });

    document
      .querySelectorAll('.view')
      .forEach(v =>
        v.classList.remove('active')
      );

    const isBrowseTab = viewName === 'home' || viewName === 'library';
    if (isBrowseTab) this.state.activeTab = viewName;
    const activeTab = this.state.activeTab || 'home';
    document.querySelectorAll('.nav-btn[data-target-view]').forEach(button => {
      const active = button.dataset.targetView === activeTab;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    const settings = viewName === 'settings';
    document.getElementById('app-header')?.classList.toggle('hidden', settings);
    document.getElementById('settings-app-header')?.classList.toggle('hidden', !settings);
    const browseTitle = document.getElementById('browse-header-title');
    if (browseTitle) browseTitle.textContent = activeTab === 'library' ? '보관함' : '홈';
    document.getElementById('library-header-actions')?.classList.toggle('hidden', viewName !== 'library');

    const view = document.getElementById(`view-${viewName}`);
    view?.classList.add('active');
    this.setCollectionDetailView(view);

    if (viewName === 'home') {
      this.renderHome();
    }

    if (viewName === 'library') {
      this.renderLibrary(
        document.getElementById(
          'library-search-input'
        ).value
      );
    }

    if (viewName === 'settings') {
      this.updateSettingsUI();
    }

    this.scrollMainContentToTop();

    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  openProfileDrawer() {
    const overlay = document.getElementById('profile-drawer-overlay');
    if (!overlay) return;
    document.getElementById('playback-shell')?.classList.add('profile-drawer-open');
    overlay.classList.add('active');
    this.sendNativeMessage('overlay', { open: true, type: 'profile-drawer' });
  }

  closeProfileDrawer(dragged = false) {
    const overlay = document.getElementById('profile-drawer-overlay');
    if (!overlay?.classList.contains('active')) return;
    const drawer = overlay.querySelector('.profile-drawer');
    const appShell = document.getElementById('playback-shell');
    if (dragged && drawer && appShell) {
      drawer.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1)';
      drawer.style.transform = `translate3d(-${drawer.clientWidth}px,0,0)`;
      appShell.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1)';
      appShell.style.transform = 'translate3d(0,0,0) scale(1)';
      overlay.classList.remove('active');
      appShell.classList.remove('profile-drawer-open');
      window.setTimeout(() => {
        drawer.style.transition = '';
        drawer.style.transform = '';
        appShell.style.transition = '';
        appShell.style.transform = '';
      }, 320);
    } else {
      overlay.classList.remove('active');
      appShell?.classList.remove('profile-drawer-open');
    }
    this.sendNativeMessage('overlay', { open: false, type: 'profile-drawer' });
  }

  bindProfileDrawerGestures() {
    const overlay = document.getElementById('profile-drawer-overlay');
    const drawer = overlay?.querySelector('.profile-drawer');
    const appShell = document.getElementById('playback-shell');
    if (!overlay || !drawer || !appShell) return;

    const bindDismissSwipe = (target, canStart) => {
      let pointerId = null;
      let startX = 0;
      let startY = 0;
      let width = 0;
      let dragging = false;

      target.addEventListener('pointerdown', event => {
        if (!overlay.classList.contains('active') || event.button !== 0 || !canStart(event)) return;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        width = drawer.clientWidth;
        dragging = false;
      });

      target.addEventListener('pointermove', event => {
        if (event.pointerId !== pointerId) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!dragging) {
          if (dx > -8 || Math.abs(dx) <= Math.abs(dy)) return;
          dragging = true;
          try { target.setPointerCapture(pointerId); } catch (_) {}
        }
        const progress = Math.min(1, Math.max(0, -dx / Math.max(1, width)));
        const shift = Math.min(0, Math.max(-width, dx));
        const appShift = width * (1 - progress);
        const appScale = 1 - .015 * (1 - progress);
        drawer.style.transition = 'none';
        appShell.style.transition = 'none';
        drawer.style.transform = `translate3d(${shift}px,0,0)`;
        appShell.style.transform = `translate3d(${appShift}px,0,0) scale(${appScale})`;
        event.preventDefault();
      }, { passive: false });

      const finish = event => {
        if (event.pointerId !== pointerId) return;
        const dx = event.clientX - startX;
        pointerId = null;
        try { target.releasePointerCapture(event.pointerId); } catch (_) {}
        if (dragging && dx < -Math.min(96, width * .22)) {
          this.closeProfileDrawer(true);
        } else if (dragging) {
          drawer.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1)';
          appShell.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1)';
          drawer.style.transform = '';
          appShell.style.transform = '';
          window.setTimeout(() => {
            drawer.style.transition = '';
            appShell.style.transition = '';
          }, 300);
        }
        dragging = false;
      };

      target.addEventListener('pointerup', finish);
      target.addEventListener('pointercancel', finish);
    };

    bindDismissSwipe(drawer, event => drawer.contains(event.target));
    bindDismissSwipe(overlay, event => event.target === overlay);
  }

  toggleCreateMenu() {
    const overlay = document.getElementById('create-sheet-overlay');
    if (overlay?.classList.contains('active') && !overlay.querySelector('.is-dismissing')) this.closeCreateMenu();
    else this.openCreateMenu();
  }

  closeCreateMenu() {
    const button = document.getElementById('btn-nav-create');
    button?.classList.remove('is-open');
    button?.setAttribute('aria-label', '만들기 메뉴 열기');
    this.closeOverlayWithAnimation('create-sheet-overlay');
  }

  openCreateMenu() {
    const overlay = document.getElementById('create-sheet-overlay');
    const sheet = overlay?.querySelector('.bottom-sheet');
    if (!overlay || !sheet) return;
    window.clearTimeout(this._createMenuTimer);
    sheet.classList.remove('is-dismissing');
    sheet.style.transform = '';
    sheet.style.opacity = '';
    overlay.style.removeProperty('--sheet-backdrop-progress');
    document.getElementById('btn-nav-create')?.classList.add('is-open');
    document.getElementById('btn-nav-create')?.setAttribute('aria-label', '만들기 메뉴 닫기');
    overlay.classList.add('active');
    sheet.classList.add('is-opening');
    this._createMenuTimer = window.setTimeout(() => sheet.classList.remove('is-opening'), 340);
    this.sendNativeMessage('overlay', { open: true, type: 'create-sheet' });
  }

  scrollMainContentToTop() {
    const content = document.querySelector('.content-area');
    const activeView = document.querySelector('.view.active');
    const search = this._collectionDetail?.searchAboveCover;
    const searchHasQuery = search?.querySelector('input').value.trim();
    const showSearch = search && getComputedStyle(search).getPropertyValue('--show-playlist-search').trim() === '1';
    if (content) content.scrollTop = search && !showSearch && !searchHasQuery ? search.offsetHeight : 0;
    if (activeView) activeView.scrollTop = 0;
    this.updateCollectionDetailScroll();
  }

  setCollectionDetailView(view) {
    this._collectionDetail = null;
    const isDetail = Boolean(view?.classList.contains('collection-detail'));
    document.getElementById('app')?.classList.toggle('detail-view-open', isDetail);
    if (!isDetail) return;

    const navigation = view.querySelector('.detail-navigation');
    navigation.querySelector('.detail-navigation-title').textContent = view.querySelector('h2').textContent;
    const search = view.querySelector('.detail-search-panel');
    if (search) search.querySelector('button').classList.toggle('hidden', !search.querySelector('input').value.trim());
    const artwork = view.querySelector('.playlist-cover-large, .detail-artist-banner');
    const detail = {
      view, navigation, artwork,
      searchAboveCover: view.querySelector('.detail-search-panel--above-cover'),
      isArtist: view.classList.contains('collection-detail--artist'),
      actions: navigation.querySelector('.detail-nav-right'),
      more: navigation.querySelector('.detail-more'),
      playAnchor: view.querySelector('.detail-play-slot, .playlist-action-btns .btn-primary-play'),
      cover: view.querySelector('.playlist-detail-header')
    };
    this._collectionDetail = detail;
    this.updateCollectionDetailArtworkColor(detail);
  }

  updateCollectionDetailArtworkColor(detail) {
    const { view, artwork } = detail;
    view.style.removeProperty('--detail-artwork-color');
    const image = artwork.querySelector('img');
    if (!image) return;
    const applyColor = () => {
      if (this._collectionDetail !== detail || image.parentElement !== artwork || !image.naturalWidth) return;
      const color = this.sampleArtworkColor(image);
      if (color) view.style.setProperty('--detail-artwork-color', color);
    };
    if (image.complete) applyColor();
    else image.addEventListener('load', applyColor, { once: true });
  }

  updateCollectionDetailScroll() {
    if (!this._collectionDetail) return;
    const { view, navigation, actions, more, playAnchor, cover, artwork, isArtist, searchAboveCover } = this._collectionDetail;
    const bar = navigation.getBoundingClientRect();
    const destination = isArtist ? null : actions.getBoundingClientRect();
    const origin = playAnchor.getBoundingClientRect();
    const hero = cover.getBoundingClientRect();
    const destinationY = bar.bottom;
    const remainingY = origin.top + origin.height / 2 - destinationY;
    const collapse = Math.max(0, Math.min(1, 1 - remainingY / 72));
    const heroOffset = Math.max(0, bar.top - hero.top);
    view.style.setProperty('--detail-collapse', String(collapse));
    if (searchAboveCover) {
      const artworkHeight = Math.max(1, artwork.offsetHeight);
      const shrink = Math.min(heroOffset, artworkHeight * .64);
      view.style.setProperty('--playlist-cover-offset', `${shrink}px`);
      view.style.setProperty('--playlist-cover-scale', String(1 - shrink / artworkHeight));
    } else if (isArtist) {
      const fade = Math.min(1, heroOffset / Math.max(120, hero.height * .72));
      view.style.setProperty('--detail-cover-progress', String(fade));
    }
    if (destination) {
      view.style.setProperty('--detail-play-x', `${origin.right - destination.right}px`);
      view.style.setProperty('--detail-play-y', `${destinationY - destination.top - destination.height / 2 + Math.max(0, remainingY)}px`);
      more.inert = collapse >= .98;
      view.classList.add('detail-positioned');
    }
  }

  bindCollectionDetailScroll() {
    const content = document.getElementById('content-area');
    if (!content) return;
    let frame = 0;
    const requestUpdate = () => {
      if (!this._collectionDetail || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        this.updateCollectionDetailScroll();
      });
    };
    content.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate, { passive: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(requestUpdate).observe(content);
    document.fonts?.ready.then(requestUpdate);
  }

  setupMarqueeObserver() {
    if (this._marqueeObserver) this._marqueeObserver.disconnect();
    const root = document.getElementById('app') || document.body;
    let timer = 0;
    this._marqueeObserver = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => this.safeApplyMarquee(), 40);
    });
    this._marqueeObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  openFullPlayer() {
    const full = document.getElementById('full-player');
    if (!full || full.classList.contains('active')) return;

    full.scrollTop = 0;
    full.classList.remove('closing', 'is-dismissing', 'is-dragging');
    full.style.transition = 'none';
    full.style.transform = window.matchMedia(SPLIT_PLAYER_QUERY).matches ? '' : 'translate3d(0, 100%, 0)';
    full.style.opacity = '1';
    void full.offsetHeight;
    full.classList.add('active', 'is-opening');
    this.setPlayerExpanded(false);
    full.style.transform = '';
    full.style.transition = '';

    window.setTimeout(() => {
      full.classList.remove('is-opening');
    }, 360);

    this.sendNativeMessage('overlay', { open: true, type: 'full-player' });
    this.safeApplyMarquee();
  }

  setPlayerExpanded(expanded) {
    const full = document.getElementById('full-player');
    full.classList.toggle('player-expanded', expanded);
    const modalPlayer = full.classList.contains('active')
      && (expanded || !window.matchMedia(SPLIT_PLAYER_QUERY).matches);
    document.getElementById('app').inert = modalPlayer;
    document.querySelector('.bottom-nav').inert = modalPlayer;
    document.getElementById('mini-player').inert = full.classList.contains('active');
    const button = document.getElementById('btn-expand-player');
    button.setAttribute('aria-pressed', String(expanded));
    button.setAttribute('aria-label', expanded ? '오른쪽 플레이어로 접기' : '전체 화면으로 펼치기');
    full.scrollTop = 0;
    this.safeApplyMarquee();
  }

  closeFullPlayer() {
    const full = document.getElementById('full-player');
    if (!full || !full.classList.contains('active') || full.classList.contains('is-dismissing')) return;

    full.classList.remove('is-opening', 'is-dragging');
    full.classList.add('is-dismissing');
    const closeToDock = window.matchMedia(SPLIT_PLAYER_QUERY).matches
      && !full.classList.contains('player-expanded') && !full.style.transform;
    if (closeToDock) {
      full.style.clipPath = 'var(--minimized-player-clip)';
    } else {
      full.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1), opacity .24s ease';
      full.style.transform = 'translate3d(0, 100%, 0)';
      full.style.opacity = '0';
    }

    window.setTimeout(() => {
      full.classList.remove('active', 'is-dismissing');
      full.style.clipPath = '';
      this.setPlayerExpanded(false);
      full.style.transition = 'none';
      full.style.transform = 'translate3d(0, 100%, 0)';
      full.style.opacity = '0';
      this.sendNativeMessage('overlay', { open: false, type: 'full-player' });

      requestAnimationFrame(() => {
        full.style.transform = 'translate3d(0, 100%, 0)';
        full.style.opacity = '1';
        full.style.transition = '';
        this.safeApplyMarquee();
      });
    }, 290);
  }

  setupSwipeDismissals() {
    const notifyOverlayState = () => {
      const anyOverlay = !!document.querySelector('.bottom-sheet-overlay.active, .modal-overlay.active, #full-player.active');
      this.sendNativeMessage('overlay', { open: anyOverlay, type: 'overlay' });
    };

    const overlayObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;
        const el = mutation.target;
        const id = el.id;
        const isActive = el.classList.contains('active');
        if (id === 'create-sheet-overlay') {
          const createButton = document.getElementById('btn-nav-create');
          const createSheet = el.querySelector('.bottom-sheet');
          const isOpening = isActive && !createSheet?.classList.contains('is-dismissing');
          createButton?.classList.toggle('is-open', isOpening);
          createButton?.setAttribute('aria-expanded', String(isOpening));
          createButton?.setAttribute('aria-label', isOpening ? '만들기 메뉴 닫기' : '만들기 메뉴 열기');
        }
        if (isActive && !this.overlayStack.includes(id)) {
          el.scrollTop = 0;
          el.querySelectorAll('.bottom-sheet, .sheet-menu-list, .create-sheet-options, .modal-dialog, .modal-body-scroll, .queue-list')
            .forEach(scrollable => { scrollable.scrollTop = 0; });
        }
        const index = this.overlayStack.indexOf(id);
        if (isActive && index === -1) this.overlayStack.push(id);
        if (!isActive && index !== -1) this.overlayStack.splice(index, 1);
      }
      notifyOverlayState();
    });
    document.querySelectorAll('.bottom-sheet-overlay, .modal-overlay, #profile-drawer-overlay, #full-player').forEach(el => {
      overlayObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
    });

    document.querySelectorAll('.bottom-sheet-overlay').forEach(overlay => {
      const sheet = overlay.querySelector('.bottom-sheet');
      if (!sheet) return;
      let gesture = null;
      let pointerId = null;
      let touchId = null;
      let suppressClick = false;

      const start = (target, point) => {
        suppressClick = false;
        if (!overlay.classList.contains('active') || sheet.classList.contains('is-dismissing')) return;
        if (target.closest('input, textarea, select, [draggable="true"], .drag-handle')) return;
        const scroller = target.closest('.sheet-menu-list, .queue-list, .create-sheet-options') || sheet;
        if (scroller.scrollTop > 1) return;
        gesture = { x: point.clientX, y: point.clientY, distance: 0, dragging: false };
      };

      const move = (point, event) => {
        if (!gesture || sheet.classList.contains('is-dismissing')) return;
        const dy = point.clientY - gesture.y;
        const dx = Math.abs(point.clientX - gesture.x);
        if (!gesture.dragging) {
          if (Math.max(dx, Math.abs(dy)) < 5) return;
          if (dy <= dx) {
            gesture = null;
            return;
          }
          gesture.dragging = true;
          suppressClick = true;
          const { transform, opacity } = getComputedStyle(sheet);
          gesture.position = new DOMMatrix(transform === 'none' ? undefined : transform);
          gesture.startOffset = gesture.position.m42;
          if (sheet.classList.contains('is-opening')) sheet.style.opacity = opacity;
          sheet.classList.remove('is-opening');
          sheet.classList.add('is-dragging');
          if (pointerId !== null) {
            try { sheet.setPointerCapture(pointerId); } catch (_) {}
          }
        }
        gesture.distance = Math.max(0, dy);
        gesture.position.m42 = gesture.startOffset + gesture.distance;
        sheet.style.transform = gesture.position.toString();
        overlay.style.setProperty('--sheet-backdrop-progress', String(Math.max(0, 1 - gesture.distance / 260)));
        if (event.cancelable) event.preventDefault();
      };

      const finish = (cancelled = false) => {
        const ended = gesture;
        gesture = null;
        if (!ended?.dragging || sheet.classList.contains('is-dismissing')) return;
        sheet.classList.remove('is-dragging');
        const threshold = Math.max(36, Math.min(96, sheet.clientHeight * .2));
        if (!cancelled && ended.distance >= threshold) {
          this.closeOverlayWithAnimation(overlay.id);
        } else {
          sheet.style.transform = '';
          sheet.style.opacity = '';
          overlay.style.removeProperty('--sheet-backdrop-progress');
        }
      };

      sheet.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch' || !event.isPrimary || event.button !== 0) return;
        start(event.target, event);
        if (gesture) pointerId = event.pointerId;
      });
      sheet.addEventListener('pointermove', event => {
        if (event.pointerId === pointerId) move(event, event);
      });
      const finishPointer = event => {
        if (event.pointerId !== pointerId) return;
        pointerId = null;
        finish(event.type === 'pointercancel');
      };
      sheet.addEventListener('pointerup', finishPointer);
      sheet.addEventListener('pointercancel', finishPointer);
      sheet.addEventListener('pointerleave', event => {
        if (!gesture?.dragging) finishPointer(event);
      });

      sheet.addEventListener('touchstart', event => {
        if (event.touches.length !== 1) {
          touchId = null;
          finish(true);
          return;
        }
        const touch = event.touches[0];
        start(event.target, touch);
        if (gesture) touchId = touch.identifier;
      }, { passive: true });
      sheet.addEventListener('touchmove', event => {
        const touch = event.touches[0];
        if (event.touches.length === 1 && touch.identifier === touchId) move(touch, event);
      }, { passive: false });
      const finishTouch = event => {
        if (!Array.from(event.changedTouches).some(touch => touch.identifier === touchId)) return;
        touchId = null;
        finish(event.type === 'touchcancel');
      };
      sheet.addEventListener('touchend', finishTouch, { passive: true });
      sheet.addEventListener('touchcancel', finishTouch, { passive: true });
      sheet.addEventListener('click', event => {
        if (!suppressClick || !event.detail) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    });

    const full = document.getElementById('full-player');
    if (full) {
      let startY = 0;
      let dismissStartY = 0;
      let pointerId = null;
      let dragging = false;
      let ending = false;
      let touchStartedAtTop = false;
      let touchActive = false;

      const isInteractive = target => !!target.closest('input, button, select, textarea, a');
      const isOpen = () => full.classList.contains('active') && !full.classList.contains('is-dismissing');
      const applyDrag = (y, event) => {
        const distance = Math.max(0, y - dismissStartY);
        if (!dragging) {
          if (distance < 8) return;
          dragging = true;
          full.classList.remove('is-opening');
          full.classList.add('is-dragging');
        }
        full.style.transition = 'none';
        full.style.transform = `translate3d(0, ${distance}px, 0)`;
        full.style.opacity = String(Math.max(.35, 1 - distance / 420));
        event?.preventDefault();
      };
      const finishDrag = distance => {
        if (!dragging) return;
        dragging = false;
        full.classList.remove('is-dragging');
        if (distance > 100 || distance / Math.max(1, full.clientHeight) > .18) {
          ending = true;
          this.closeFullPlayer();
          window.setTimeout(() => {
            ending = false;
            notifyOverlayState();
          }, 300);
        } else {
          full.style.transition = 'transform .28s cubic-bezier(.32,.72,0,1), opacity .24s ease';
          full.style.transform = '';
          full.style.opacity = '1';
          window.setTimeout(() => { full.style.transition = ''; }, 290);
        }
      };

      full.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch' || ending || !isOpen() || isInteractive(event.target)) return;
        startY = event.clientY;
        dismissStartY = startY;
        pointerId = event.pointerId;
        try { full.setPointerCapture(pointerId); } catch (_) {}
      }, { passive: false });
      full.addEventListener('pointermove', event => {
        if (event.pointerId !== pointerId || ending) return;
        if (full.scrollTop > 0 && !event.target.closest('.full-player-header')) return;
        applyDrag(event.clientY, event);
      }, { passive: false });
      const finishPointer = event => {
        if (pointerId === null || event.pointerId !== pointerId) return;
        const distance = Math.max(0, event.clientY - dismissStartY);
        pointerId = null;
        finishDrag(distance);
      };
      full.addEventListener('pointerup', finishPointer);
      full.addEventListener('pointercancel', finishPointer);

      full.addEventListener('touchstart', event => {
        if (ending || !isOpen() || isInteractive(event.target) || event.touches.length !== 1) {
          touchActive = false;
          return;
        }
        touchActive = true;
        startY = event.touches[0].clientY;
        dismissStartY = startY;
        touchStartedAtTop = full.scrollTop <= 0;
      }, { passive: true });
      full.addEventListener('touchmove', event => {
        if (!touchActive || event.touches.length !== 1 || ending) return;
        const y = event.touches[0].clientY;
        if (!touchStartedAtTop || full.scrollTop > 0 || y <= dismissStartY) return;
        applyDrag(y, event);
      }, { passive: false });
      const finishTouch = event => {
        if (!touchActive) return;
        const y = event.changedTouches?.[0]?.clientY ?? dismissStartY;
        const distance = Math.max(0, y - dismissStartY);
        touchActive = false;
        touchStartedAtTop = false;
        finishDrag(distance);
      };
      full.addEventListener('touchend', finishTouch, { passive: true });
      full.addEventListener('touchcancel', finishTouch, { passive: true });
    }
  }

  rememberDetailBackView(targetView) {
    const currentView = this.state.activeView;
    if (currentView && currentView !== targetView) {
      const stack = this.state.detailBackStack || (this.state.detailBackStack = []);
      stack.push(currentView);
      this.state.detailBackView = currentView;
    }
  }

  navigateBackFromDetail() {
    const stack = this.state.detailBackStack || (this.state.detailBackStack = []);
    const previousView = stack.pop()
      || this.state.previousView
      || 'library';
    this.state.detailBackView = stack.length
      ? stack[stack.length - 1]
      : previousView;
    this.switchView(previousView);
  }

  backFromSettings() {
    const returnView = this.state.previousView;
    this.switchView(returnView && returnView !== 'settings' ? returnView : (this.state.activeTab || 'home'));
  }

  handleBackNavigation() {
    const modal = document.getElementById('modal-overlay');
    if (modal?.classList.contains('active')) {
      this.scrollMainContentToTop();
      modal.classList.remove('active');
      this.sendNativeMessage('overlay', { open: false, type: 'modal' });
      return true;
    }

    this.overlayStack = this.overlayStack.filter(id =>
      document.getElementById(id)?.classList.contains('active')
    );

    const lastOverlayId = this.overlayStack[this.overlayStack.length - 1];
    const splitPlayer = lastOverlayId === 'full-player' && window.matchMedia(SPLIT_PLAYER_QUERY).matches
      && !document.getElementById('full-player').classList.contains('player-expanded');
    if (this.state.activeView === 'settings' && (!lastOverlayId || splitPlayer)) {
      this.backFromSettings();
      return true;
    }
    if (lastOverlayId) {
      if (lastOverlayId === 'full-player' && document.getElementById('full-player').classList.contains('player-expanded')) {
        this.setPlayerExpanded(false);
        return true;
      }
      this.scrollMainContentToTop();
      if (lastOverlayId === 'full-player') {
        this.closeFullPlayer();
      } else if (lastOverlayId === 'profile-drawer-overlay') {
        this.closeProfileDrawer();
      } else {
        this.closeOverlayWithAnimation(lastOverlayId);
      }
      return true;
    }

    if (this.state.selectionMode) {
      this.scrollMainContentToTop();
      this.toggleSelectionMode(false);
      return true;
    }

    const detailViews = new Set(['playlist-detail','artist-detail','album-detail','folder-detail']);
    if (detailViews.has(this.state.activeView)) {
      this.navigateBackFromDetail();
      return true;
    }
    return false;
  }

  closeOverlayWithAnimation(id) {
    const overlay = document.getElementById(id);
    const sheet = overlay?.querySelector('.bottom-sheet');
    if (!overlay?.classList.contains('active') || !sheet || sheet.classList.contains('is-dismissing')) return;

    const isCreateMenu = id === 'create-sheet-overlay';
    const { transform, opacity } = getComputedStyle(sheet);
    const position = new DOMMatrix(transform === 'none' ? undefined : transform);
    sheet.style.transition = 'none';
    sheet.style.transform = position.toString();
    sheet.style.opacity = opacity;
    sheet.classList.remove('is-opening', 'is-dragging');
    sheet.classList.add('is-dismissing');
    void sheet.offsetWidth;

    if (isCreateMenu) {
      window.clearTimeout(this._createMenuTimer);
      const createButton = document.getElementById('btn-nav-create');
      createButton?.classList.remove('is-open');
      createButton?.setAttribute('aria-label', '만들기 메뉴 열기');
    }
    sheet.style.transition = '';
    position.m42 += 14;
    sheet.style.transform = isCreateMenu ? position.toString() : 'translate3d(0, 100%, 0)';
    if (isCreateMenu) sheet.style.opacity = '0';
    overlay.style.setProperty('--sheet-backdrop-progress', '0');

    const closeTimer = window.setTimeout(() => {
      overlay.classList.remove('active');
      sheet.classList.remove('is-dismissing');
      overlay.style.removeProperty('--sheet-backdrop-progress');
      sheet.style.transform = '';
      sheet.style.opacity = '';
      this.sendNativeMessage('overlay', { open: false, type: id });
    }, isCreateMenu ? 220 : 290);
    if (isCreateMenu) this._createMenuTimer = closeTimer;
  }

  renderAll() {
    this.renderHome();

    this.renderLibrary(
      document.getElementById(
        'library-search-input'
      ).value
    );

    this.updateSelectionBar();

    setTimeout(
      () => this.safeApplyMarquee(),
      50
    );
  }

  updateHomeNowPlayingIndicators() {
    const context = this.state.playbackContext;
    const contextType = context?.type;
    let contextId = String(context?.id ?? '').trim();
    if (contextType === 'artist') {
      contextId ||= (context.name || this.getCurrentTrack()?.artist || '').trim();
      if (contextId && !contextId.startsWith('artist:')) contextId = `artist:${contextId}`;
    }

    document.querySelectorAll('#home-quick-grid .quick-card').forEach(card => {
      const matchesContext = Boolean(this.state.currentTrackId && contextId)
        && card.dataset.homeContextType === contextType
        && card.dataset.homeContextId === contextId;
      card.classList.toggle('is-context-active', matchesContext);
      card.classList.toggle('is-now-playing', matchesContext && this.state.isPlaying);
      if (matchesContext) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    });
  }

  getCollectionSubtitle(type, item) {
    if (type === 'album') return item.artist || '알 수 없는 아티스트';
    if (type === 'artist') return `아티스트 · ${item.tracks.length}곡`;
    return `플레이리스트 · ${this.getTracksForPlaylist(item).length}곡`;
  }

  renderHome() {
    const quickGrid = document.getElementById('home-quick-grid');
    if (!quickGrid) return;

    const artistCovers = this.getStoredLocalObject('auraArtistCovers');
    const artistMap = new Map();
    this.state.tracks.forEach(track => {
      const name = (track.artist || 'Unknown Artist').trim() || 'Unknown Artist';
      if (!artistMap.has(name)) artistMap.set(name, []);
      artistMap.get(name).push(track);
    });

    const artistItems = [...artistMap.entries()].map(([name, tracks]) => ({
      name,
      tracks,
      lastPlayedAt: tracks.reduce((latest, track) => Math.max(latest, track.lastPlayedAt || 0), 0),
      playCount: tracks.reduce((sum, track) => sum + (track.playCount || 0), 0)
    }));

    const albumItems = this.getAlbumGroups().map(album => ({
      ...album,
      lastPlayedAt: album.tracks.reduce((latest, track) => Math.max(latest, track.lastPlayedAt || 0), 0),
      playCount: album.tracks.reduce((sum, track) => sum + (track.playCount || 0), 0)
    }));

    const recentPlaylists = [...this.state.playlists]
      .filter(playlist => playlist.lastPlayedAt)
      .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));

    const recentEntities = [
      ...albumItems.filter(album => album.lastPlayedAt).map(item => ({ type: 'album', item, lastPlayedAt: item.lastPlayedAt, key: `album:${item.id}` })),
      ...artistItems.filter(artist => artist.lastPlayedAt).map(item => ({ type: 'artist', item, lastPlayedAt: item.lastPlayedAt, key: `artist:${item.name}` })),
      ...recentPlaylists.map(item => ({ type: 'playlist', item, lastPlayedAt: item.lastPlayedAt || 0, key: `playlist:${item.id}` }))
    ].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);

    const quickItems = [];
    const pushQuick = entry => {
      if (!quickItems.some(existing => existing.key === entry.key)) quickItems.push(entry);
    };
    recentEntities.forEach(entry => pushQuick({
      key: entry.key,
      type: entry.type,
      item: entry.item,
      score: entry.lastPlayedAt
    }));
    quickItems.sort((a, b) => b.score - a.score);
    quickGrid.innerHTML = '';

    const createEntityCard = (entry, compact = false) => {
      const card = document.createElement('div');
      card.className = compact ? `quick-card clickable${entry.type === 'artist' ? ' artist-home-quick-card' : ''}` : 'media-card home-recent-card clickable';
      const item = entry.item;
      if (compact && ['album', 'playlist', 'artist'].includes(entry.type)) {
        card.dataset.homeContextType = entry.type;
        card.dataset.homeContextId = entry.type === 'artist'
          ? `artist:${item.name}`
          : String(item.id ?? '').trim();
      }
      let title = '';
      let art = '';
      let fallback = 'album';
      let cover = '';

      if (entry.type === 'artist') {
        title = item.name;
        cover = artistCovers[item.name] || '';
        fallback = 'person';
      } else if (entry.type === 'album') {
        title = item.name;
        cover = item.coverData || '';
        fallback = 'album';
      } else {
        title = item.name || '';
        cover = item.coverData || '';
        fallback = 'queue_music';
      }

      art = cover
        ? `<img src="${cover}" alt="">`
        : `<span class="material-symbols-rounded">${fallback}</span>`;

      if (compact) {
        const nowPlayingIndicator = ['album', 'playlist', 'artist'].includes(entry.type)
          ? '<span class="home-now-playing-indicator" aria-hidden="true"><i></i><i></i><i></i></span>'
          : '';
        card.innerHTML = `
          <div class="quick-card-art${entry.type === 'artist' ? ' artist-home-quick-art artist-artwork' : ''}">${art}</div>
          <div class="quick-title-viewport track-title-viewport"><span class="title marquee-content">${escapeHtml(title)}</span></div>
          ${nowPlayingIndicator}
        `;
      } else {
        const secondary = this.getCollectionSubtitle(entry.type, item);
        card.innerHTML = `
          <div class="media-card-art${entry.type === 'artist' ? ' artist-home-quick-art artist-artwork' : ''}">${art}</div>
          <div class="track-title-viewport home-media-title"><div class="title marquee-content">${escapeHtml(title)}</div></div>
          <div class="track-artist-viewport home-media-title"><div class="subtitle marquee-content">${escapeHtml(secondary)}</div></div>
        `;
      }

      card.onclick = () => {
        if (entry.type === 'artist') this.openArtistDetail(item.name);
        else if (entry.type === 'album') this.openAlbumDetail(item.id);
        else this.openPlaylistDetail(item);
      };
      return card;
    };

    quickItems.slice(0, 6).forEach(entry => quickGrid.appendChild(createEntityCard(entry, true)));
    this.updateHomeNowPlayingIndicators();

    const recent = document.getElementById('home-recently-played');
    if (recent) {
      recent.innerHTML = '';
      recentEntities.slice(0, 10).forEach(entry => recent.appendChild(createEntityCard(entry, false)));
      if (!recent.children.length) recent.innerHTML = '<p class="track-artist">최근 재생한 앨범, 아티스트 또는 플레이리스트가 없습니다.</p>';
    }

    const topContainer = document.getElementById('home-top-played');
    if (topContainer) {
      const topAlbums = [...albumItems]
        .filter(album => album.playCount > 0)
        .sort((a, b) => b.playCount - a.playCount || (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || a.name.localeCompare(b.name, 'ko'))
        .slice(0, 10);
      topContainer.innerHTML = '';
      topAlbums.forEach(album => {
        const card = document.createElement('div');
        card.className = 'media-card clickable';
        card.innerHTML = `
          <div class="media-card-art">
            ${album.coverData ? `<img src="${album.coverData}" alt="">` : '<span class="material-symbols-rounded">album</span>'}
          </div>
          <div class="track-title-viewport home-media-title"><div class="title marquee-content">${escapeHtml(album.name)}</div></div>
          <div class="track-artist-viewport home-media-title"><div class="subtitle marquee-content">${escapeHtml(this.getCollectionSubtitle('album', album))}</div></div>
        `;
        card.onclick = () => this.openAlbumDetail(album.id);
        topContainer.appendChild(card);
      });
      if (!topAlbums.length) topContainer.innerHTML = '<p class="track-artist">아직 재생한 앨범이 없습니다.</p>';
    }
  }

  renderLibrary(query = '') {
    const container =
      document.getElementById(
        'library-list'
      );

    document
      .getElementById(
        'current-sort-label'
      )
      .textContent =
      this.sortOptions[
        this.state.activeSort
      ] ||
      '최근 추가순';

    container.innerHTML = '';

    if (
      this.state.activeViewMode ===
      'grid'
    ) {
      container.classList.add(
        'grid-view'
      );
    } else {
      container.classList.remove(
        'grid-view'
      );
    }

    const q =
      query
        .toLowerCase()
        .trim();

    const filter =
      this.state.activeFilter;

    let matchedPlaylistsCount = 0;
    let filteredTracksCount = 0;

    if (
      filter === 'playlists' ||
      filter === 'all'
    ) {
      let matchedPlaylists =
        this.state.playlists.filter(
          playlist =>
            !q ||
            (playlist.name || '')
              .toLowerCase()
              .includes(q)
        );

      matchedPlaylistsCount = matchedPlaylists.length;

      const librarySort = this.state.librarySortMode || this.state.activeSort;
      const playlistRecency = librarySort === 'recent_desc'
        ? new Map(matchedPlaylists.map(playlist => {
            const latestTrackTime = this.getTracksForPlaylist(playlist)
              .reduce((latest, track) => Math.max(latest, track.lastPlayedAt || 0), 0);
            return [playlist.id, Math.max(playlist.lastPlayedAt || 0, latestTrackTime)];
          }))
        : null;
      matchedPlaylists.sort((a, b) => {
        if (librarySort === 'title_asc') {
          return (a.name || '').localeCompare((b.name || ''), 'ko', { sensitivity: 'base' });
        }
        if (librarySort === 'recent_desc') {
          const recentA = playlistRecency.get(a.id) || 0;
          const recentB = playlistRecency.get(b.id) || 0;
          return recentB - recentA || (b.createdAt || 0) - (a.createdAt || 0);
        }
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

      matchedPlaylists.forEach(playlist => {
        const row = this.createCollectionRow({
          title: playlist.name,
          contextType: 'playlist',
          contextId: playlist.id,
          coverData: playlist.coverData || '',
          fallbackIcon: 'queue_music',
          secondaryText: this.getCollectionSubtitle('playlist', playlist),
          onOpen: () => this.openPlaylistDetail(playlist),
          onLongPress: () => {
            this.state.activePlaylistId = playlist.id;
            this.openPlaylistMenu();
          }
        });
        container.appendChild(row);
      });
    }

    if (filter === 'albums') {
      const groups = this.getAlbumGroups();
      let items = groups.filter(album => !q || album.name.toLowerCase().includes(q) || album.artist.toLowerCase().includes(q));
      const librarySort = this.state.librarySortMode || this.state.activeSort;
      items.sort((a, b) => {
        if (librarySort === 'title_asc') return a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' }) || a.artist.localeCompare(b.artist, 'ko', { sensitivity: 'base' });
        if (librarySort === 'recent_desc') return b.lastPlayedAt - a.lastPlayedAt || a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' });
        return b.addedAt - a.addedAt || a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' });
      });
      if (!items.length) {
        container.innerHTML = `<div class="empty-state"><span class="material-symbols-rounded icon">${q ? 'search_off' : 'album'}</span><p>${q ? '검색 결과가 없습니다.' : '앨범 정보가 있는 음악이 없습니다.'}</p></div>`;
      } else {
        items.forEach(album => {
          const row = this.createCollectionRow({
            title: album.name,
            contextType: 'album',
            contextId: album.id,
            coverData: album.coverData,
            fallbackIcon: 'album',
            artworkClass: 'album-list-art',
            secondaryText: this.getCollectionSubtitle('album', album),
            onOpen: () => this.openAlbumDetail(album.id),
            onLongPress: () => this.openAlbumMenu(album.id)
          });
          container.appendChild(row);
        });
      }
    }

    if (
      filter === 'tracks' ||
      filter === 'all'
    ) {
      const artworkLookup = this.buildArtworkLookup();
      let filtered =
        q
          ? this.state.tracks.filter(
              track =>
                (track.title || '')
                  .toLowerCase()
                  .includes(q)
            )
          : [...this.state.tracks];

      const librarySort = this.state.librarySortMode || this.state.activeSort;
      filtered.sort((a, b) => {
        if (librarySort === 'title_asc') return a.title.localeCompare(b.title, 'ko', { sensitivity: 'base' });
        if (librarySort === 'recent_desc') return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0);
        return (b.addedAt || 0) - (a.addedAt || 0);
      });

      filteredTracksCount = filtered.length;

      filtered.forEach(
        track =>
          container.appendChild(
            this.createTrackRow(
              track,
              filtered,
              this.state.activeViewMode === 'grid',
              { type: 'library', name: track.title },
              artworkLookup
            )
          )
      );
    }

    if (filter === 'tracks' || filter === 'playlists' || filter === 'all') {
      const shouldShowEmpty =
        filter === 'tracks'
          ? filteredTracksCount === 0
          : filter === 'playlists'
            ? matchedPlaylistsCount === 0
            : filteredTracksCount === 0 && matchedPlaylistsCount === 0;

      if (shouldShowEmpty) {
        const message = q
          ? '검색 결과가 없습니다.'
          : filter === 'playlists'
            ? '플레이리스트가 없습니다.'
            : '보관함에 노래가 없습니다.';
        container.innerHTML = `
          <div class="empty-state library-empty-state">
            <span class="material-symbols-rounded icon">${q ? 'search_off' : 'library_music'}</span>
            <p>${message}</p>
          </div>
        `;
      }
    }

    if (filter === 'artists') {
      const groups = new Map();
      const hiddenTracks = this.getStoredLocalObject('auraArtistHiddenTracks');
      const artistCovers = this.getStoredLocalObject('auraArtistCovers');

      this.state.tracks.forEach(track => {
        const key = (track.artist || 'Unknown Artist').trim() || 'Unknown Artist';
        if (!groups.has(key)) groups.set(key, []);
        if (!(hiddenTracks[key] || []).includes(track.id)) groups.get(key).push(track);
      });

      let items = [...groups.entries()].map(([name, tracks]) => ({ name, tracks }));

      if (q) {
        items = items.filter(group =>
          group.name.toLowerCase().includes(q)
        );
      }

      const librarySort = this.state.librarySortMode || this.state.activeSort;
      const latestTrackTime = tracks => tracks.reduce(
        (latest, track) => Math.max(latest, track.lastPlayedAt || 0),
        0
      );
      const latestAddedTime = tracks => tracks.reduce(
        (latest, track) => Math.max(latest, track.addedAt || 0),
        0
      );
      const artistSortValues = new Map(items.map(group => [group.name, {
        recent: latestTrackTime(group.tracks),
        added: latestAddedTime(group.tracks)
      }]));
      items.sort((a, b) => {
        if (librarySort === 'title_asc') return a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' });
        const statsA = artistSortValues.get(a.name);
        const statsB = artistSortValues.get(b.name);
        const recentA = statsA.recent;
        const recentB = statsB.recent;
        if (librarySort === 'recent_desc') return recentB - recentA;
        const addedA = statsA.added;
        const addedB = statsB.added;
        return addedB - addedA || a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' });
      });

      if (!items.length) {
        const message = q ? '검색 결과가 없습니다.' : '아티스트가 없습니다.';
        container.innerHTML = `
          <div class="empty-state">
            <span class="material-symbols-rounded icon">${q ? 'search_off' : 'person_off'}</span>
            <p>${message}</p>
          </div>
        `;
      } else {
        items.forEach(group => {
          const artistCover = artistCovers[group.name] || '';
          const row = this.createCollectionRow({
            title: group.name,
            contextType: 'artist',
            contextId: `artist:${group.name}`,
            coverData: artistCover,
            fallbackIcon: 'person',
            artworkClass: 'artist-list-art artist-artwork',
            secondaryText: this.getCollectionSubtitle('artist', group),
            onOpen: () => this.openArtistDetail(group.name),
            onLongPress: () => this.openArtistMenu(group.name, group.tracks),
            actionsHtml: ''
          });
          container.appendChild(row);
        });
      }
    }
  }

  getAlbumGroups() {
    const groups = new Map();
    const albumCovers = this.getStoredAlbumCovers();
    const savedOrders = this.getStoredAlbumTrackOrders();

    this.state.tracks.forEach(track => {
      const name = (track.album || '').trim();
      if (!name || name.toLowerCase() === 'local file') return;
      const artist = (track.artist || 'Unknown Artist').trim() || 'Unknown Artist';
      const id = JSON.stringify([name.toLocaleLowerCase(), artist.toLocaleLowerCase()]);
      if (!groups.has(id)) groups.set(id, { id, name, artist, tracks: [], coverData: '', lastPlayedAt: 0, addedAt: 0 });
      const group = groups.get(id);
      group.tracks.push(track);
      if (!group.coverData && track.artworkData) group.coverData = track.artworkData;
      group.lastPlayedAt = Math.max(group.lastPlayedAt, track.lastPlayedAt || 0);
      group.addedAt = Math.max(group.addedAt, track.addedAt || 0);
    });

    for (const group of groups.values()) {
      if (albumCovers[group.id]) group.coverData = albumCovers[group.id];
      const savedOrder = savedOrders[group.id];
      if (Array.isArray(savedOrder) && savedOrder.length) {
        const rank = new Map(savedOrder.map((trackId, index) => [trackId, index]));
        group.tracks.sort((a, b) => {
          const ai = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
          const bi = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
          return ai - bi;
        });
      } else {
        group.tracks = group.tracks.map((track, index) => ({ track, index })).sort((a, b) => {
          const ad = Number.parseInt(a.track.discNumber, 10);
          const bd = Number.parseInt(b.track.discNumber, 10);
          const at = Number.parseInt(a.track.trackNumber, 10);
          const bt = Number.parseInt(b.track.trackNumber, 10);
          const hasNumbers = Number.isFinite(ad) || Number.isFinite(bd) || Number.isFinite(at) || Number.isFinite(bt);
          if (!hasNumbers) return a.index - b.index;
          return (Number.isFinite(ad) ? ad : 1) - (Number.isFinite(bd) ? bd : 1)
            || (Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER) - (Number.isFinite(bt) ? bt : Number.MAX_SAFE_INTEGER)
            || a.index - b.index;
        }).map(item => item.track);
      }
    }
    return [...groups.values()];
  }

  getStoredAlbumCovers() {
    return this.getStoredLocalObject('auraAlbumCovers');
  }

  getStoredAlbumTrackOrders() {
    return this.getStoredLocalObject('auraAlbumTrackOrder');
  }

  getStoredLocalObject(key) {
    const raw = localStorage.getItem(key) || '';
    const cached = this.localStorageObjectCache.get(key);
    if (cached?.raw === raw) return cached.value;

    let value = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
      } catch (_) {}
    }

    this.localStorageObjectCache.set(key, { raw, value });
    return value;
  }

  getAlbumForTrack(track) {
    if (!track) return null;
    const albumName = (track.album || '').trim();
    if (!albumName || albumName.toLowerCase() === 'local file') return null;
    const artist = (track.artist || 'Unknown Artist').trim() || 'Unknown Artist';
    const id = JSON.stringify([albumName.toLocaleLowerCase(), artist.toLocaleLowerCase()]);
    return this.getAlbumGroups().find(album => album.id === id) || null;
  }

  openAlbumMenu(albumId) {
    const album = this.getAlbumGroups().find(item => item.id === albumId);
    if (!album) return;
    this.state.albumMenuId = albumId;
    document.getElementById('album-sheet-title').textContent = album.name;
    document.getElementById('album-sheet-artist').textContent = album.artist;
    this.setCoverElement(document.getElementById('album-sheet-art'), album.coverData || '', 'album');
    const list = document.getElementById('album-sheet-menu-items');
    list.innerHTML = `
      <div class="sheet-menu-item clickable" id="btn-album-edit-order"><span class="material-symbols-rounded">format_list_numbered</span><span>순서 편집하기</span></div>
      <div class="sheet-menu-item clickable" id="btn-album-cover-edit"><span class="material-symbols-rounded">image</span><span>커버 변경하기</span></div>
      <div class="sheet-menu-item clickable" id="btn-album-go-artist"><span class="material-symbols-rounded">person</span><span>아티스트로 이동하기</span></div>
      <div class="sheet-menu-item clickable" id="btn-album-add-queue"><span class="material-symbols-rounded">queue</span><span>다음 재생목록에 추가하기</span></div>
      <div class="sheet-menu-item clickable" id="btn-album-add-playlist"><span class="material-symbols-rounded">playlist_add</span><span>플레이리스트에 추가하기</span></div>`;
    const overlay = document.getElementById('album-sheet-overlay');
    list.querySelector('#btn-album-edit-order').onclick = () => {
      this.closeSheet('album-sheet-overlay');
      this.openAlbumTrackEditor(album.id);
    };
    list.querySelector('#btn-album-cover-edit').onclick = () => {
      this.closeSheet('album-sheet-overlay');
      this.openAlbumCoverEditor(album.id);
    };
    list.querySelector('#btn-album-go-artist').onclick = () => {
      this.closeSheet('album-sheet-overlay');
      this.openArtistDetail(album.artist);
    };
    list.querySelector('#btn-album-add-queue').onclick = async () => {
      this.state.queue.push(...album.tracks);
      await this.storage.saveStateKey('queue', this.state.queue);
      this.syncNativeQueue();
      this.refreshQueueIfOpen();
      this.closeSheet('album-sheet-overlay');
    };
    list.querySelector('#btn-album-add-playlist').onclick = () => {
      this.closeSheet('album-sheet-overlay');
      this.openAddAlbumToPlaylistModal(album);
    };
    overlay.classList.add('active');
    this.sendNativeMessage('overlay', { open: true, type: 'album-sheet' });
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  openAlbumTrackEditor(albumId) {
    const album = this.getAlbumGroups().find(item => item.id === albumId);
    if (!album) return;
    const tracksHtml = album.tracks.map(track => `
      <div class="drag-item album-drag-item" data-id="${track.id}">
        <button type="button" class="btn-icon drag-handle clickable" aria-label="순서 변경"><span class="material-symbols-rounded">drag_handle</span></button>
        <div class="track-main"><div class="track-title-viewport"><div class="track-title marquee-content">${escapeHtml(track.title)}</div></div><div class="track-artist-viewport"><div class="track-artist marquee-content">${escapeHtml(track.artist)}</div></div></div>
      </div>`).join('');
    this.showModal('앨범 수록곡 순서 편집', `<p class="editor-help-text">왼쪽의 = 버튼을 누른 상태로 위아래로 움직여 순서를 변경하세요.</p><div class="modal-body-scroll playlist-edit-scroll"><div id="album-drag-list">${tracksHtml || '<p>음악이 없습니다.</p>'}</div></div>`, async () => {
      const list = document.getElementById('album-drag-list');
      if (list) {
        const orders = this.getStoredAlbumTrackOrders();
        orders[albumId] = [...list.querySelectorAll('.album-drag-item')].map(el => el.dataset.id);
        localStorage.setItem('auraAlbumTrackOrder', JSON.stringify(orders));
        this.renderAlbumTracks(albumId);
        this.renderLibrary(document.getElementById('library-search-input')?.value || '');
      }
      document.getElementById('modal-overlay').classList.remove('active');
    });
    const list = document.getElementById('album-drag-list');
    if (list) this.setupHandleReorder(list, '.album-drag-item');
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  openAlbumCoverEditor(albumId) {
    const album = this.getAlbumGroups().find(item => item.id === albumId);
    if (!album) return;
    this.openCoverEditor({
      title: '앨범 커버 변경', inputId: 'album-cover-file', previewId: 'album-cover-preview', icon: 'album',
      currentData: album.coverData || '', sourceKey: `album:${albumId}`,
      extraHTML: '<p class="editor-help-text">앨범 커버는 이 앨범의 커버를 따르는 곡에도 적용됩니다.</p>',
      onSave: async ({ cropData }) => {
        if (!cropData) { alert('이미지를 선택하거나 기존 사진을 조절해주세요.'); throw new Error('커버 이미지가 없습니다.'); }
        const covers = this.getStoredAlbumCovers();
        covers[albumId] = cropData;
        localStorage.setItem('auraAlbumCovers', JSON.stringify(covers));
      },
      afterSave: async () => {
        this.renderAlbumTracks(albumId);
        this.renderLibrary(document.getElementById('library-search-input')?.value || '');
        const refreshed = this.getAlbumGroups().find(item => item.id === albumId);
        if (refreshed) {
          const artwork = document.getElementById('album-detail-cover');
          this.setCoverElement(artwork, refreshed.coverData || '', 'album');
          if (this._collectionDetail?.artwork === artwork) {
            this.updateCollectionDetailArtworkColor(this._collectionDetail);
          }
        }
      }
    });
  }

  openAddAlbumToPlaylistModal(album) {
    const html = this.state.playlists.map(playlist => `
      <button class="btn-secondary clickable" style="width:100%;margin-bottom:8px;text-align:left" data-id="${playlist.id}">${escapeHtml(playlist.name)}</button>`).join('');
    this.showModal('플레이리스트 선택', `<div class="modal-body-scroll playlist-order-scroll">${html || '<p style="color:var(--text-secondary);text-align:center;">플레이리스트가 없습니다.</p>'}</div>`, null);
    document.querySelectorAll('#modal-body .btn-secondary').forEach(button => {
      button.onclick = async () => {
        const playlist = this.getPlaylist(button.dataset.id);
        if (playlist) {
          const existing = new Set(playlist.trackIds);
          const newIds = album.tracks.map(track => track.id).filter(id => !existing.has(id));
          playlist.trackIds.push(...newIds);
          await this.storage.savePlaylist(playlist);
        }
        document.getElementById('modal-overlay').classList.remove('active');
      };
    });
  }

  openAlbumDetail(albumId) {
    const album = this.getAlbumGroups().find(item => item.id === albumId);
    if (!album) return;
    this.rememberDetailBackView('album-detail');
    this.state.albumDetailId = albumId;
    const albumMoreButton = document.getElementById('btn-album-more');
    if (albumMoreButton) albumMoreButton.onclick = () => this.openAlbumMenu(albumId);
    document.getElementById('album-detail-title').textContent = album.name;
    document.getElementById('album-detail-artist').textContent = album.artist || '알 수 없는 아티스트';
    this.setCoverElement(document.getElementById('album-detail-cover'), album.coverData || '', 'album');
    this.renderAlbumTracks(albumId);
    document.getElementById('btn-play-album').onclick = () => {
      const tracks = this.getVisibleAlbumTracks(albumId);
      const isCurrentAlbum = this.state.currentTrackId
        && this.state.playbackContext?.type === 'album'
        && String(this.state.playbackContext.id) === String(album.id);
      if (isCurrentAlbum) {
        this.player.togglePlay();
        return;
      }
      if (tracks.length) this.playTrack(tracks[0], tracks, 0, { type: 'album', id: album.id, name: album.name });
    };
    document.getElementById('btn-shuffle-album').onclick = () => {
      const tracks = this.getVisibleAlbumTracks(albumId);
      if (tracks.length) {
        const shuffled = [...tracks].sort(() => Math.random() - 0.5);
        this.playTrack(shuffled[0], shuffled, 0, { type: 'album', id: album.id, name: album.name });
      }
    };
    this.updatePlaylistPlayButton();
    this.switchView('album-detail');
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  getVisibleAlbumTracks(albumId) {
    const album = this.getAlbumGroups().find(item => item.id === albumId);
    if (!album) return [];
    return [...album.tracks];
  }

  renderAlbumTracks(albumId) {
    const album = this.getAlbumGroups().find(item => item.id === albumId);
    const container = document.getElementById('album-tracks-container');
    if (!container) return;
    const tracks = this.getVisibleAlbumTracks(albumId);
    const title = document.getElementById('album-detail-sub');
    if (title) title.textContent = `${tracks.length}곡 • ${formatTotalTime(tracks)}`;
    container.innerHTML = tracks.length ? '' : '<div class="empty-state"><p>검색 결과가 없습니다.</p></div>';
    tracks.forEach(track => container.appendChild(this.createTrackRow(track, tracks, false, { type: 'album', id: albumId, name: album?.name || track.album || '' })));
    if (album) {
      this.setCoverElement(document.getElementById('album-artist-avatar'), this.getStoredLocalObject('auraArtistCovers')[album.artist], 'person');
      document.getElementById('album-detail-title').textContent = album.name;
      document.getElementById('album-detail-artist').textContent = album.artist || '알 수 없는 아티스트';
    }
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  openFolderDetail(folderName) {
    this.rememberDetailBackView('folder-detail');
    this.state.folderDetailId =
      folderName;

    const tracks =
      this.state.tracks.filter(
        track =>
          getTrackFolderName(
            track
          ) === folderName
      );

    document
      .getElementById(
        'folder-detail-title'
      )
      .textContent =
      folderName;

    document
      .getElementById(
        'folder-detail-sub'
      )
      .textContent =
      `${tracks.length}곡 • ${formatTotalTime(tracks)}`;

    const container =
      document.getElementById(
        'folder-tracks-container'
      );

    const artworkLookup = this.buildArtworkLookup();

    container.innerHTML =
      tracks.length
        ? ''
        : `
          <div class="empty-state">
            <p>음악이 없습니다.</p>
          </div>
        `;

    tracks.forEach(
      track =>
        container.appendChild(
          this.createTrackRow(
            track,
            tracks,
            false,
            { type: 'folder', name: folderName, id: 'folder_' + folderName },
            artworkLookup
          )
        )
    );

    document
      .getElementById(
        'btn-play-folder'
      )
      .onclick =
      () => {
        if (tracks.length) {
          this.playTrack(
            tracks[0],
            tracks,
            0,
            {
              type: 'folder',
              name: folderName,
              id: 'folder_' + folderName
            }
          );
        }
      };

    this.switchView(
      'folder-detail'
    );
  }

  createCollectionRow({
    title,
    contextType,
    contextId,
    coverData = '',
    fallbackIcon = 'music_note',
    artworkClass = '',
    secondaryText = '',
    actionsHtml = '',
    onOpen = null,
    onLongPress = null,
    onSetup = null
  }) {
    const row = document.createElement('div');
    row.className = 'track-row clickable collection-row';
    if (contextType) {
      row.dataset.contextType = contextType;
      row.dataset.contextId = contextId;
      row.classList.toggle('playing', this.isCurrentCollection(contextType, contextId));
    }

    const artworkClasses = ['track-artwork'];
    if (artworkClass) artworkClasses.push(artworkClass);

    row.innerHTML = `
      <div class="${artworkClasses.join(' ')}">
        ${coverData
          ? `<img src="${coverData}" alt="">`
          : `<span class="material-symbols-rounded">${fallbackIcon}</span>`}
      </div>
      <div class="track-main">
        <div class="track-title-viewport">
          <div class="track-title marquee-content">${escapeHtml(title)}</div>
        </div>
        <div class="track-artist-viewport">
          <div class="track-artist marquee-content">${escapeHtml(secondaryText)}</div>
        </div>
      </div>
      <div class="track-actions">
        ${actionsHtml}
      </div>
    `;

    row.onclick = event => {
      if (event.target.closest('.track-actions')) return;
      if (typeof onOpen === 'function') onOpen();
    };

    if (this.state.activeView === 'library' && typeof onLongPress === 'function') {
      this.bindLongPress(row, onLongPress);
    }
    if (typeof onSetup === 'function') onSetup(row);
    return row;
  }

  bindLongPress(element, onLongPress) {
    if (!element || typeof onLongPress !== 'function') return;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let pressTimer = 0;
    let suppressNextClick = false;

    const clearPress = () => {
      window.clearTimeout(pressTimer);
      pressTimer = 0;
    };

    element.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      clearPress();
      suppressNextClick = false;
      pointerId = null;
      if (event.target.closest('button, input, textarea, select, a, label')) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        suppressNextClick = true;
        element.classList.add('long-pressed');
        onLongPress();
        window.setTimeout(() => element.classList.remove('long-pressed'), 240);
      }, 520);
    });

    element.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId) return;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) clearPress();
    });

    const finishPress = event => {
      if (event.pointerId !== pointerId) return;
      clearPress();
      pointerId = null;
    };
    element.addEventListener('pointerup', finishPress);
    element.addEventListener('pointercancel', finishPress);
    element.addEventListener('pointerleave', finishPress);
    element.addEventListener('contextmenu', event => {
      if (pressTimer || suppressNextClick) event.preventDefault();
    });
    element.addEventListener('touchend', event => {
      if (suppressNextClick && event.cancelable) event.preventDefault();
    }, { passive: false });
    element.addEventListener('click', event => {
      if (!suppressNextClick || event.detail === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressNextClick = false;
    }, true);
  }

  createTrackRow(
    track,
    contextList = [],
    isGrid = false,
    playbackContext = null,
    artworkLookup = null
  ) {
    const row =
      document.createElement(
        'div'
      );

    row.className =
      `track-row clickable ${
        track.id ===
        this.state.currentTrackId
          ? 'playing'
          : ''
      }`;

    row.dataset.id =
      track.id;

    const allowSelection =
      this.state.selectionMode &&
      this.state.activeView === 'library' &&
      playbackContext?.type === 'library';

    const selectHtml =
      allowSelection
        ? `
          <label
            class="select-box-wrap"
            onclick="event.stopPropagation()">

            <input
              type="checkbox"
              class="track-select-checkbox"
              data-id="${track.id}"
              ${
                this.state.selectedTrackIds.has(
                  track.id
                )
                  ? 'checked'
                  : ''
              }>

          </label>
        `
        : '';

    let artworkHtml = '';
    if (playbackContext?.type !== 'album') {
      const artwork = this.getTrackArtworkData(track, artworkLookup);
      artworkHtml = `<div class="track-artwork">
        ${artwork ? `<img src="${artwork}" alt="">` : '<span class="material-symbols-rounded">music_note</span>'}
      </div>`;
    }

    row.innerHTML = `
      ${selectHtml}

      ${artworkHtml}

      <div class="track-main">

        <div
          class="track-title-viewport">

          <div
            class="track-title marquee-content">

            ${escapeHtml(
              track.title
            )}

          </div>

        </div>

        <div
          class="track-artist-viewport">

          <div
            class="track-artist marquee-content">

            ${escapeHtml(
              track.artist
            )}

          </div>

        </div>

      </div>

      <div class="track-actions">

        <button
          class="more-button clickable"
          aria-label="더보기"
          data-id="${track.id}">

          <span
            class="material-symbols-rounded">

            more_vert

          </span>

        </button>

      </div>
    `;

    const playRowTrack = event => {
      event.stopPropagation();
      const context = playbackContext || { type: 'library', name: track.title };
      const list = context.type === 'library' || !contextList.length ? [track] : contextList;
      const index = Math.max(0, list.findIndex(t => t.id === track.id));
      this.playTrack(track, list, index, context);
    };
    row.querySelectorAll('.track-main, .track-artwork').forEach(element => {
      element.onclick = playRowTrack;
    });

    const openTrackMenu = () => this.openTrackContextMenu(track, playbackContext?.type || null);
    row.querySelector('.more-button').onclick = event => {
      event.stopPropagation();
      openTrackMenu();
    };

    const checkbox =
      row.querySelector(
        '.track-select-checkbox'
      );

    if (checkbox) {
      checkbox.onchange =
        () =>
          this.toggleTrackSelection(
            track.id,
            checkbox.checked
          );
    }

    this.bindLongPress(row, openTrackMenu);

    return row;
  }

  bindDetailSearch(inputId, clearButtonId, onSearch) {
    const input = document.getElementById(inputId);
    const clearButton = document.getElementById(clearButtonId);
    if (!input) return;

    input.addEventListener('input', () => {
      if (clearButton) clearButton.classList.toggle('hidden', !input.value);
      onSearch(input.value);
    });

    clearButton?.addEventListener('click', () => {
      input.value = '';
      clearButton.classList.add('hidden');
      onSearch('');
      input.focus();
    });
  }

  renderSortOptions(container, options, currentSort, onSelect) {
    if (!container) return;
    container.innerHTML = '';
    Object.entries(options).forEach(([value, label]) => {
      const button = document.createElement('button');
      button.className = `sort-item clickable ${currentSort === value ? 'active' : ''}`;
      button.innerHTML = `<span>${label}</span><span class="material-symbols-rounded check-icon">check</span>`;
      button.addEventListener('click', () => onSelect(value));
      container.appendChild(button);
    });
  }

  openSortSheet(type) {
    const isLib =
      type === 'library';

    const container =
      document.getElementById(
        isLib
          ? 'sort-menu-items'
          : 'pl-sort-menu-items'
      );

    const options = isLib ? this.sortOptions : this.playlistSortOptions;
    const currentSort = isLib ? this.state.activeSort : this.state.playlistSortMode;

    this.renderSortOptions(container, options, currentSort, async value => {
      if (isLib) {
        this.state.activeSort = value;
        this.state.librarySortMode = value;
        await this.storage.saveStateKey('activeSort', value);
        document.getElementById('sort-sheet-overlay').classList.remove('active');
        this.renderLibrary(document.getElementById('library-search-input').value);
      } else {
        this.state.playlistSortMode = value;
        document.getElementById('pl-sort-sheet-overlay').classList.remove('active');
        this.renderPlaylistTracks(
          this.getPlaylist(this.state.activePlaylistId),
          document.getElementById('playlist-search-input').value
        );
      }
    });

    document
      .getElementById(
        isLib
          ? 'sort-sheet-overlay'
          : 'pl-sort-sheet-overlay'
      )
      .classList.add('active');
  }

  openTrackContextMenu(track, sourceContext = null) {
    const currentTrack = this.getTrackById(track?.id) || track;

    track = currentTrack;


    document
      .getElementById(
        'sheet-title'
      )
      .textContent =
      track.title;

    document
      .getElementById(
        'sheet-artist'
      )
      .textContent =
      track.artist;

    const container =
      document.getElementById(
        'sheet-menu-items'
      );

    container.innerHTML = '';

    this.setCoverElement(
      document.getElementById('sheet-art'),
      this.getTrackArtworkData(track),
      'music_note'
    );

    const menuItems = [
      {
        icon: 'edit',
        label: '정보 편집하기',
        action: () => this.openTrackEditor(track)
      },
      {
        icon: 'image',
        label: '커버 변경하기',
        action: () => {
          this.closeSheet('bottom-sheet-overlay');
          this.openTrackCoverEditor(track);
        }
      },
      {
        icon: 'playlist_add',
        label: '플레이리스트에 추가하기',
        action: () => this.openAddToPlaylistModal(track)
      },
      {
        icon: 'queue',
        label: '다음 재생목록에 추가하기',
        action: async () => {
          this.state.queue.push(track);
          await this.storage.saveStateKey('queue', this.state.queue);
          this.syncNativeQueue();
        }
      },
      {
        icon: 'description',
        label: '음악 파일 정보 보기',
        action: () => this.openFileInfo(track)
      },
      {
        icon: 'delete',
        label: '기기에서 삭제하기',
        action: () => this.deleteTrack(track.id),
        color: 'var(--danger-color)'
      }
    ];

    if (sourceContext !== 'album') {
      menuItems.splice(5, 0, {
        icon: 'album',
        label: '앨범으로 가기',
        action: () => {
          const album = this.getAlbumForTrack(track);
          if (album) this.openAlbumDetail(album.id);
          else alert('이 곡에 연결된 앨범 정보가 없습니다.');
        }
      });
    }
    if (sourceContext !== 'artist') {
      const fileInfoIndex = menuItems.findIndex(item => item.label === '음악 파일 정보 보기');
      menuItems.splice(fileInfoIndex, 0, {
        icon: 'person',
        label: '아티스트로 이동하기',
        action: () => this.openArtistDetail(track.artist)
      });
    }

    menuItems.forEach(item => {
      const element =
        document.createElement(
          'div'
        );

      element.className =
        'sheet-menu-item clickable';

      element.innerHTML = `
        <span
          class="material-symbols-rounded"
          style="color:${
            item.color ||
            'inherit'
          }">

          ${item.icon}

        </span>

        <span
          style="color:${
            item.color ||
            'inherit'
          }">

          ${item.label}

        </span>
      `;

      element.onclick =
        async () => {
          document.getElementById('bottom-sheet-overlay').classList.remove('active');
          this.sendNativeMessage('overlay', { open: false, type: 'bottom-sheet' });

          await item.action();
        };

      container.appendChild(
        element
      );
    });

    document.getElementById('bottom-sheet-overlay').classList.add('active');
    this.sendNativeMessage('overlay', { open: true, type: 'bottom-sheet' });

    setTimeout(
      () => this.safeApplyMarquee(),
      50
    );
  }

  async deleteTrack(id) {
    if (!(await showAuraDialog('이 기기에서 완전히 삭제하시겠습니까?', { confirm: true, title: '곡 삭제' }))) return;

    try {
      await this.deleteTrackById(id);
      this.renderAll();
      this.updateSettingsUI();
    } catch (error) {
      console.error('[AuraSound] Track deletion failed:', error);
      alert(error?.message || '곡을 기기에서 삭제하지 못했습니다.');
    }
  }

  openPlaylistDetail(
    playlist
  ) {
    this.rememberDetailBackView('playlist-detail');
    this.state.activePlaylistId =
      playlist.id;

    this.state.playlistSortMode = 'default';

    document
      .getElementById(
        'playlist-search-input'
      )
      .value = '';
    document.getElementById('btn-clear-playlist-search')?.classList.add('hidden');

    document
      .getElementById(
        'pl-detail-title'
      )
      .textContent =
      playlist.name;

    document
      .getElementById(
        'pl-detail-desc'
      )
      .textContent =
      playlist.description || '';

    const playlistDetailCover = document.getElementById('pl-detail-cover');
    this.setCoverElement(
      playlistDetailCover,
      playlist.coverData || '',
      'queue_music'
    );

    this.renderPlaylistTracks(
      playlist,
      ''
    );

    this.switchView('playlist-detail');

    const playlistSheetArt = document.getElementById('pl-sheet-art');
    if (playlistSheetArt) {
      this.setCoverElement(
        playlistSheetArt,
        playlist.coverData || '',
        'queue_music'
      );
    }

    document
      .getElementById(
        'btn-play-playlist'
      )
      .onclick =
      () => {
        const tracks =
          this.getTracksForPlaylist(
            playlist
          );

        if (tracks.length) {
          const isCurrentPlaylist = this.state.currentTrackId
            && this.state.playbackContext?.type === 'playlist'
            && String(this.state.playbackContext.id) === String(playlist.id);

          if (isCurrentPlaylist) {
            this.player.togglePlay();
            return;
          }

          this.playTrack(
            tracks[0],
            tracks,
            0,
            { ...playlist, type: 'playlist' }
          );
        }
      };

    this.updatePlaylistPlayButton();

    document
      .getElementById(
        'btn-shuffle-playlist'
      )
      .onclick =
      () => {
        const tracks =
          this.getTracksForPlaylist(
            playlist
          );

        if (tracks.length) {
          const shuffled =
            [...tracks].sort(
              () =>
                Math.random() -
                0.5
            );

          this.state.isShuffle =
            true;

          this.storage.saveStateKey(
            'isShuffle',
            true
          );

          this.playTrack(
            shuffled[0],
            shuffled,
            0,
            { ...playlist, type: 'playlist' }
          );
        }
      };

  }

  getTracksForPlaylist(
    playlist
  ) {
    return playlist.trackIds
      .map(id => this.getTrackById(id))
      .filter(Boolean);
  }

  renderPlaylistTracks(
    playlist,
    query = ''
  ) {
    if (!playlist) return;

    const sortMode = this.state.playlistSortMode;
    const sortLabel = this.playlistSortOptions[sortMode] || '기본순';
    document.getElementById('btn-open-pl-sort')?.setAttribute('aria-label', `정렬 (현재: ${sortLabel})`);

    let tracks =
      this.getTracksForPlaylist(
        playlist
      );

    if (query) {
      const q =
        query
          .toLowerCase();

      tracks =
        tracks.filter(
          t =>
            t.title
              .toLowerCase()
              .includes(q) ||
            t.artist
              .toLowerCase()
              .includes(q)
        );
    }

    if (sortMode === 'title_asc') {
      tracks.sort((a, b) => a.title.localeCompare(b.title, 'ko', { sensitivity: 'base' }));
    } else if (sortMode === 'recent_desc') {
      tracks.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    } else if (sortMode === 'addedAt_desc') {
      tracks.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }

    document
      .getElementById(
        'pl-detail-sub'
      )
      .textContent =
      `${tracks.length}곡 • ${formatTotalTime(tracks)}`;

    const container =
      document.getElementById(
        'playlist-tracks-container'
      );

    const artworkLookup = this.buildArtworkLookup();

    container.innerHTML =
      tracks.length
        ? ''
        : `
          <div class="empty-state">
            <p>음악이 없습니다.</p>
          </div>
        `;

    tracks.forEach(
      track =>
        container.appendChild(
          this.createTrackRow(
            track,
            tracks,
            false,
            { ...playlist, type: 'playlist' },
            artworkLookup
          )
        )
    );

    setTimeout(
      () => this.safeApplyMarquee(),
      50
    );
  }

  openCreatePlaylistModal() {
    this.showModal(
      '새 플레이리스트',
      `
        <div class="modal-body-scroll">

          <input
            type="text"
            id="pl-name-input"
            class="form-input"
            placeholder="이름 입력">

        </div>
      `,
      async () => {
        const name =
          document
            .getElementById(
              'pl-name-input'
            )
            .value.trim();

        if (!name) {
          alert(
            '이름을 입력해주세요.'
          );

          return;
        }

        if (
          this.state.playlists.some(
            p =>
              p.name
                .trim()
                .toLowerCase() ===
              name.toLowerCase()
          )
        ) {
          alert(
            '이미 같은 이름의 플레이리스트가 있습니다.\n다른 이름을 입력해주세요.'
          );

          return;
        }

        const playlist = {
          id:
            'pl_' +
            Date.now(),

          name,

          description: '',

          trackIds: [],

          createdAt:
            Date.now(),


          coverData: ''
        };

        await this.storage.savePlaylist(
          playlist
        );

        this.state.playlists.push(
          playlist
        );

        this.renderLibrary(
          document.getElementById(
            'library-search-input'
          ).value
        );

        document
          .getElementById(
            'modal-overlay'
          )
          .classList.remove(
            'active'
          );

        this.updateSettingsUI();
      }
    );
  }

  openAddToPlaylistModal(
    track
  ) {
    let html =
      this.state.playlists
        .map(
          playlist => `
            <button
              class="btn-secondary clickable"
              style="
                width:100%;
                margin-bottom:8px;
                text-align:left"
              data-id="${playlist.id}">

              ${escapeHtml(
                playlist.name
              )}

            </button>
          `
        )
        .join('');

    if (!html) {
      html =
        '<p style="color:var(--text-secondary);text-align:center;">플레이리스트가 없습니다.</p>';
    }

    this.showModal(
      '플레이리스트 선택',
      `
        <div class="modal-body-scroll playlist-order-scroll">

          ${html}

        </div>
      `,
      null
    );

    document
      .querySelectorAll(
        '#modal-body .btn-secondary'
      )
      .forEach(
        button => {
          button.onclick =
            async () => {
              const playlist =
                this.getPlaylist(
                  button.dataset.id
                );

              if (
                playlist &&
                !playlist.trackIds.includes(
                  track.id
                )
              ) {
                playlist.trackIds.push(
                  track.id
                );

                await this.storage.savePlaylist(
                  playlist
                );
              }

              document
                .getElementById(
                  'modal-overlay'
                )
                .classList.remove(
                  'active'
                );
            };
        }
      );

    document
      .getElementById(
        'btn-modal-confirm'
      )
      .style.display =
      'none';
  }

  openPlaylistMenu() {
    const playlist =
      this.getPlaylist(
        this.state.activePlaylistId
      );

    if (!playlist) return;

    document
      .getElementById(
        'pl-sheet-title'
      )
      .textContent =
      playlist.name;

    this.setCoverElement(
      document.getElementById('pl-sheet-art'),
      playlist.coverData || '',
      'queue_music'
    );

    document
      .getElementById(
        'btn-pl-add-music'
      )
      .onclick =
      () => {
        this.closeSheet(
          'playlist-sheet-overlay'
        );

        this.modalAddMusicToPlaylist(
          playlist
        );
      };

    document
      .getElementById(
        'btn-pl-edit-order'
      )
      .onclick =
      () => {
        this.closeSheet(
          'playlist-sheet-overlay'
        );

        this.modalEditPlaylist(
          playlist
        );
      };

    document
      .getElementById(
        'btn-pl-edit-name'
      )
      .onclick =
      () => {
        this.closeSheet(
          'playlist-sheet-overlay'
        );

        this.modalEditPlaylistName(
          playlist
        );
      };

    this.addPlaylistCoverButtonToMenu(
      playlist
    );

    document
      .getElementById(
        'btn-pl-delete'
      )
      .onclick =
      () => {
        this.closeSheet(
          'playlist-sheet-overlay'
        );

        this.modalDeletePlaylist(
          playlist
        );
      };

    document.getElementById('playlist-sheet-overlay').classList.add('active');
    this.sendNativeMessage('overlay', { open: true, type: 'playlist-sheet' });

    setTimeout(
      () => this.safeApplyMarquee(),
      50
    );
  }

  modalAddMusicToPlaylist(
    playlist
  ) {
    const existingTrackIds = new Set(playlist.trackIds);
    const unadded =
      this.state.tracks.filter(
        track =>
          !existingTrackIds.has(
            track.id
          )
      );

    const renderList =
      tracks => {
        if (!tracks.length) {
          return `
            <p
              style="
                color:var(--text-secondary);
                text-align:center;
                padding:20px 0">

              곡이 없습니다.

            </p>
          `;
        }

        return tracks
          .map(
            track => `
              <label
                class="custom-checkbox-label">

                <input
                  type="checkbox"
                  value="${track.id}"
                  class="pl-add-checkbox">

                <div
                  class="truncate"
                  style="flex:1">

                  ${escapeHtml(
                    track.title
                  )}

                </div>

              </label>
            `
          )
          .join('');
      };

    const bodyHtml = `
      <div
        class="modal-body-scroll"
        style="max-height:350px">

        <div class="library-search-wrapper">
          <span class="material-symbols-rounded search-icon" aria-hidden="true">search</span>
          <input type="text" id="pl-add-search" aria-label="추가할 곡 검색" placeholder="곡 검색" autocomplete="off">
        </div>

        <div id="pl-add-list-container">

          ${renderList(
            unadded
          )}

        </div>

      </div>
    `;

    this.showModal(
      '음악 추가',
      bodyHtml,
      async () => {
        const selected =
          Array.from(
            document.querySelectorAll(
              '.pl-add-checkbox:checked'
            )
          ).map(
            cb => cb.value
          );

        if (selected.length) {
          playlist.trackIds.push(
            ...selected
          );

          await this.storage.savePlaylist(
            playlist
          );

          this.openPlaylistDetail(
            playlist
          );
        }

        document
          .getElementById(
            'modal-overlay'
          )
          .classList.remove(
            'active'
          );
      }
    );

    const searchInput =
      document.getElementById(
        'pl-add-search'
      );

    const listContainer =
      document.getElementById(
        'pl-add-list-container'
      );

    searchInput.addEventListener(
      'input',
      e => {
        const q =
          e.target.value
            .toLowerCase();

        const filtered =
          unadded.filter(
            track =>
              track.title
                .toLowerCase()
                .includes(q) ||
              track.artist
                .toLowerCase()
                .includes(q)
          );

        listContainer.innerHTML =
          renderList(
            filtered
          );
      }
    );
  }

  modalEditPlaylist(
    playlist
  ) {
    const tracksHtml = playlist.trackIds.map(id => {
      const track = this.getTrackById(id);
      if (!track) return '';
      return `
        <div class="drag-item playlist-drag-item" data-id="${track.id}">
          <button type="button" class="btn-icon drag-handle clickable" aria-label="순서 변경"><span class="material-symbols-rounded">drag_handle</span></button>
          <div class="track-main">
            <div class="track-title-viewport"><div class="track-title marquee-content">${escapeHtml(track.title)}</div></div>
            <div class="track-artist-viewport"><div class="track-artist marquee-content">${escapeHtml(track.artist)}</div></div>
          </div>
          <button class="btn-icon btn-remove-pl-track clickable" data-id="${track.id}" style="color:var(--danger-color);padding:4px" aria-label="곡 제거"><span class="material-symbols-rounded">remove_circle_outline</span></button>
        </div>`;
    }).join('');

    this.showModal('플레이리스트 편집',
      `<p class="editor-help-text">왼쪽 손잡이를 끌어 순서를 바꾸거나, 오른쪽 빼기 버튼으로 곡을 목록에서 빼세요.</p><div class="modal-body-scroll playlist-edit-scroll"><div id="drag-list">${tracksHtml || '<p>음악이 없습니다.</p>'}</div></div>`,
      async () => {
        const dragList = document.getElementById('drag-list');
        if (dragList) {
          playlist.trackIds = [...dragList.querySelectorAll('.playlist-drag-item')].map(el => el.dataset.id);
          await this.storage.savePlaylist(playlist);
          this.openPlaylistDetail(playlist);
        }
        document.getElementById('modal-overlay').classList.remove('active');
      }
    );

    const list = document.getElementById('drag-list');
    if (!list) return;
    this.setupHandleReorder(list, '.playlist-drag-item');
    list.querySelectorAll('.btn-remove-pl-track').forEach(button => {
      button.onclick = e => { e.stopPropagation(); e.currentTarget.closest('.playlist-drag-item')?.remove(); };
    });
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  setupHandleReorder(list, itemSelector, onCommit = null) {
    if (!list) return;
    let active = null, pointerId = null, moved = false;

    const finish = () => {
      const wasMoved = moved;
      if (active) active.classList.remove('dragging');
      active = null;
      pointerId = null;
      moved = false;
      if (wasMoved && typeof onCommit === 'function') onCommit();
    };

    list.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'mouse') return;
      const handle = e.target.closest('.drag-handle');
      const item = handle?.closest(itemSelector);
      if (!handle || !item) return;
      active = item;
      pointerId = e.pointerId;
      moved = false;
      active.classList.add('dragging');
      try { list.setPointerCapture(pointerId); } catch (_) {}
      e.preventDefault();
      e.stopPropagation();
    }, { passive:false });

    list.addEventListener('pointermove', e => {
      if (!active || e.pointerId !== pointerId) return;
      const y = e.clientY;
      const previous = active.previousElementSibling;
      const next = active.nextElementSibling;

      if (previous && previous.matches(itemSelector)) {
        const rect = previous.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
          list.insertBefore(active, previous);
          moved = true;
          e.preventDefault();
          return;
        }
      }

      if (next && next.matches(itemSelector)) {
        const rect = next.getBoundingClientRect();
        if (y > rect.top + rect.height / 2) {
          list.insertBefore(next, active);
          moved = true;
          e.preventDefault();
          return;
        }
      }
    }, { passive:false });

    list.addEventListener('pointerup', e => {
      if (e.pointerId === pointerId) finish();
    });
    list.addEventListener('pointercancel', e => {
      if (e.pointerId === pointerId) finish();
    });
  }

  modalEditPlaylistName(
    playlist
  ) {
    this.showModal(
      '이름 및 세부 정보 수정',
      `
        <div
          class="modal-body-scroll">

          <input
            type="text"
            id="pl-edit-name"
            class="form-input"
            value="${escapeHtml(
              playlist.name
            )}"
            placeholder="이름"
            style="margin-bottom:12px">

          <textarea
            id="pl-edit-desc"
            class="form-input"
            placeholder="설명 (선택사항)">${escapeHtml(
              playlist.description || ''
            )}</textarea>

        </div>
      `,
      async () => {
        const newName =
          document
            .getElementById(
              'pl-edit-name'
            )
            .value.trim();

        const newDescription =
          document
            .getElementById(
              'pl-edit-desc'
            )
            .value.trim();

        if (!newName) {
          alert(
            '이름을 입력해주세요.'
          );

          return;
        }

        if (
          this.state.playlists.some(
            p =>
              p.id !== playlist.id &&
              p.name
                .trim()
                .toLowerCase() ===
              newName.toLowerCase()
          )
        ) {
          alert(
            '이미 같은 이름의 플레이리스트가 있습니다.\n다른 이름을 입력해주세요.'
          );

          return;
        }

        playlist.name =
          newName;

        playlist.description =
          newDescription;

        await this.storage.savePlaylist(
          playlist
        );

        this.openPlaylistDetail(
          playlist
        );

        if (
          this.state.playbackContext &&
          this.state.playbackContext.id ===
            playlist.id
        ) {
          this.state.playbackContext.name =
            newName;

          this.updatePlayerUI(
            this.getCurrentTrack()
          );
        }

        document
          .getElementById(
            'modal-overlay'
          )
          .classList.remove(
            'active'
          );
      }
    );
  }

  modalDeletePlaylist(
    playlist
  ) {
    this.showModal(
      '플레이리스트 삭제',
      `
        <div
          class="modal-body-scroll">

          <p
            style="line-height:1.4">

            '${escapeHtml(
              playlist.name
            )}'
            플레이리스트를 삭제하시겠습니까?

            <br><br>

            <small
              style="color:var(--text-secondary)">

              플레이리스트 목록만 삭제되며,
              보관함의 음악 파일 자체는
              안전하게 유지됩니다.

            </small>

          </p>

        </div>
      `,
      async () => {
        await this.storage.deletePlaylist(
          playlist.id
        );

        this.state.playlists =
          this.state.playlists.filter(
            p =>
              p.id !==
              playlist.id
          );

        this.switchView(
          'library'
        );

        document
          .getElementById(
            'modal-overlay'
          )
          .classList.remove(
            'active'
          );

        this.updateSettingsUI();
      }
    );
  }

  getArtistTracksOrdered(artistName) {
    const all = this.state.tracks.filter(track => track.artist === artistName);
    const orders = this.getStoredLocalObject('auraArtistTrackOrder');
    const saved = Array.isArray(orders[artistName]) ? orders[artistName] : [];
    const byId = new Map(all.map(track => [track.id, track]));
    const ordered = saved.map(id => byId.get(id)).filter(Boolean);
    const used = new Set(ordered.map(track => track.id));
    all.forEach(track => { if (!used.has(track.id)) ordered.push(track); });
    return ordered;
  }

  openArtistDetail(
    artistName
  ) {
    this.rememberDetailBackView('artist-detail');
    this.state.artistDetailId = artistName;
    document.getElementById('artist-detail-title').textContent = artistName;

    this.state.artistSortMode = 'default';

    this.renderArtistTracks(artistName);

    const artistCovers = this.getStoredLocalObject('auraArtistCovers');
    this.setCoverElement(
      document.getElementById('artist-detail-image'),
      artistCovers[artistName] || '',
      'person'
    );

    this.switchView('artist-detail');

    document.getElementById('btn-play-artist').onclick = () => {
      const currentTracks = this.getVisibleArtistTracks(artistName);
      const isCurrentArtist = this.state.currentTrackId
        && this.state.playbackContext?.type === 'artist'
        && String(this.state.playbackContext.id) === `artist:${artistName}`;
      if (isCurrentArtist) {
        this.player.togglePlay();
        return;
      }
      if (currentTracks.length) this.playTrack(currentTracks[0], currentTracks, 0, { type: 'artist', id: `artist:${artistName}`, name: artistName });
    };
    document.getElementById('btn-shuffle-artist').onclick = () => {
      const currentTracks = this.getVisibleArtistTracks(artistName);
      if (currentTracks.length) {
        const shuffled = [...currentTracks].sort(() => Math.random() - 0.5);
        this.playTrack(shuffled[0], shuffled, 0, { type: 'artist', id: `artist:${artistName}`, name: artistName });
      }
    };
    document.getElementById('btn-artist-more').onclick = () => this.openArtistMenu(artistName, this.getArtistTracksOrdered(artistName));
    this.updatePlaylistPlayButton();
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  getVisibleArtistTracks(artistName) {
    let tracks = this.getArtistTracksOrdered(artistName);
    if (this.state.artistSortMode === 'title_asc') {
      tracks.sort((a, b) => a.title.localeCompare(b.title, 'ko', { sensitivity: 'base' }));
    } else if (this.state.artistSortMode === 'addedAt_desc') {
      tracks.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    } else if (this.state.artistSortMode === 'recent_desc') {
      tracks.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    }
    return tracks;
  }

  renderArtistTracks(artistName) {
    const tracks = this.getVisibleArtistTracks(artistName);
    const container = document.getElementById('artist-tracks-container');
    const artworkLookup = this.buildArtworkLookup();
    document.getElementById('artist-detail-sub').textContent = `${tracks.length}곡 • ${formatTotalTime(tracks)}`;
    container.innerHTML = tracks.length ? '' : '<div class="empty-state"><p>검색 결과가 없습니다.</p></div>';
    tracks.forEach(track => container.appendChild(this.createTrackRow(track, tracks, false, { type: 'artist', id: `artist:${artistName}`, name: artistName }, artworkLookup)));
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  openArtistSortSheet() {
    const container = document.getElementById('artist-sort-menu-items');
    this.renderSortOptions(container, this.artistSortOptions, this.state.artistSortMode, value => {
      this.state.artistSortMode = value;
      document.getElementById('artist-sort-sheet-overlay').classList.remove('active');
      this.renderArtistTracks(this.state.artistDetailId);
    });
    document.getElementById('artist-sort-sheet-overlay').classList.add('active');
  }

  openArtistMenu(artistName, tracks) {
    const overlay = document.getElementById('artist-sheet-overlay');
    if (!overlay) return;

    document.getElementById('artist-sheet-title').textContent = artistName;
    const artistCovers = this.getStoredLocalObject('auraArtistCovers');
    this.setCoverElement(
      document.getElementById('artist-sheet-art'),
      artistCovers[artistName] || '',
      'person'
    );

    const list = overlay.querySelector('.sheet-menu-list');
    list.innerHTML = `
      <div class="sheet-menu-item clickable" id="btn-artist-playlist-edit">
        <span class="material-symbols-rounded">format_list_numbered</span><span>순서 편집하기</span>
      </div>
      <div class="sheet-menu-item clickable" id="btn-artist-cover-edit">
        <span class="material-symbols-rounded">image</span><span>커버 변경하기</span>
      </div>
    `;
    document.getElementById('btn-artist-playlist-edit').onclick = () => {
      overlay.classList.remove('active');
      this.openArtistTrackEditor(artistName, tracks);
    };
    document.getElementById('btn-artist-cover-edit').onclick = () => {
      overlay.classList.remove('active');
      this.openArtistCoverEditor(artistName);
    };
    if (this.state.activeView === 'artist-detail' && this.state.artistDetailId === artistName) {
      const sort = document.createElement('div');
      sort.className = 'sheet-menu-item clickable';
      sort.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">sort</span><span>곡 표시 순서</span>';
      sort.onclick = () => {
        overlay.classList.remove('active');
        this.openArtistSortSheet();
      };
      list.appendChild(sort);
    }

    overlay.classList.add('active');
    this.sendNativeMessage('overlay', { open: true, type: 'artist-sheet' });
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  openArtistTrackEditor(artistName, tracks) {
    const html = tracks.map(track => `
      <div class="drag-item artist-drag-item" data-id="${track.id}">
        <button type="button" class="btn-icon drag-handle clickable" aria-label="순서 변경"><span class="material-symbols-rounded">drag_handle</span></button>
        <div class="track-main">
          <div class="track-title-viewport"><div class="track-title marquee-content">${escapeHtml(track.title)}</div></div>
          <div class="track-artist-viewport"><div class="track-artist marquee-content">${escapeHtml(track.artist)}</div></div>
        </div>
      </div>`).join('');

    this.showModal(
      '아티스트 곡 순서 편집',
      `<p class="editor-help-text">왼쪽의 = 버튼을 누른 상태로 위아래로 움직여 곡 순서를 변경하세요.</p><div class="modal-body-scroll artist-edit-scroll"><div id="artist-drag-list">${html || '<p>음악이 없습니다.</p>'}</div></div>`,
      async () => {
        const list = document.getElementById('artist-drag-list');
        if (list) {
          const order = [...list.querySelectorAll('.artist-drag-item')].map(el => el.dataset.id);
          const orders = JSON.parse(localStorage.getItem('auraArtistTrackOrder') || '{}');
          orders[artistName] = order;
          localStorage.setItem('auraArtistTrackOrder', JSON.stringify(orders));
        }
        document.getElementById('modal-overlay').classList.remove('active');
        this.openArtistDetail(artistName);
        this.renderLibrary(document.getElementById('library-search-input')?.value || '');
      }
    );

    const list = document.getElementById('artist-drag-list');
    if (!list) return;
    this.setupHandleReorder(list, '.artist-drag-item');
    setTimeout(() => this.safeApplyMarquee(), 30);
  }

  openArtistCoverEditor(artistName) {
    const covers = this.getStoredLocalObject('auraArtistCovers');
    this.openCoverEditor({
      title: '아티스트 커버 변경', inputId: 'artist-cover-file', previewId: 'artist-cover-preview',
      icon: 'person', cropShape: 'circle', currentData: covers[artistName] || '', sourceKey: `artist:${artistName}`,
      onSave: async ({ cropData }) => {
        if (!cropData) { alert('이미지를 선택하거나 기존 사진을 조절해주세요.'); throw new Error('커버 이미지가 없습니다.'); }
        const current = this.getStoredLocalObject('auraArtistCovers');
        current[artistName] = cropData;
        localStorage.setItem('auraArtistCovers', JSON.stringify(current));
      },
      afterSave: async () => {
        this.openArtistDetail(artistName);
        this.renderLibrary(document.getElementById('library-search-input')?.value || '');
      }
    });
  }

  async toggleRepeat() {
    const modes = [
      'off',
      'all',
      'one'
    ];

    this.state.repeatMode =
      modes[
        (
          modes.indexOf(
            this.state.repeatMode
          ) + 1
        ) %
        modes.length
      ];

    await this.storage.saveStateKey(
      'repeatMode',
      this.state.repeatMode
    );

    this.sendNativeMessage('repeat', { mode: this.state.repeatMode });

    const button =
      document.getElementById(
        'btn-repeat'
      );

    button.classList.toggle(
      'active',
      this.state.repeatMode !== 'off'
    );
    button.dataset.repeatMode = this.state.repeatMode;
    button.setAttribute(
      'aria-label',
      this.state.repeatMode === 'off'
        ? '반복 꺼짐'
        : this.state.repeatMode === 'all'
          ? '전체 반복'
          : '한 곡 반복'
    );
    button.title =
      this.state.repeatMode === 'off'
        ? '반복 꺼짐'
        : this.state.repeatMode === 'all'
          ? '전체 반복: 재생 목록이 끝나면 처음부터 다시 재생'
          : '한 곡 반복: 현재 곡을 끝없이 반복';
    button
      .querySelector('span')
      .textContent = this.state.repeatMode === 'one' ? 'repeat_one' : 'repeat';
  }

  async toggleShuffle() {
    this.state.isShuffle =
      !this.state.isShuffle;

    await this.storage.saveStateKey(
      'isShuffle',
      this.state.isShuffle
    );

    this.sendNativeMessage('shuffle', { enabled: this.state.isShuffle });

    document
      .getElementById(
        'btn-shuffle'
      )
      .classList.toggle(
        'active',
        this.state.isShuffle
      );
  }

  updateSettingsUI() {
    document
      .getElementById(
        'setting-storage-info'
      )
      .textContent =
      `음악 ${this.state.tracks.length}곡, 플레이리스트 ${this.state.playlists.length}개`;
  }

  resetAppData() {
    this.showModal(
      '모든 데이터 초기화',
      `
        <div class="reset-confirmation">
          <span class="material-symbols-rounded" aria-hidden="true">warning</span>
          <p>기기에 저장된 음악, 플레이리스트, 커버와 설정을 모두 삭제합니다.</p>
          <small>삭제한 데이터는 복구할 수 없습니다.</small>
        </div>
      `,
      async () => {
        const confirmButton = document.getElementById('btn-modal-confirm');
        confirmButton.disabled = true;
        confirmButton.textContent = '초기화 중…';

        try {
          if (this.browserAudio) this.player.setSrc('');
          this.player.stopTimeUpdates();
          this.player.currentTrackId = null;
          this.player.currentTime = 0;
          this.player.duration = 0;
          this.player.lastStateAt = 0;
          this.player.lastStatePosition = 0;
          this.player.paused = true;
          this.player.clockRunning = false;
          this.player.src = '';

          await this.storage.clearAll();
          NativeMusicStorage.clearFiles();
          localStorage.clear();
          localStorage.setItem('theme', 'dark');

          this.sendNativeMessage('overlay', { open: false, type: 'modal' });
          this.sendNativeMessage('resetPlayback');
          window.location.reload();
        } catch (error) {
          console.error('[AuraSound Reset]', error);
          confirmButton.disabled = false;
          confirmButton.textContent = '다시 시도';
          alert('초기화 중 오류가 발생했습니다. 다시 시도해 주세요.');
        }
      }
    );
  }

  showModal(
    title,
    bodyHTML,
    onConfirm
  ) {
    document
      .getElementById(
        'modal-title'
      )
      .textContent =
      title;

    document
      .getElementById(
        'modal-body'
      )
      .innerHTML =
      bodyHTML;

    const cancelButton = document.getElementById('btn-modal-cancel');
    if (cancelButton) {
      cancelButton.textContent = '취소';
      cancelButton.classList.remove('has-leading-icon');
    }

    const button =
      document.getElementById(
        'btn-modal-confirm'
      );
    button.textContent = '확인';
    button.disabled = false;
    button.onclick = null;

    if (onConfirm) {
      button.style.display =
        'block';

      button.onclick =
        onConfirm;
    } else {
      button.style.display =
        'none';
    }

    document.getElementById('modal-overlay').classList.add('active');
    this.sendNativeMessage('overlay', { open: true, type: 'modal' });
  }

  closeSheet(id) {
    document
      .getElementById(id)
      .classList.remove(
        'active'
      );
  }

  refreshQueueIfOpen() {
    const overlay = document.getElementById('queue-sheet-overlay');
    if (overlay?.classList.contains('active')) {
      this.renderQueueSheet();
    }
  }

  renderQueueSheet() {
    const container =
      document.getElementById(
        'queue-list-container'
      );

    container.innerHTML = '';
    container._queueSnapshot = this.state.queue.slice();

    this.state.queue.forEach(
      (track, index) => {
        const row =
          document.createElement(
            'div'
          );

        row.className =
          `drag-item queue-drag-item ${
            index ===
            this.state.queueIndex
              ? 'playing'
              : ''
          }`;

        row.dataset.queueKey = index;

        const titleStyle =
          index ===
          this.state.queueIndex
            ? 'color:var(--accent-cyan);font-weight:600;'
            : '';

        row.innerHTML = `
          <button type="button" class="btn-icon drag-handle clickable" aria-label="순서 변경"><span class="material-symbols-rounded">drag_handle</span></button>

          <div
            style="
              flex:1;
              overflow:hidden"
            class="clickable queue-track-main">

            <div
              class="track-title-viewport" style="${titleStyle}"><span class="marquee-content">

              ${escapeHtml(track.title)}
            </span></div>

            <div
              style="
                font-size:.8rem;
                color:var(--text-secondary)"
              class="track-artist-viewport"><span class="marquee-content">
              ${escapeHtml(track.artist)}
            </span></div>

          </div>

          <button
            class="btn-icon btn-remove-q-track clickable"
            data-index="${index}"
            style="
              color:var(--text-muted);
              padding:4px">

            <span
              class="material-symbols-rounded">
              close
            </span>

          </button>
        `;

        row
          .querySelector(
            '.queue-track-main'
          )
          .onclick =
          () =>
            this.playTrack(
              this.state.queue[
                index
              ],
              this.state.queue,
              index,
              this.state.playbackContext
            );

        container.appendChild(
          row
        );
      }
    );

    document
      .querySelectorAll(
        '.btn-remove-q-track'
      )
      .forEach(button => {
        button.onclick =
          async e => {
            e.stopPropagation();

            const index =
              parseInt(
                e.currentTarget.dataset.index
              );

            this.state.queue.splice(
              index,
              1
            );

            if (
              index <
              this.state.queueIndex
            ) {
              this.state.queueIndex--;
            } else if (
              index ===
              this.state.queueIndex
            ) {
              if (
                this.state.queue.length
              ) {
                this.state.queueIndex = index - 1;
                this.playNext(true);
              } else {
                this.player.audio.pause();

                this.state.currentTrackId =
                  null;
                this.state.currentPlaybackPosition = 0;
                void this.storage.saveStateKey('lastPlaybackPosition', 0);

                document
                  .getElementById(
                    'mini-player'
                  )
                  .classList.add(
                    'hidden'
                  );
                this.closeFullPlayer();
              }
            }

            await this.storage.saveStateKey(
              'queue',
              this.state.queue
            );

            await this.storage.saveStateKey(
              'queueIndex',
              this.state.queueIndex
            );
            this.syncNativeQueue();

            this.renderQueueSheet();
          };
      });
  }

  setupQueueDragAndDrop() {
    const list = document.getElementById('queue-list-container');
    if (!list) return;

    this.setupHandleReorder(list, '.queue-drag-item', async () => {
      const snapshot = list._queueSnapshot || this.state.queue.slice();
      const items = [...list.querySelectorAll('.queue-drag-item')];
      if (!items.length) return;

      const currentSnapshotIndex = this.state.queueIndex;
      const newQueue = items
        .map(item => snapshot[Number(item.dataset.queueKey)])
        .filter(Boolean);

      this.state.queue = newQueue;
      const newIndex = currentSnapshotIndex >= 0
        ? items.findIndex(item => Number(item.dataset.queueKey) === currentSnapshotIndex)
        : -1;
      if (newIndex >= 0) this.state.queueIndex = newIndex;

      await this.storage.saveStateKey('queue', this.state.queue);
      await this.storage.saveStateKey('queueIndex', this.state.queueIndex);
      this.syncNativeQueue();
      this.renderQueueSheet();
    });
  }

  updatePlayerUI(track) {
    if (!track) return;

    document
      .getElementById(
        'mini-player'
      )
      .classList.remove(
        'hidden'
      );

    document
      .getElementById(
        'mini-title'
      )
      .textContent =
      track.title;

    document
      .getElementById(
        'mini-artist'
      )
      .textContent =
      track.artist;
    document.getElementById('mini-inline-artist').textContent = track.artist;

    document
      .getElementById(
        'full-title'
      )
      .textContent =
      track.title;

    document
      .getElementById(
        'full-artist'
      )
      .textContent =
      track.artist;

    const duration = Number(track.duration) || this.player.duration || 0;
    const position = Math.max(0, this.state.currentPlaybackPosition || this.player.currentTime || 0);
    const progress = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
    const seekBar = document.getElementById('full-seek-bar');
    if (seekBar) {
      seekBar.value = progress;
      seekBar.style.setProperty('--seek-progress', `${progress}%`);
    }
    const miniProgress = String(progress / 100);
    document.getElementById('mini-progress-fill')?.style.setProperty('--mini-progress', miniProgress);
    document.getElementById('mini-player')?.style.setProperty('--mini-progress', miniProgress);

    const artwork = this.getTrackArtworkData(track);
    this.setCoverElement(
      document.querySelector(
        '.mini-album-art'
      ),
      artwork,
      'music_note'
    );

    this.updateMiniPlayerColor(artwork);

    this.setCoverElement(
      document.querySelector(
        '.full-album-art'
      ),
      artwork,
      'music_note'
    );

    const headingEl = document.getElementById('full-player-heading');
    if (headingEl) {
      const context = this.state.playbackContext || { type: 'library', name: track.title };
      const labels = {
        playlist: '플레이리스트에서 재생',
        artist: '아티스트에서 재생',
        album: '앨범에서 재생',
        library: '보관함에서 재생',
        folder: '폴더에서 재생'
      };
      const contextName = context.type === 'library' ? track.title : (context.name || track.title);
      headingEl.innerHTML = `${labels[context.type] || labels.library}<br><span>${escapeHtml(contextName)}</span>`;
    }

    document
      .getElementById(
        'btn-shuffle'
      )
      .classList.toggle(
        'active',
        this.state.isShuffle
      );

    const repeatBtn =
      document.getElementById(
        'btn-repeat'
      );

    repeatBtn.classList.toggle('active', this.state.repeatMode !== 'off');
    repeatBtn.dataset.repeatMode = this.state.repeatMode;
    repeatBtn.setAttribute('aria-label', this.state.repeatMode === 'off' ? '반복 꺼짐' : this.state.repeatMode === 'all' ? '전체 반복' : '한 곡 반복');
    repeatBtn.title = this.state.repeatMode === 'off' ? '반복 꺼짐' : this.state.repeatMode === 'all' ? '전체 반복: 재생 목록 전체를 반복' : '한 곡 반복: 현재 곡만 반복';
    repeatBtn.querySelector('span').textContent = this.state.repeatMode === 'one' ? 'repeat_one' : 'repeat';

    this.updateActiveTrackHighlights();
    this.updatePlaylistPlayButton();

    setTimeout(
      () => this.safeApplyMarquee(),
      50
    );
  }

  updateMediaSession(track) {
    if (window.AuraSoundNative) {
      return;
    }

    if (
      !('mediaSession' in navigator)
    ) {
      return;
    }

    try {
      const artwork = this.getTrackArtworkData(track);
      navigator.mediaSession.metadata =
        new MediaMetadata({
          title:
            track.title,

          artist:
            track.artist ||
            'Unknown Artist',

          album:
            track.album ||
            'AuraSound',

          artwork: artwork ? [{ src: artwork }] : []
        });

      const set =
        (
          action,
          handler
        ) => {
          try {
            navigator.mediaSession
              .setActionHandler(
                action,
                handler
              );
          } catch (_) {}
        };

      set(
        'play',
        () =>
          this.player.audio
            .play()
            .catch(() => {})
      );

      set(
        'pause',
        () =>
          this.player.audio.pause()
      );

      set(
        'previoustrack',
        () => this.playPrev()
      );

      set(
        'nexttrack',
        () =>
          this.playNext(true)
      );

      set(
        'seekbackward',
        details => {
          this.player.audio.currentTime =
            Math.max(
              0,
              this.player.audio.currentTime -
                (
                  details.seekOffset ||
                  10
                )
            );
        }
      );

      set(
        'seekforward',
        details => {
          this.player.audio.currentTime =
            Math.min(
              this.player.audio.duration ||
                Infinity,
              this.player.audio.currentTime +
                (
                  details.seekOffset ||
                  10
                )
            );
        }
      );

      set(
        'seekto',
        details => {
          if (
            details.fastSeek &&
            'fastSeek' in
              this.player.audio
          ) {
            this.player.audio.fastSeek(
              details.seekTime
            );
          } else {
            this.player.audio.currentTime =
              details.seekTime;
          }
        }
      );

      set(
        'stop',
        () => {
          this.player.audio.pause();
          this.player.audio.currentTime =
            0;
        }
      );

      if (
        'setPositionState' in
        navigator.mediaSession &&
        Number.isFinite(
          this.player.audio.duration
        ) &&
        this.player.audio.duration >
          0
      ) {
        navigator.mediaSession.setPositionState(
          {
            duration:
              this.player.audio.duration,

            playbackRate:
              this.player.audio.playbackRate ||
              1,

            position:
              Math.min(
                this.player.audio.currentTime,
                this.player.audio.duration
              )
          }
        );
      }
    } catch (err) {
      console.warn(
        '[AuraSound MediaSession]',
        err
      );
    }
  }

  safeApplyMarquee() {
    if (this._marqueeFrame) return;
    this._marqueeFrame = requestAnimationFrame(
      () => {
        this._marqueeFrame = 0;
        const viewports =
          document.querySelectorAll(
            '.track-title-viewport, .track-artist-viewport, .quick-title-viewport'
          );

        const measurements = [];
        for (const viewport of viewports) {
          const content = viewport.querySelector('.marquee-content');
          const width = viewport.clientWidth;
          if (content && width) measurements.push({ content, width, textWidth: content.offsetWidth });
        }

        for (const { content, width, textWidth } of measurements) {
          if (textWidth > width + 2) {
            const period = textWidth + 32;
            const scrollDistance = `-${period}px`;
            if (content.style.getPropertyValue('--scroll-dist') !== scrollDistance) {
              content.style.setProperty('--scroll-dist', scrollDistance);
              content.style.setProperty('--marquee-duration', `${period / 30}s`);
            }
            // The mini player has separate title, separator and artist styles.
            const parts = content.children.length ? content.children : [content];
            for (const part of parts) part.dataset.marqueeText = part.textContent.trim();
            content.style.removeProperty('transform');
            content.classList.add('marquee-anim');
          } else {
            content.classList.remove('marquee-anim');
            content.style.removeProperty('--scroll-dist');
            content.style.removeProperty('--marquee-duration');
            if (content.style.transform !== 'translateX(0)') content.style.transform = 'translateX(0)';
          }
        }
      }
    );
  }

  updateActiveTrackHighlights() {
    const current =
      this.getCurrentTrack();

    document
      .querySelectorAll(
        '.track-row'
      )
      .forEach(row => {
        const active = row.dataset.contextType
          ? this.isCurrentCollection(row.dataset.contextType, row.dataset.contextId)
          : Boolean(current && row.dataset.id === current.id);
        row.classList.toggle('playing', active);
      });
  }

  isCurrentCollection(type, id) {
    const context = this.state.playbackContext;
    return Boolean(this.state.currentTrackId && id != null && context?.type === type
      && String(context.id) === String(id));
  }

  updatePlaylistPlayButton() {
    const activeContexts = [
      ['btn-play-playlist', 'playlist', this.state.activePlaylistId],
      ['btn-play-album', 'album', this.state.albumDetailId],
      ['btn-play-artist', 'artist', this.state.artistDetailId == null ? null : `artist:${this.state.artistDetailId}`]
    ];

    activeContexts.forEach(([buttonId, type, id]) => {
      const button = document.getElementById(buttonId);
      if (!button) return;
      const isPlaying = this.isCurrentCollection(type, id) && this.state.isPlaying;
      const icon = button.querySelector('.material-symbols-rounded');
      if (icon) icon.textContent = isPlaying ? 'pause' : 'play_arrow';
      button.setAttribute('aria-label', isPlaying ? '일시정지' : '전체 재생');
    });
  }

}

let app;

window.addEventListener('pagehide', () => {
  if (window.app && window.app.state?.currentTrackId) {
    void window.app.persistPlaybackPosition(window.app.player.getCurrentTime());
  }
});

document.addEventListener('visibilitychange', () => {
  const app = window.app;
  if (!app) return;
  app.player.setVisible(document.visibilityState === 'visible');
  if (!app.state?.currentTrackId) return;

  if (document.visibilityState === 'hidden') {
    void app.persistPlaybackPosition(app.player.getCurrentTime());
    return;
  }

  if (document.visibilityState === 'visible') {
    app.syncNativeQueue();
    app.sendNativeMessage('repeat', { mode: app.state.repeatMode });
    app.sendNativeMessage('shuffle', { enabled: app.state.isShuffle });
  }
});

window.__auraSoundBackupResult = (type, payload) => {
  if (window.app && typeof window.app.handleBackupResult === 'function') {
    window.app.handleBackupResult(type, payload);
  }
};

window.addEventListener(
  'DOMContentLoaded',
  () => {
    app = new App();
    window.app = app;
    app.init();
  }
);
