const CHUNK_SIZE = 256 * 1024;

function getNativeBridge() {
  return window.AuraSoundNative || null;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class NativeMusicStorage {
  static isAvailable() {
    const bridge = getNativeBridge();
    return !!bridge && typeof bridge.beginImport === 'function';
  }

  static async importFile(file, trackId) {
    const bridge = getNativeBridge();
    if (!bridge) throw new Error('AuraSound native storage is unavailable.');

    const relativePath = bridge.beginImport(
      trackId,
      file.name,
      file.type || 'audio/*'
    );

    if (!relativePath) throw new Error('AuraSound 음악 폴더를 만들 수 없습니다.');

    try {
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        if (!bridge.appendImport(bytesToBase64(new Uint8Array(buffer)))) {
          throw new Error('음악 파일 복사에 실패했습니다.');
        }
      }

      if (!bridge.finishImport()) throw new Error('음악 파일 저장을 완료하지 못했습니다.');
      return relativePath;
    } catch (error) {
      try { bridge.cancelImport(); } catch (_) {}
      throw error;
    }
  }

  static deleteFile(relativePath) {
    const bridge = getNativeBridge();
    if (!bridge || !relativePath) return null;
    const result = bridge.deleteMusicFile(relativePath);
    return result === false ? false : true;
  }

  static clearFiles() {
    const bridge = getNativeBridge();
    if (bridge && typeof bridge.clearMusicFiles === 'function') bridge.clearMusicFiles();
  }

  static async readAsBlob(relativePath, mimeType = 'audio/*') {
    const bridge = getNativeBridge();
    if (!bridge || !relativePath) return null;

    const size = Number(bridge.getMusicFileSize(relativePath));
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('음악 파일을 찾을 수 없습니다.');
    }

    const chunks = [];
    const readSize = CHUNK_SIZE;

    for (let offset = 0; offset < size; offset += readSize) {
      const base64 = bridge.readMusicFileChunk(
        relativePath,
        offset,
        Math.min(readSize, size - offset)
      );

      if (!base64) throw new Error('음악 파일을 읽을 수 없습니다.');
      chunks.push(base64ToBytes(base64));
    }

    return new Blob(chunks, { type: mimeType || 'audio/*' });
  }
}
