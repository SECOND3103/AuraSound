import { NativeMusicStorage } from './native-storage.js';

const DB_NAME = 'music-player-db';
const DB_VERSION = 3;

export class StorageManager {
  constructor({ browserAudio = false } = {}) {
    this.db = null;
    this.browserAudio = browserAudio;
  }

  async init() {
    const library = window.AuraSoundLibrary;
    // The Android bridge is installed before the WebView loads the app.
    const initialized = library?.isInitialized();
    try {
      await this.openWebDatabase();
    } catch (error) {
      if (!initialized) throw error;
      console.warn('[AuraSound] 웹 저장소를 열 수 없습니다.', error);
    }
    if (!library) return;
    const ids = new Set(JSON.parse(library.keys('tracks')));
    if (!initialized || !ids.size) {
      await this.reconcileMusicFiles(library, window.AuraSoundNative, ids, !initialized);
    }
    this.library = library;
  }

  openWebDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('tracks')) {
          db.createObjectStore('tracks', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('playlists')) {
          db.createObjectStore('playlists', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('appState')) {
          db.createObjectStore('appState', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('coverSources')) {
          db.createObjectStore('coverSources', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('audioFiles')) {
          db.createObjectStore('audioFiles');
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        this.db.onversionchange = () => this.db.close();
        resolve();
      };

      request.onerror = (e) => reject(e.target.error);
    });
  }

  async reconcileMusicFiles(library, files, ids, migrate) {
    // Mark complete only after all three stores and any surviving audio have
    // been reconciled. A killed process can resume the same migration.
    const names = JSON.parse(files.listMusicFiles());
    const [tracks, playlists, state] = migrate ? await Promise.all([
      this.getAllTracks(), this.getAllPlaylists(), this.getAllState()
    ]) : [[], [], []];
    const paths = new Set();
    const onDisk = new Set(names.map(name => 'Music/' + name));
    const filesById = new Map();
    const importedName = /^(?:\d{4,}_)?(track_\d+_[a-z0-9]{1,5})_(.+)$/i;
    for (const name of names) {
      const match = importedName.exec(name);
      if (!match) continue;
      const previous = filesById.get(match[1]);
      if (!previous || (!previous.startsWith('track_') && name.startsWith('track_'))) {
        filesById.set(match[1], name);
      }
    }
    for (const track of tracks) {
      const { fileBlob, ...record } = track;
      if (!onDisk.has(record.filePath)) {
        const prior = ids.has(record.id) && JSON.parse(library.readRecord('tracks', record.id));
        // beginImport uses the track ID and the original file name.
        const existing = filesById.get(record.id);
        if (prior && onDisk.has(prior.filePath)) record.filePath = prior.filePath;
        else if (existing) record.filePath = 'Music/' + existing;
        else {
          const blob = fileBlob || await this.getBrowserAudioFile(record.id);
          if (blob) {
            const file = new File([blob], record.fileName || blob.name || 'audio', { type: blob.type });
            record.filePath = await NativeMusicStorage.importFile(file, record.id);
          }
        }
      }
      library.putRecords('tracks', JSON.stringify([record]));
      paths.add(record.filePath);
      ids.add(record.id);
    }
    for (const playlist of playlists) library.putRecords('playlists', JSON.stringify([playlist]));
    for (const entry of state) library.putRecords('appState', JSON.stringify([entry]));
    const recovered = [];
    for (const name of names) {
      const filePath = 'Music/' + name;
      if (paths.has(filePath)) continue;
      // Older ZIP restores prepended the numeric position in the archive.
      const match = importedName.exec(name);
      if (match && filesById.get(match[1]) !== name) continue;
      const id = match ? match[1] : 'recovered_' + name;
      if (ids.has(id)) continue;
      const metadata = JSON.parse(files.describeMusicFile(name));
      if (!metadata) continue;
      const fileName = match ? match[2] : name;
      const stem = fileName.replace(/\.[^.]+$/, '');
      const separator = stem.indexOf('-');
      const record = {
        ...metadata, id, filePath, fileName, folderPath: 'Music', folderName: 'AuraSound Music',
        title: metadata.title || (separator >= 0 && stem.slice(separator + 1).trim()) || stem,
        artist: metadata.artist || (separator >= 0 && stem.slice(0, separator).trim()) || 'Unknown Artist',
        playCount: 0, recoveredFromFile: true
      };
      recovered.push(record);
      ids.add(id);
    }
    if (recovered.length) library.putRecords('tracks', JSON.stringify(recovered));
    if (migrate) library.finishMigration();
  }

  readLibrary(store) {
    return JSON.parse(this.library.keys(store)).map(id => JSON.parse(this.library.readRecord(store, id)));
  }

  runTransaction(stores, mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, mode);
      let request;
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = event => reject(tx.error || event.target.error || new Error('Storage operation failed'));
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
      try {
        request = operation(tx);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  saveTrack(track) {
    return this.saveTracks([track]);
  }

  saveBrowserTrack(track) {
    const { fileBlob, ...metadata } = track;
    return this.runTransaction(['tracks', 'audioFiles'], 'readwrite', tx => {
      tx.objectStore('tracks').put(metadata);
      tx.objectStore('audioFiles').put(fileBlob, track.id);
    });
  }

  getBrowserAudioFile(id) {
    return this.runTransaction(['audioFiles'], 'readonly', tx => tx.objectStore('audioFiles').get(id));
  }

  async saveTracks(tracks) {
    if (this.library) {
      const records = tracks.map(({ fileBlob, ...record }) => record);
      this.library.putRecords('tracks', JSON.stringify(records));
      return;
    }
    return this.runTransaction(['tracks'], 'readwrite', tx => {
      const store = tx.objectStore('tracks');
      for (const track of tracks) {
        const { fileBlob, ...metadata } = track || {};
        store.put(metadata);
      }
    });
  }

  async getAllTracks() {
    if (this.library) return this.readLibrary('tracks');
    return this.runTransaction(['tracks'], 'readonly', tx => tx.objectStore('tracks').getAll());
  }

  async deleteTrack(id) {
    if (this.library) return this.library.removeRecord('tracks', id);
    const stores = this.browserAudio ? ['tracks', 'audioFiles'] : ['tracks'];
    return this.runTransaction(stores, 'readwrite', tx => {
      tx.objectStore('tracks').delete(id);
      if (this.browserAudio) tx.objectStore('audioFiles').delete(id);
    });
  }

  async savePlaylist(playlist) {
    if (this.library) return this.library.putRecords('playlists', JSON.stringify([playlist]));
    return this.runTransaction(['playlists'], 'readwrite', tx => { tx.objectStore('playlists').put(playlist); });
  }

  async getAllPlaylists() {
    if (this.library) return this.readLibrary('playlists');
    return this.runTransaction(['playlists'], 'readonly', tx => tx.objectStore('playlists').getAll());
  }

  async deletePlaylist(id) {
    if (this.library) return this.library.removeRecord('playlists', id);
    return this.runTransaction(['playlists'], 'readwrite', tx => { tx.objectStore('playlists').delete(id); });
  }

  async getCoverSource(id) {
    return this.runTransaction(['coverSources'], 'readonly', tx => tx.objectStore('coverSources').get(id))
      .then(record => record || null, () => null);
  }

  async saveCoverSource(record) {
    return this.runTransaction(['coverSources'], 'readwrite', tx => { tx.objectStore('coverSources').put(record); });
  }

  async saveStateKey(key, value) {
    return this.saveStateEntries([{ key, value }]);
  }

  async savePlaybackState(trackId, position) {
    return this.saveStateEntries([
      { key: 'lastTrackId', value: trackId },
      { key: 'lastPlaybackPosition', value: position }
    ]);
  }

  async saveStateEntries(entries) {
    if (this.library) {
      this.library.putRecords('appState', JSON.stringify(entries));
      return;
    }
    return this.runTransaction(['appState'], 'readwrite', tx => {
      const store = tx.objectStore('appState');
      for (const entry of entries) store.put(entry);
    });
  }

  async getStateKey(key) {
    if (this.library) return JSON.parse(this.library.readRecord('appState', key))?.value ?? null;
    return this.runTransaction(['appState'], 'readonly', tx => tx.objectStore('appState').get(key))
      .then(record => record !== undefined ? record.value : null);
  }

  async getAllState() {
    if (this.library) return this.readLibrary('appState');
    return this.runTransaction(['appState'], 'readonly', tx => tx.objectStore('appState').getAll());
  }

  async clearAll() {
    const stores = ['tracks', 'playlists', 'appState', 'coverSources'];
    if (this.browserAudio || this.library) stores.push('audioFiles');

    if (this.db) await this.runTransaction(stores, 'readwrite', tx => {
      for (const store of stores) tx.objectStore(store).clear();
    });
    this.library?.clearRecords();
  }
}
