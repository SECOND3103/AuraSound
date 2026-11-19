const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');

function loadApp(overrides = {}) {
  const frames = new Map();
  const timers = new Map();
  const local = new Map();
  let nextId = 1;
  let now = 1000;
  const document = {
    visibilityState: 'visible',
    documentElement: { setAttribute() {} },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    ...overrides.document
  };
  const window = {
    addEventListener() {},
    setInterval(callback) { const id = nextId++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }
  };
  const context = vm.createContext({
    window, document, console,
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) },
    performance: { now: () => now },
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; },
    clearInterval: window.clearInterval,
    setTimeout, clearTimeout,
    ...overrides.globals
  });
  for (const [path, name] of [
    ['www/js/storage.js', 'StorageManager'],
    ['www/js/audio-player.js', 'AudioPlayer'],
    ['www/js/native-storage.js', 'NativeMusicStorage']
  ]) {
    vm.runInContext(read(path).replace('export class ', 'class ') + `\nglobalThis.${name} = ${name};`, context);
  }
  vm.runInContext(read('www/js/utils.js').replace(/export function /g, 'function '), context);
  const source = overrides.source || read('www/js/app.js');
  vm.runInContext(source.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];$/gm, '') + '\nglobalThis.App = App;', context);
  const app = new context.App();
  window.app = app;
  return {
    app, context, window, document, frames, timers, local,
    advance(ms) { now += ms; },
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); }
  };
}

test('playlist lookup preserves order, duplicates, missing IDs and refreshed metadata', () => {
  const { app } = loadApp();
  const first = { id: 'a', title: 'first' };
  const second = { id: 'b', title: 'second' };
  app.state.tracks = [first, second, { id: 'a', title: 'duplicate' }];
  const playlist = { trackIds: ['b', 'missing', 'a', 'b'] };
  assert.deepEqual(app.getTracksForPlaylist(playlist), [second, first, second]);
  app.state.tracks.push({ id: 'c' });
  assert.equal(app.getTrackById('c').id, 'c');
  app.state.tracks = [{ id: 'a', title: 'updated' }];
  assert.equal(app.getTrackById('a').title, 'updated');
  assert.equal(app.getTrackById('b'), undefined);
  app.state.tracks = [];
  assert.equal(app.getTrackById('a'), undefined);
});

test('home playback indicator follows the active collection when a queued song has a different artist', () => {
  function artistCard(name) {
    const classes = new Set();
    return {
      classes,
      dataset: { homeContextType: 'artist', homeContextId: `artist:${name}` },
      classList: { toggle(key, enabled) { if (enabled) classes.add(key); else classes.delete(key); } },
      setAttribute() {},
      removeAttribute() {}
    };
  }

  const source = artistCard('Source');
  const queued = artistCard('Guest');
  const { app } = loadApp({ document: { querySelectorAll: () => [source, queued] } });
  app.state.tracks = [{ id: 'track', artist: 'Guest' }];
  app.state.currentTrackId = 'track';
  app.state.playbackContext = { type: 'artist', id: 'artist:Source', name: 'Source' };
  app.state.isPlaying = true;
  app.updateHomeNowPlayingIndicators();
  assert.deepEqual([...source.classes], ['is-context-active', 'is-now-playing']);
  assert.equal(queued.classes.size, 0);

  app.state.isPlaying = false;
  app.updateHomeNowPlayingIndicators();
  assert.deepEqual([...source.classes], ['is-context-active']);

  app.state.playbackContext = { type: 'artist', name: 'Guest' };
  app.updateHomeNowPlayingIndicators();
  assert.equal(source.classes.size, 0);
  assert.deepEqual([...queued.classes], ['is-context-active']);
});

test('startup restores false/zero settings, queue order and the latest native position', async () => {
  const volumeInput = {};
  const { app, window } = loadApp({ document: { getElementById: () => volumeInput } });
  const track = { id: 'a', filePath: 'Music/a.mp3', title: 'A', duration: 60 };
  const queue = [{ id: 'b' }, track];
  let stateReads = 0;
  app.storage = {
    async init() {},
    async getAllTracks() { return [track]; },
    async getAllPlaylists() { return []; },
    async getAllState() {
      stateReads++;
      return Object.entries({ volume: 0, isShuffle: false, repeatMode: 'one', viewMode: 'grid',
        activeSort: 'title_asc', lastTrackId: 'a', lastPlaybackPosition: 12,
        queue, queueIndex: 1, sourcePlaylist: { type: 'artist', id: 'artist:Artist', name: 'Artist' }
      }).map(([key, value]) => ({ key, value }));
    },
    getStateKey() { throw new Error('unexpected individual settings read'); }
  };
  for (const method of ['initCoverIconSizing', 'migrateTrackData', 'migratePlaylistData',
    'migrateTracksToNativeStorage', 'ensureTrackDurations', 'setTheme', 'applyViewModeUI',
    'initializeDynamicUI', 'bindEvents', 'setupMarqueeObserver', 'setupSwipeDismissals',
    'renderAll', 'updateSettingsUI', 'updatePlayerUI', 'updateMediaSession']) app[method] = () => {};
  const messages = [];
  app.sendNativeMessage = (type, payload) => messages.push({ type, payload });
  window.AuraSoundNative = { getSavedPlaybackState: () => JSON.stringify({ trackId: 'a', position: 15.3 }) };
  await app.init();
  assert.equal(stateReads, 1);
  assert.equal(volumeInput.value, 0);
  assert.equal(app.state.isShuffle, false);
  assert.equal(app.state.repeatMode, 'one');
  assert.equal(app.state.activeViewMode, 'grid');
  assert.equal(app.state.activeSort, 'title_asc');
  assert.equal(app.state.currentPlaybackPosition, 15.3);
  assert.equal(app.player.getCurrentTime(), 15.3);
  const nativeQueue = messages.find(message => message.type === 'queue').payload;
  assert.deepEqual(Array.from(nativeQueue.items, item => item.trackId), ['b', 'a']);
  assert.equal(nativeQueue.index, 1);
});

test('large playlists index the library once and reuse the index', t => {
  const { app } = loadApp();
  let reads = 0;
  const tracks = Array.from({ length: 10000 }, (_, i) => ({ id: String(i) }));
  app.state.tracks = new Proxy(tracks, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key);
    }
  });
  const playlist = { trackIds: Array.from({ length: 5000 }, (_, i) => String(i * 2)) };
  const result = app.getTracksForPlaylist(playlist);
  assert.equal(result.length, 5000);
  assert.equal(reads, 10000);
  app.getTracksForPlaylist(playlist);
  assert.equal(reads, 10000);
  t.diagnostic('10,000 tracks / 5,000 playlist entries: 10,000 initial indexed reads; no further library scan');
});

test('all library categories preserve sorted contents and search results', () => {
  function render(filter, sort, query) {
    const container = {
      children: [],
      set innerHTML(value) { this.children = []; this.html = value; },
      classList: { add() {}, remove() {} },
      appendChild(row) { this.children.push(row); }
    };
    const { app } = loadApp({ document: { getElementById: id => id === 'library-list' ? container : {} } });
    app.createTrackRow = track => ({ id: track.id, title: track.title });
    app.createCollectionRow = ({ title, coverData, secondaryText }) => ({ title, coverData, secondaryText });
    app.state.tracks = [
      { id: '1', title: 'Z', artist: '나', album: 'B', addedAt: 3, lastPlayedAt: 9, duration: 12 },
      { id: '2', title: 'A', artist: '가', album: 'A', addedAt: 1, lastPlayedAt: 4, duration: 20 },
      { id: '3', title: 'B', artist: '나', album: 'B', addedAt: 2, lastPlayedAt: 3, duration: 35 }
    ];
    app.state.playlists = [
      { id: 'p1', name: '첫 번째', trackIds: ['3', '1', 'missing'], createdAt: 2 },
      { id: 'p2', name: '두 번째', trackIds: ['2'], createdAt: 5 }
    ];
    app.state.activeFilter = filter;
    app.state.activeSort = app.state.librarySortMode = sort;
    app.renderLibrary(query);
    return container.children.map(row => row.id || row.title);
  }
  const expected = {
    tracks: { title_asc: ['2', '3', '1'], recent_desc: ['1', '2', '3'], addedAt_desc: ['1', '3', '2'] },
    albums: { title_asc: ['A', 'B'], recent_desc: ['B', 'A'], addedAt_desc: ['B', 'A'] },
    artists: { title_asc: ['가', '나'], recent_desc: ['나', '가'], addedAt_desc: ['나', '가'] },
    playlists: { title_asc: ['두 번째', '첫 번째'], recent_desc: ['첫 번째', '두 번째'], addedAt_desc: ['두 번째', '첫 번째'] }
  };
  for (const filter of ['all', 'tracks', 'albums', 'artists', 'playlists']) {
    for (const sort of ['title_asc', 'recent_desc', 'addedAt_desc']) {
      for (const query of ['', 'A', '없는 항목']) {
        let result;
        if (query === '없는 항목') result = [];
        else if (query === 'A') result = filter === 'albums' ? ['A'] : ['all', 'tracks'].includes(filter) ? ['2'] : [];
        else result = filter === 'all' ? [...expected.playlists[sort], ...expected.tracks[sort]] : expected[filter][sort];
        assert.deepEqual(render(filter, sort, query), result, `${filter}/${sort}/${query}`);
      }
    }
  }
});

test('a newly loaded paused track still notifies UI even when the prior track was playing', async () => {
  const { app, window } = loadApp();
  const states = [], metadata = [];
  app.player.on('playstate', value => states.push(value));
  app.player.on('loadedmetadata', value => metadata.push(value));
  app.state.currentTrackId = 'a';
  window.__auraSoundNativePlaybackState(true, 0, 60000, 1, 'a');
  app.state.currentTrackId = 'b';
  await app.player.loadTrack({ id: 'b', filePath: 'Music/b.mp3', duration: 60 }, 0, { skipNativeLoad: true });
  window.__auraSoundNativePlaybackState(false, 0, 60000, 1, 'b');
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(metadata, [60, 60]);
});

test('native playback reports keep time accurate without repeating state notifications', async () => {
  const { app, window, advance } = loadApp();
  const states = [], metadata = [], times = [];
  app.state.currentTrackId = 'a';
  app.player.on('playstate', value => states.push(value));
  app.player.on('loadedmetadata', value => metadata.push(value));
  app.player.on('timeupdate', value => times.push(value.currentTime));
  window.__auraSoundNativePlaybackState(true, 1000, 60000, 1, 'a');
  advance(250);
  window.__auraSoundNativePlaybackState(true, 1250, 60000, 1, 'a');
  assert.deepEqual(states, [true]);
  assert.deepEqual(metadata, [60]);
  assert.deepEqual(times, [1, 1.25]);
  advance(200);
  assert.equal(app.player.getCurrentTime(), 1.45);
  window.__auraSoundNativePlaybackState(false, 1450, 60000, 1, 'a');
  advance(3000);
  assert.equal(app.player.getCurrentTime(), 1.45);
  window.__auraSoundNativePlaybackState(false, 1450, 60000, 1, 'a');
  assert.deepEqual(states, [true, false]);
  window.__auraSoundNativePlaybackState(true, 2000, 90000, 1, 'old-track');
  assert.equal(app.player.getCurrentTime(), 1.45);
  assert.deepEqual(metadata, [60]);
  await app.player.play();
  window.__auraSoundNativePlaybackState(true, 1450, 60000, 1, 'a');
  assert.deepEqual(states, [true, false, true]);
});

test('an unknown native duration preserves the loaded track length while position advances', async () => {
  const { app, window, advance } = loadApp();
  app.state.currentTrackId = 'b';
  await app.player.loadTrack({ id: 'b', filePath: 'Music/b', duration: 60 }, 0, { skipNativeLoad: true });
  window.__auraSoundNativePlaybackState(true, 1250, 0, 1, 'b');
  advance(250);
  assert.equal(app.player.audio.currentTime, 1.5);
  assert.equal(app.player.audio.duration, 60);
  window.__auraSoundNativePlaybackState(true, 1500, 62000, 1, 'b');
  assert.equal(app.player.audio.duration, 62);
});

test('hidden UI stops its timer while native time continues and resumes correctly', () => {
  const { app, window, document, advance, timers } = loadApp();
  app.state.currentTrackId = 'a';
  window.__auraSoundNativePlaybackState(true, 1000, 60000, 1, 'a');
  assert.equal(timers.size, 1);
  document.visibilityState = 'hidden';
  app.player.setVisible(false);
  assert.equal(timers.size, 0);
  advance(2000);
  window.__auraSoundNativePlaybackState(true, 3000, 60000, 1, 'a');
  assert.equal(timers.size, 0);
  advance(1000);
  document.visibilityState = 'visible';
  app.player.setVisible(true);
  assert.equal(timers.size, 1);
  assert.equal(app.player.getCurrentTime(), 4);
  app.player.pause();
  assert.equal(timers.size, 0);
});

test('native duration reads metadata without copying music into the WebView', async () => {
  const { app, context, window } = loadApp();
  let reads = 0;
  const fallback = new Error('legacy blob fallback');
  context.NativeMusicStorage.readAsBlob = async () => { reads++; throw fallback; };
  window.AuraSoundNative = { beginImport() {}, getMusicDuration: () => 123.456 };
  assert.equal(await app.resolveTrackDuration({ filePath: 'Music/a.mp3' }), 123.456);
  assert.equal(reads, 0);
  window.AuraSoundNative.getMusicDuration = () => Infinity;
  await assert.rejects(app.resolveTrackDuration({ filePath: 'Music/a.mp3' }), fallback);
  delete window.AuraSoundNative.getMusicDuration;
  await assert.rejects(app.resolveTrackDuration({ filePath: 'Music/a.mp3' }), fallback);
  window.AuraSoundNative.getMusicDuration = () => { throw new Error('unsupported file'); };
  await assert.rejects(app.resolveTrackDuration({ filePath: 'Music/a.mp3' }), fallback);
  assert.equal(reads, 3);
});

test('file info releases its audio context on successful and failed decoding', async () => {
  for (const fail of [false, true]) {
    let closed = 0;
    class AudioContext {
      async decodeAudioData() {
        if (fail) throw new Error('unsupported audio');
        return { sampleRate: 48000, numberOfChannels: 2 };
      }
      async close() { closed++; }
    }
    const { app, context, window } = loadApp({
      globals: { AudioContext }, document: { getElementById: () => ({ style: {} }) }
    });
    window.AudioContext = AudioContext;
    context.NativeMusicStorage.readAsBlob = async () => ({ size: 32000, arrayBuffer: async () => new ArrayBuffer(1) });
    let body;
    app.showModal = (_, value) => { body = value; };
    await app.openFileInfo({ filePath: 'Music/a.mp3', fileSize: 32000, duration: 2 });
    assert.equal(closed, 1);
    assert.match(body, /128 kbps/);
    if (!fail) assert.match(body, /2ch/);
  }
});

test('marquee requests coalesce and measure all widths before writing styles', () => {
  const events = [];
  function viewport(width, scrollWidth) {
    const properties = new Map();
    const classes = new Set();
    const content = {
      get offsetWidth() { events.push('read'); return scrollWidth; },
      children: [], dataset: {}, textContent: 'Track title',
      classList: {
        add(value) { events.push('write'); classes.add(value); },
        remove(value) { events.push('write'); classes.delete(value); }
      },
      style: {
        getPropertyValue: key => properties.get(key),
        setProperty(key, value) { events.push('write'); properties.set(key, value); },
        removeProperty(key) { events.push('write'); properties.delete(key); }
      }
    };
    return { get clientWidth() { events.push('read'); return width; }, querySelector: () => content, content, classes };
  }
  const wide = viewport(100, 180), short = viewport(100, 80);
  const { app, frames, flushFrames } = loadApp({ document: { querySelectorAll: () => [wide, short] } });
  app.safeApplyMarquee(); app.safeApplyMarquee(); app.safeApplyMarquee();
  assert.equal(frames.size, 1);
  flushFrames();
  assert.ok(events.lastIndexOf('read') < events.indexOf('write'));
  assert.equal(wide.content.style.getPropertyValue('--scroll-dist'), '-212px');
  assert.equal(wide.content.dataset.marqueeText, 'Track title');
  assert.equal(short.content.dataset.marqueeText, undefined);
  assert.ok(wide.classes.has('marquee-anim'));
  assert.ok(!short.classes.has('marquee-anim'));
  events.length = 0;
  app.safeApplyMarquee(); flushFrames();
  assert.ok(wide.classes.has('marquee-anim'));
  assert.equal(wide.content.style.getPropertyValue('--scroll-dist'), '-212px');
});

function controlledStorage() {
  const { app } = loadApp();
  const transactions = [];
  app.storage.db = {
    transaction(stores, mode) {
      const tx = {
        stores: [...stores], mode, operations: [],
        abort() { queueMicrotask(() => this.onabort()); },
        objectStore(name) {
          const operation = (type, value) => {
            const request = {};
            tx.operations.push({ name, type, value, request });
            return request;
          };
          return {
            put: value => operation('put', value),
            get: value => operation('get', value),
            getAll: () => operation('getAll'),
            delete: value => operation('delete', value),
            clear: () => operation('clear')
          };
        }
      };
      transactions.push(tx);
      return tx;
    }
  };
  return { storage: app.storage, transactions };
}

test('bulk metadata writes omit blobs and settle only after transaction commit', async () => {
  const { storage, transactions } = controlledStorage();
  let completed = false;
  const promise = storage.saveTracks([{ id: 'a', fileBlob: 'large bytes' }, { id: 'b', title: 'B' }])
    .then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].operations.length, 2);
  assert.equal('fileBlob' in transactions[0].operations[0].value, false);
  transactions[0].oncomplete();
  await promise;
  assert.equal(completed, true);
});

test('read errors and aborted writes reject instead of leaving callers waiting', async () => {
  const { storage, transactions } = controlledStorage();
  const readPromise = storage.getAllTracks();
  const failure = new Error('Quota or I/O failure');
  const rejectedRead = assert.rejects(readPromise, failure);
  transactions[0].error = failure;
  transactions[0].onerror({ target: { error: failure } });
  await rejectedRead;
  const writePromise = storage.savePlaylist({ id: 'p' });
  const rejectedWrite = assert.rejects(writePromise, /aborted/);
  transactions[1].onabort();
  await rejectedWrite;
});

test('state entries and reset each use one transaction across the required stores', async () => {
  const { storage, transactions } = controlledStorage();
  const state = storage.saveStateEntries([
    { key: 'lastTrackId', value: 'a' }, { key: 'lastPlaybackPosition', value: 15.3 },
    { key: 'queue', value: [{ id: 'a' }] }, { key: 'queueIndex', value: 0 }
  ]);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].operations.length, 4);
  transactions[0].oncomplete(); await state;
  const reset = storage.clearAll();
  assert.deepEqual(transactions[1].stores, ['tracks', 'playlists', 'appState', 'coverSources']);
  assert.equal(transactions[1].operations.length, 4);
  transactions[1].oncomplete(); await reset;
});
