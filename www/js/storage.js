const DB_NAME = 'music-player-db';
const DB_VERSION = 2;

export class StorageManager {
  constructor() {
    this.db = null;
  }

  async init() {
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
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };

      request.onerror = (e) => reject(e.target.error);
    });
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

  saveTracks(tracks) {
    return this.runTransaction(['tracks'], 'readwrite', tx => {
      const store = tx.objectStore('tracks');
      for (const track of tracks) {
        const { fileBlob, ...metadata } = track || {};
        store.put(metadata);
      }
    });
  }

  async getAllTracks() {
    return this.runTransaction(['tracks'], 'readonly', tx => tx.objectStore('tracks').getAll());
  }

  async deleteTrack(id) {
    return this.runTransaction(['tracks'], 'readwrite', tx => { tx.objectStore('tracks').delete(id); });
  }

  async savePlaylist(playlist) {
    return this.runTransaction(['playlists'], 'readwrite', tx => { tx.objectStore('playlists').put(playlist); });
  }

  async getAllPlaylists() {
    return this.runTransaction(['playlists'], 'readonly', tx => tx.objectStore('playlists').getAll());
  }

  async deletePlaylist(id) {
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

  saveStateEntries(entries) {
    return this.runTransaction(['appState'], 'readwrite', tx => {
      const store = tx.objectStore('appState');
      for (const entry of entries) store.put(entry);
    });
  }

  async getStateKey(key) {
    return this.runTransaction(['appState'], 'readonly', tx => tx.objectStore('appState').get(key))
      .then(record => record !== undefined ? record.value : null);
  }

  async getAllState() {
    return this.runTransaction(['appState'], 'readonly', tx => tx.objectStore('appState').getAll());
  }

  async clearAll() {
    const stores = ['tracks', 'playlists', 'appState', 'coverSources'];

    return this.runTransaction(stores, 'readwrite', tx => {
      for (const store of stores) tx.objectStore(store).clear();
    });
  }
}
