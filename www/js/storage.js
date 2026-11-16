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

  async saveTrack(track) {
    const { fileBlob, ...metadata } = track || {};
    const tx = this.db.transaction(['tracks'], 'readwrite');

    return new Promise((resolve, reject) => {
      tx.objectStore('tracks').put(metadata);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllTracks() {
    const tx = this.db.transaction(['tracks'], 'readonly');

    return new Promise((resolve) => {
      const req = tx.objectStore('tracks').getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  }

  async deleteTrack(id) {
    const tx = this.db.transaction(['tracks'], 'readwrite');

    return new Promise(resolve => {
      tx.objectStore('tracks').delete(id);
      tx.oncomplete = () => resolve();
    });
  }

  async savePlaylist(playlist) {
    const tx = this.db.transaction(['playlists'], 'readwrite');

    return new Promise(resolve => {
      tx.objectStore('playlists').put(playlist);
      tx.oncomplete = () => resolve();
    });
  }

  async getAllPlaylists() {
    const tx = this.db.transaction(['playlists'], 'readonly');

    return new Promise(resolve => {
      const req = tx.objectStore('playlists').getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  }

  async deletePlaylist(id) {
    const tx = this.db.transaction(['playlists'], 'readwrite');

    return new Promise(resolve => {
      tx.objectStore('playlists').delete(id);
      tx.oncomplete = () => resolve();
    });
  }

  async getCoverSource(id) {
    const tx = this.db.transaction(['coverSources'], 'readonly');
    return new Promise(resolve => {
      const req = tx.objectStore('coverSources').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async saveCoverSource(record) {
    const tx = this.db.transaction(['coverSources'], 'readwrite');
    return new Promise((resolve, reject) => {
      tx.objectStore('coverSources').put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveStateKey(key, value) {
    const tx = this.db.transaction(['appState'], 'readwrite');

    return new Promise(resolve => {
      tx.objectStore('appState').put({ key, value });
      tx.oncomplete = () => resolve();
    });
  }

  async savePlaybackState(trackId, position) {
    const tx = this.db.transaction(['appState'], 'readwrite');
    const store = tx.objectStore('appState');
    store.put({ key: 'lastTrackId', value: trackId });
    store.put({ key: 'lastPlaybackPosition', value: position });

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Playback state save aborted'));
    });
  }

  async getStateKey(key) {
    const tx = this.db.transaction(['appState'], 'readonly');

    return new Promise(resolve => {
      const req = tx.objectStore('appState').get(key);

      req.onsuccess = () => {
        resolve(
          req.result !== undefined
            ? req.result.value
            : null
        );
      };
    });
  }

  async getAllState() {
    const tx = this.db.transaction(['appState'], 'readonly');

    return new Promise((resolve) => {
      const req = tx.objectStore('appState').getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  }

  async clearAll() {
    const stores = ['tracks', 'playlists', 'appState', 'coverSources'];

    for (const store of stores) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction([store], 'readwrite');

        tx.objectStore(store).clear();

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error(`Failed to clear ${store}`));
        tx.onabort = () => reject(tx.error || new Error(`Clearing ${store} was aborted`));
      });
    }
  }
}
