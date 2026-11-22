// Shared utilities

export function formatBytes(bytes) {
  if (!bytes) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = (bytes / Math.pow(1024, index)).toFixed(index ? 2 : 0);
  return `${value} ${units[index]}`;
}

export function escapeHtml(str) {
  if (!str) return '';

  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatTotalTime(tracks, { includeSeconds = false } = {}) {
  const totalSec = tracks.reduce((total, track) => total + (track.duration || 0), 0);
  if (totalSec === 0) return '0분 0초';

  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = Math.floor(totalSec % 60);

  if (hours > 0) return `${hours}시간 ${minutes}분${includeSeconds ? ` ${seconds}초` : ''}`;
  return `${minutes}분 ${seconds}초`;
}

export function formatTime(secs) {
  const minutes = Math.floor(secs / 60);
  const seconds = Math.floor(secs % 60);
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

export function getTrackFolderName(track) {
  return track.folderName || '추가된 음악';
}

export function buildTrackSearchText(track) {
  return [track.title, track.artist, track.album, track.albumArtist]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
