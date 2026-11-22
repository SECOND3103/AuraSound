export class BackupProgress {
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

  showImportSummary(results, addedTracks, addedPlaylists, warnings = []) {
    const panel = this.ensureImportProgressUI();
    const summary = `완료: 음악 ${addedTracks}곡, 플레이리스트 ${addedPlaylists}개 추가`;
    panel.querySelector('#aura-import-message').textContent = [summary, ...warnings].join(' ');
    panel.querySelector('#aura-import-progress-fill').style.width = '100%';
    panel.querySelector('#aura-import-percent').textContent = '100%';
    const counts = { success: 0, failed: 0, skipped: 0 };
    const list = panel.querySelector('#aura-import-results');
    const rows = document.createDocumentFragment();
    if (!results.length) {
      const empty = document.createElement('p');
      empty.textContent = '곡별 결과가 없습니다.';
      rows.appendChild(empty);
    } else {
      results.forEach(item => {
        if (Object.hasOwn(counts, item.status)) counts[item.status]++;
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
        rows.appendChild(row);
      });
    }
    list.replaceChildren(rows);
    panel.querySelector('#aura-import-count').textContent = `성공 ${counts.success} · 실패 ${counts.failed} · 건너뜀 ${counts.skipped}`;
    panel.querySelector('#aura-import-close').hidden = false;
  }
}
