'use strict';
const API = '/api/admin';
const listView = document.getElementById('list-view');
const detailView = document.getElementById('detail-view');
const mediaGrid = document.getElementById('media-grid');
const statsEl = document.getElementById('stats');
const searchInput = document.getElementById('search');
const backBtn = document.getElementById('back-btn');
const detailContent = document.getElementById('detail-content');
const toast = document.getElementById('toast');

let searchTimer = null;

function showToast(msg, isError) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toast.classList.toggle('error', !!isError);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3500);
}

async function api(path, opts) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function artFor(media, type) {
  return media.art.find((a) => a.artType === type);
}

function cardHtml(media) {
  const poster = artFor(media, 'poster');
  const title = media.title || `${media.type} (unresolved)`;
  const ids = [media.tmdbId && `tmdb:${media.tmdbId}`, media.imdbId && media.imdbId, media.tvdbId && `tvdb:${media.tvdbId}`]
    .filter(Boolean)
    .join(' · ');
  const badges = ['poster', 'backdrop', 'logo']
    .map((t) => {
      const a = artFor(media, t);
      if (!a) return `<span class="badge">${t}</span>`;
      return `<span class="badge ${a.isOverride ? 'override' : 'ok'}">${t}: ${a.source}</span>`;
    })
    .join('');
  return `
    <div class="card" data-id="${media.id}">
      <div class="poster-wrap">
        ${poster ? `<img loading="lazy" src="${poster.url}" alt="">` : `<div class="placeholder">No poster yet</div>`}
      </div>
      <div class="meta">
        <div class="title">${escapeHtml(title)}${media.year ? ` (${media.year})` : ''}</div>
        <div class="sub">${escapeHtml(ids)}</div>
        <div class="badges">${badges}</div>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadList(query) {
  const [stats, data] = await Promise.all([api('/stats'), api(`/media${query ? `?query=${encodeURIComponent(query)}` : ''}`)]);
  statsEl.textContent = `${stats.mediaCount} item(s) tracked${stats.backgroundJobsPending ? ` · ${stats.backgroundJobsPending} background job(s) running` : ''}`;
  if (!data.items.length) {
    mediaGrid.innerHTML = `<div class="empty-state">Nothing requested yet. Once Stremio starts asking for artwork, items will show up here.</div>`;
    return;
  }
  mediaGrid.innerHTML = data.items.map(cardHtml).join('');
  mediaGrid.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('click', () => openDetail(Number(el.dataset.id)));
  });
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadList(searchInput.value.trim()), 250);
});

backBtn.addEventListener('click', () => {
  detailView.classList.add('hidden');
  listView.classList.remove('hidden');
  loadList(searchInput.value.trim());
});

function tpdbStatusHtml(media, artType, currentArt) {
  if (artType !== 'poster' || !media.tpdbStatus) return '';
  if (currentArt && currentArt.source === 'theposterdb') return ''; // TPDB already won, nothing to explain
  const s = media.tpdbStatus;
  let line;
  if (s.hasError) line = `ThePosterDB: temporary error, will retry automatically (${escapeHtml(s.reason || 'unknown error')})`;
  else if (s.notFound) line = `ThePosterDB: no qualifying (English/Original/Show Cover) poster found - ${escapeHtml(s.reason || '')}`;
  else return '';
  return `<div class="tpdb-status" style="margin-top:10px;font-size:12px;color:#9aa2b1;">${line} <span style="opacity:.7;">(checked ${new Date(s.checkedAt).toLocaleString()})</span></div>`;
}

function artSectionHtml(media, artType) {
  const a = artFor(media, artType);
  const thumbClass = artType;
  return `
    <div class="art-type-section" data-art-type="${artType}">
      <h3>
        ${capitalize(artType)}
        <button class="btn" data-action="rerun">Re-run chain</button>
        ${a && a.isOverride ? `<button class="btn danger" data-action="clear-override">Remove override</button>` : ''}
        <button class="btn" data-action="browse">Browse all options</button>
      </h3>
      <div class="current-row">
        <div class="current-thumb ${thumbClass}">
          ${a ? `<img src="${a.url}?t=${Date.now()}" alt="">` : `<div class="placeholder" style="padding:20px;color:#9aa2b1;font-size:12px;">No ${artType} yet</div>`}
        </div>
        <div class="current-meta">
          ${a ? `
            <div><span class="label">Source:</span> ${a.source}${a.isOverride ? ' (manual override)' : ''}</div>
            <div><span class="label">Why:</span> ${escapeHtml(a.reason || '—')}</div>
            <div><span class="label">Language:</span> ${a.language || '—'}</div>
            <div><span class="label">Cached:</span> ${a.cacheForever ? 'forever' : a.expiresAt ? `until ${new Date(a.expiresAt).toLocaleString()}` : '—'}</div>
            <div><span class="label">Fetched:</span> ${new Date(a.fetchedAt).toLocaleString()}</div>
          ` : `<div>Not resolved yet - it will be fetched the first time Stremio requests it, or click "Browse all options" to pick one now.</div>`}
          ${tpdbStatusHtml(media, artType, a)}
        </div>
      </div>
      <div class="options-grid hidden"></div>

    </div>`;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

async function openDetail(id) {
  const media = await api(`/media/${id}`);
  renderDetail(media);
  listView.classList.add('hidden');
  detailView.classList.remove('hidden');
}

function renderDetail(media) {
  const ids = [
    media.tmdbId && `<code>tmdb:${media.tmdbId}</code>`,
    media.imdbId && `<code>${media.imdbId}</code>`,
    media.tvdbId && `<code>tvdb:${media.tvdbId}</code>`,
  ].filter(Boolean).join(' ');
  const poster = artFor(media, 'poster');

  detailContent.innerHTML = `
    <div class="detail-header">
      <div class="big-poster">${poster ? `<img src="${poster.url}" alt="">` : ''}</div>
      <div class="info">
        <h2>${escapeHtml(media.title || '(untitled)')} ${media.year ? `(${media.year})` : ''}</h2>
        <div class="ids">${media.type} &middot; ${ids} ${media.originalLanguage ? `&middot; original language: ${media.originalLanguage}` : ''}</div>
      </div>
    </div>
    ${artSectionHtml(media, 'poster')}
    ${artSectionHtml(media, 'backdrop')}
    ${artSectionHtml(media, 'logo')}
  `;

  detailContent.querySelectorAll('.art-type-section').forEach((section) => {
    const artType = section.dataset.artType;
    section.querySelector('[data-action="rerun"]').addEventListener('click', () => rerun(media.id, artType));
    const clearBtn = section.querySelector('[data-action="clear-override"]');
    if (clearBtn) clearBtn.addEventListener('click', () => clearOverride(media.id, artType));
    section.querySelector('[data-action="browse"]').addEventListener('click', () => browse(media, artType, section));
  });
}

async function rerun(mediaId, artType) {
  showToast(`Re-running ${artType} chain...`);
  try {
    await api(`/media/${mediaId}/reresolve`, { method: 'POST', body: JSON.stringify({ artType }) });
    const media = await api(`/media/${mediaId}`);
    renderDetail(media);
    showToast(`${capitalize(artType)} updated.`);
  } catch (e) {
    showToast(e.message, true);
  }
}

async function clearOverride(mediaId, artType) {
  if (!confirm(`Remove the manual ${artType} override? It'll be auto-resolved again on next request.`)) return;
  await api(`/media/${mediaId}/art/${artType}`, { method: 'DELETE' });
  const media = await api(`/media/${mediaId}`);
  renderDetail(media);
}

async function browse(media, artType, section) {
  const grid = section.querySelector('.options-grid');
  grid.classList.remove('hidden');
  grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;padding:16px;">Loading options from all providers...</div>`;
  try {
    const data = await api(`/media/${media.id}/browse`);
    const bucket = data[artType] || { primary: [], more: [] };
    renderOptionBucket(grid, media.id, artType, bucket);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">Failed to load options: ${escapeHtml(e.message)}</div>`;
  }
}

function renderOptionCards(container, mediaId, artType, options) {
  container.innerHTML = options
    .map(
      (o, i) => `
      <div class="option-card ${artType}" data-idx="${i}">
        <img loading="lazy" src="${o.imageUrl}" alt="">
        <div class="opt-meta">${o.source}${o.label ? ` · ${o.label}` : ''}</div>
      </div>`
    )
    .join('');
  container.querySelectorAll('.option-card').forEach((el) => {
    const opt = options[Number(el.dataset.idx)];
    el.addEventListener('click', () => applyOverride(mediaId, artType, opt));
  });
}

function renderOptionBucket(grid, mediaId, artType, bucket) {
  grid.innerHTML = '';
  if (!bucket.primary.length && !bucket.more.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">No candidates found from any provider.</div>`;
    return;
  }
  const primaryWrap = document.createElement('div');
  primaryWrap.className = 'options-grid';
  primaryWrap.style.marginTop = '0';
  grid.appendChild(primaryWrap);
  if (bucket.primary.length) {
    renderOptionCards(primaryWrap, mediaId, artType, bucket.primary);
  } else {
    primaryWrap.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">Nothing matches the chain's own criteria (e.g. English/textless) - try "show more options".</div>`;
  }
  if (bucket.more.length) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'btn';
    moreBtn.style.marginTop = '10px';
    moreBtn.textContent = `Show ${bucket.more.length} more option(s) (other languages / not chain-matching)`;
    const moreWrap = document.createElement('div');
    moreWrap.className = 'options-grid hidden';
    moreBtn.addEventListener('click', () => {
      moreWrap.classList.toggle('hidden');
      moreBtn.classList.toggle('hidden');
      if (!moreWrap.dataset.rendered) {
        renderOptionCards(moreWrap, mediaId, artType, bucket.more);
        moreWrap.dataset.rendered = '1';
      }
    });
    grid.appendChild(moreBtn);
    grid.appendChild(moreWrap);
  }
}

async function applyOverride(mediaId, artType, opt) {
  showToast('Applying selection...');
  try {
    await api(`/media/${mediaId}/override`, {
      method: 'POST',
      body: JSON.stringify({ artType, source: opt.source, imageUrl: opt.imageUrl }),
    });
    const media = await api(`/media/${mediaId}`);
    renderDetail(media);
    showToast(`${capitalize(artType)} updated from ${opt.source}.`);
  } catch (e) {
    showToast(e.message, true);
  }
}

loadList('');
