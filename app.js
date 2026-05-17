'use strict';

// ── Data model ─────────────────────────────────────────────────────────────────
// Old format:  collection[cardKey] = count  (integer)
// New format:  collection[cardKey] = [ { edition, language, quality }, ... ]

let collection   = {};
let currentSet   = null;
let currentCards = [];
let allSets      = {};
let toastTimer   = null;
let focusIndex   = 0;
let currentView  = 'grid';

const pendingDefaults = { edition: 'regular', language: 'en', quality: 'high' };

const picker         = document.getElementById('set-picker');
const mobilePicker   = document.getElementById('mobile-set-picker');
const emptyPicker    = document.getElementById('empty-set-picker');
const emptyPickerWrap= document.getElementById('empty-picker-wrap');
const progressBar    = document.getElementById('progress-bar');
const setBanner      = document.getElementById('set-banner');
const bannerTitle    = document.getElementById('banner-title');
const bannerCount    = document.getElementById('banner-count');
const bannerPct      = document.getElementById('banner-pct');
const emptyEl        = document.getElementById('empty');
const emptyHint      = document.getElementById('empty-hint');
const emptyTitle     = document.getElementById('empty-title');
const loading        = document.getElementById('loading');
const gridWrap       = document.getElementById('grid-wrap');
const cardGrid       = document.getElementById('card-grid');
const pillCollected  = document.getElementById('pill-collected');
const pillOwned      = document.getElementById('pill-owned');
const pillTotal      = document.getElementById('pill-total');
const toast          = document.getElementById('toast');
const mobileStatWrap = document.getElementById('mobile-stat');
const mobilePctEl    = document.getElementById('mobile-pct');
const focusOverlay   = document.getElementById('focus-overlay');
const focusImg       = document.getElementById('focus-img');
const focusName      = document.getElementById('focus-name');
const focusNum       = document.getElementById('focus-num');
const focusCounter   = document.getElementById('focus-counter');
const focusBadge     = document.getElementById('focus-badge');
const focusBtnMinus  = document.getElementById('focus-btn-minus');
const focusBtnPlus   = document.getElementById('focus-btn-plus');
const focusBtnPrev   = document.getElementById('focus-btn-prev');
const focusBtnNext   = document.getElementById('focus-btn-next');
const focusBtnClose  = document.getElementById('focus-btn-close');
const focusProgress  = document.getElementById('focus-progress');
const focusHint      = document.getElementById('focus-hint');
const btnExport      = document.getElementById('btn-export');
const btnImport      = document.getElementById('btn-import');
const importFile     = document.getElementById('import-file');

const isMobile = () => window.matchMedia('(max-width: 640px)').matches;

const EDITION_LABELS  = { regular: 'Regular', '1st': '1st Ed.', '2nd': '2nd Ed.' };
const LANGUAGE_LABELS = { en: '🇬🇧 English', nl: '🇳🇱 Dutch', ja: '🇯🇵 Japanese', ko: '🇰🇷 Korean' };
const LANGUAGE_SHORT  = { en: '🇬🇧 EN', nl: '🇳🇱 NL', ja: '🇯🇵 JA', ko: '🇰🇷 KO' };
const QUALITY_LABELS  = { high: 'High', mid: 'Mid', low: 'Low' };
const QUALITY_COLORS  = { high: 'var(--green)', mid: 'var(--gold)', low: 'var(--red)' };
const QUALITY_STARS   = { high: '★★★', mid: '★★☆', low: '★☆☆' };

// ── Migration ─────────────────────────────────────────────────────────────────
function migrateCollection(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      out[k] = v.map(entry => ({
        edition:  entry.edition  || 'regular',
        language: entry.language || 'en',
        quality:  entry.quality  || 'high',
      }));
    } else if (typeof v === 'number' && v > 0) {
      out[k] = Array.from({ length: v }, () => ({ edition: 'regular', language: 'en', quality: 'high' }));
    }
  }
  return out;
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadCollection() {
  try { return migrateCollection(JSON.parse(localStorage.getItem('pokedex_collection') || '{}')); }
  catch { return {}; }
}
function saveCollection() {
  try { localStorage.setItem('pokedex_collection', JSON.stringify(collection)); }
  catch(e) { console.warn('localStorage save failed:', e); }
  if (window.GDrive) window.GDrive.save(collection);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatSetName(s) { return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function cardKey(card)    { return `${currentSet}/${card.filename}`; }
function formatNum(n) {
  const s = String(n), m = s.match(/^([A-Za-z]*)(\d+)$/);
  return m ? `#${m[1]}${m[2].padStart(3,'0')}` : `#${s}`;
}
function cardCount(key) { return (collection[key] || []).length; }

// ── Attr selector widget ──────────────────────────────────────────────────────
function buildAttrSelector(pendingState, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'attr-selector';

  const rows = [
    { label: 'Edition',  key: 'edition',  options: [
      { value: 'regular', label: 'Regular' },
      { value: '1st',     label: '1st Ed.' },
      { value: '2nd',     label: '2nd Ed.' },
    ]},
    { label: 'Language', key: 'language', options: [
      { value: 'en', label: '🇬🇧 EN' },
      { value: 'nl', label: '🇳🇱 NL' },
      { value: 'ja', label: '🇯🇵 JA' },
      { value: 'ko', label: '🇰🇷 KO' },
    ]},
    { label: 'Quality',  key: 'quality',  options: [
      { value: 'high', label: '★★★ High' },
      { value: 'mid',  label: '★★ Mid' },
      { value: 'low',  label: '★ Low' },
    ]},
  ];

  rows.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'attr-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'attr-label';
    labelEl.textContent = row.label;
    rowEl.appendChild(labelEl);

    const pills = document.createElement('div');
    pills.className = 'attr-pills';

    row.options.forEach(opt => {
      const btn = document.createElement('button');
      const isActive = pendingState[row.key] === opt.value;
      btn.className = 'attr-pill' + (isActive ? ' selected' : '');
      if (row.key === 'quality') btn.dataset.quality = opt.value;
      btn.textContent = opt.label;
      btn.dataset.key = row.key;
      btn.dataset.val = opt.value;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        pendingState[row.key] = opt.value;
        pills.querySelectorAll('.attr-pill').forEach(b => b.classList.toggle('selected', b.dataset.val === opt.value));
        onChange(pendingState);
      });
      pills.appendChild(btn);
    });

    rowEl.appendChild(pills);
    wrap.appendChild(rowEl);
  });

  return wrap;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  collection = loadCollection();

  if (window.GDrive) {
    window.GDrive.onSignIn(driveData => {
      const migrated   = migrateCollection(driveData);
      const driveCount = Object.keys(migrated).length;
      if (driveCount > 0) {
        collection = migrated;
        try { localStorage.setItem('pokedex_collection', JSON.stringify(collection)); } catch(_) {}
        if (currentSet) { if (currentView === 'focus') renderFocus(); else renderGrid(); updateStats(); }
        showToast(`☁ Loaded ${driveCount} entries from Google Drive`);
      } else {
        if (Object.keys(collection).length > 0) window.GDrive.save(collection);
        showToast('☁ Google Drive connected');
      }
    });
    window.GDrive.onSignOut(() => showToast('Signed out — changes saved locally only'));
  }

  let sets;
  try {
    if (window.CARDS_DATA && Object.keys(window.CARDS_DATA).length) {
      sets = window.CARDS_DATA;
    } else {
      const res = await fetch('cards.json');
      if (!res.ok) throw new Error(res.status);
      sets = await res.json();
    }
  } catch(e) {
    emptyTitle.textContent = 'cards.json not found';
    emptyHint.textContent  = 'Run the downloader script first.';
    return;
  }

  allSets = sets;
  const setNames = Object.keys(sets).sort();
  if (!setNames.length) { emptyHint.textContent = 'No sets found in cards.json.'; return; }

  setNames.forEach(s => {
    const label = formatSetName(s);
    [picker, mobilePicker, emptyPicker].forEach(sel => {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = label;
      sel.appendChild(opt);
    });
  });

  if (isMobile()) { emptyPickerWrap.style.display = 'flex'; emptyHint.textContent = 'Pick a set to start tracking:'; }
  else            { emptyHint.textContent = 'Select a set from the dropdown above.'; }

  const syncAndLoad = val => {
    if (!val) return;
    picker.value = mobilePicker.value = emptyPicker.value = val;
    loadSet(val);
  };
  picker.addEventListener('change',       () => syncAndLoad(picker.value));
  mobilePicker.addEventListener('change', () => syncAndLoad(mobilePicker.value));
  emptyPicker.addEventListener('change',  () => syncAndLoad(emptyPicker.value));

  document.getElementById('btn-view-grid').addEventListener('click',  () => setView('grid'));
  document.getElementById('btn-view-focus').addEventListener('click', () => { if (currentCards.length) setView('focus'); });

  focusBtnClose.addEventListener('click', () => setView('grid'));
  focusBtnPrev.addEventListener('click',  () => navigateFocus(-1));
  focusBtnNext.addEventListener('click',  () => navigateFocus(+1));
  focusBtnPlus.addEventListener('click',  () => focusAdjust(+1));
  focusBtnMinus.addEventListener('click', () => {
    const key = cardKey(currentCards[focusIndex]);
    openRemoveModal(key, () => { renderFocus(); updateGridCard(focusIndex); updateStats(); });
  });

  let tx = 0;
  focusOverlay.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
  focusOverlay.addEventListener('touchend',   e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 50) navigateFocus(dx < 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('keydown', onKeyDown);
  btnExport.addEventListener('click', exportCollection);
  btnImport.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', importCollection);
}

// ── Import / Export ──────────────────────────────────────────────────────────
function exportCollection() {
  const total = Object.keys(collection).length;
  if (total === 0) { showToast('Nothing to save yet!'); return; }
  const date    = new Date().toISOString().slice(0,10);
  const blob    = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href = url; a.download = `pokedex-collection-${date}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast(`✦ Saved ${total} card entries!`);
}

function importCollection(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const raw = JSON.parse(ev.target.result);
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad format');
      const data = migrateCollection(raw);
      const applyImport = () => {
        const count = Object.keys(data).length;
        collection = data; saveCollection();
        if (currentSet) { if (currentView === 'focus') renderFocus(); else renderGrid(); updateStats(); }
        showToast(`✦ Loaded ${count} card entries!`);
      };
      const driveConnected = window.GDrive?.isSignedIn;
      const currentCount   = Object.keys(collection).length;
      if (driveConnected && currentCount > 0) showImportConfirm(currentCount, Object.keys(data).length, applyImport);
      else applyImport();
    } catch { showToast('⚠ Could not read that file.'); }
    e.target.value = '';
  };
  reader.readAsText(file);
}

function showImportConfirm(currentCount, incomingCount, onConfirm) {
  document.getElementById('import-confirm-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'import-confirm-overlay';
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-panel">
      <div class="confirm-icon">☁</div>
      <div class="confirm-title">Overwrite Google Drive backup?</div>
      <div class="confirm-body">
        Your Google Drive has <strong>${currentCount}</strong> card entr${currentCount===1?'y':'ies'} saved.
        Loading this file (<strong>${incomingCount}</strong> entr${incomingCount===1?'y':'ies'}) will
        <strong>permanently replace</strong> the Drive backup.
      </div>
      <div class="confirm-actions">
        <button class="confirm-btn confirm-cancel">Keep Drive data</button>
        <button class="confirm-btn confirm-ok">Yes, overwrite</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const close = () => { overlay.classList.remove('open'); overlay.addEventListener('transitionend', () => overlay.remove(), { once: true }); };
  overlay.querySelector('.confirm-cancel').addEventListener('click', close);
  overlay.querySelector('.confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const onKey = e => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'Enter')  { close(); onConfirm(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
}

// ── Set loading ───────────────────────────────────────────────────────────────
function loadSet(setName) {
  currentSet = setName; focusIndex = 0;
  emptyEl.classList.add('hidden'); loading.classList.add('visible');
  currentCards = (allSets[setName] || []).map(card => ({
    ...card, url: `pokemon_cards/${encodeURIComponent(setName)}/${encodeURIComponent(card.filename)}`
  }));
  loading.classList.remove('visible');
  document.getElementById('view-toggle').style.display = 'flex';
  setView('grid'); updateStats();
  setBanner.classList.add('visible');
  pillCollected.style.display = 'flex';
  mobileStatWrap.style.display = 'flex';
}

// ── View switching ────────────────────────────────────────────────────────────
function setView(mode) {
  currentView = mode;
  document.getElementById('btn-view-grid').classList.toggle('active',  mode === 'grid');
  document.getElementById('btn-view-focus').classList.toggle('active', mode === 'focus');
  if (mode === 'grid') {
    focusOverlay.classList.remove('open'); document.body.classList.remove('focus-open');
    renderGrid(); gridWrap.classList.add('visible');
  } else {
    gridWrap.classList.remove('visible');
    focusOverlay.classList.add('open'); document.body.classList.add('focus-open');
    renderFocus();
    if (focusHint) focusHint.style.display = isMobile() ? 'none' : '';
  }
}

// ── Card tags (mini attribute chips on grid cards) ────────────────────────────
function buildCardTags(container, entries) {
  container.innerHTML = '';
  if (!entries.length) return;
  const groups = {};
  entries.forEach(e => {
    const k = `${e.edition}|${e.language}|${e.quality}`;
    groups[k] = (groups[k] || 0) + 1;
  });
  Object.entries(groups).forEach(([combo, cnt]) => {
    const [edition, language, quality] = combo.split('|');
    const tag = document.createElement('div');
    tag.className = 'card-tag';
    tag.style.setProperty('--tag-q', QUALITY_COLORS[quality]);
    const parts = [];
    if (edition !== 'regular') parts.push(EDITION_LABELS[edition]);
    parts.push(LANGUAGE_SHORT[language] || language.toUpperCase());
    parts.push(QUALITY_STARS[quality]);
    if (cnt > 1) parts.push(`×${cnt}`);
    tag.textContent = parts.join(' · ');
    container.appendChild(tag);
  });
}

// ── Grid view ─────────────────────────────────────────────────────────────────
function renderGrid() {
  cardGrid.innerHTML = '';
  currentCards.forEach((card, idx) => {
    const key   = cardKey(card);
    const count = cardCount(key);
    cardGrid.appendChild(buildCardEl(card, key, count, idx));
  });
}

function buildCardEl(card, key, count, idx) {
  const item = document.createElement('div');
  item.className = 'card-item' + (count > 0 ? ' owned' : '');
  item.dataset.key = key;
  item.dataset.idx = idx;
  item.style.animationDelay = Math.min(idx * 30, 400) + 'ms';

  const wrap = document.createElement('div');
  wrap.className = 'card-img-wrap';

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = count;

  const img = document.createElement('img');
  img.className = 'card-img shimmer';
  img.alt = card.name; img.loading = 'lazy';
  img.onload  = () => img.classList.remove('shimmer');
  img.onerror = () => { img.classList.remove('shimmer'); img.style.opacity = '.3'; };
  img.src = card.url;

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const btnMinus = document.createElement('button');
  btnMinus.className = 'act-btn btn-minus' + (count === 0 ? ' hidden' : '');
  btnMinus.title = 'Remove a copy'; btnMinus.innerHTML = '&#x2212;';

  const btnPlus = document.createElement('button');
  btnPlus.className = 'act-btn btn-plus';
  btnPlus.title = 'Add a copy'; btnPlus.innerHTML = '&#x2b;';

  actions.append(btnMinus, btnPlus);
  wrap.append(img, badge, actions);

  const name = document.createElement('div');
  name.className = 'card-name'; name.textContent = card.name;

  const num = document.createElement('div');
  num.className = 'card-num'; num.textContent = formatNum(card.number);

  // Tag row
  const tagRow = document.createElement('div');
  tagRow.className = 'card-tags';
  buildCardTags(tagRow, collection[key] || []);

  // Attr selector
  const pending = { ...pendingDefaults };
  const attrWrap = document.createElement('div');
  attrWrap.className = 'card-attr-wrap';
  const attrSelector = buildAttrSelector(pending, () => {});

  // Add button inside attr wrap
  const addBtn = document.createElement('button');
  addBtn.className = 'attr-add-btn';
  addBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1v11M1 6.5h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Add this copy';

  attrWrap.append(attrSelector, addBtn);
  item.append(wrap, name, num, tagRow, attrWrap);

  addBtn.addEventListener('click', e => {
    e.stopPropagation();
    gridAdd(key, { ...pending }, item, badge, btnMinus, tagRow);
  });

  btnPlus.addEventListener('click', e => {
    e.stopPropagation();
    gridAdd(key, { ...pending }, item, badge, btnMinus, tagRow);
  });

  btnMinus.addEventListener('click', e => {
    e.stopPropagation();
    openRemoveModal(key, () => {
      const c2 = cardCount(key);
      badge.textContent = c2;
      item.classList.toggle('owned', c2 > 0);
      btnMinus.classList.toggle('hidden', c2 === 0);
      buildCardTags(tagRow, collection[key] || []);
      updateStats();
    });
  });

  item.addEventListener('click', e => {
    if (e.target.closest('.card-actions,.attr-selector,.attr-add-btn')) return;
    focusIndex = idx; setView('focus');
  });

  return item;
}

function gridAdd(key, attrs, item, badge, btnMinus, tagRow) {
  if (!collection[key]) collection[key] = [];
  collection[key].push(attrs);
  saveCollection();
  const count = collection[key].length;
  badge.textContent = count;
  item.classList.add('owned');
  btnMinus.classList.remove('hidden');
  buildCardTags(tagRow, collection[key]);
  showToast(`✦ ${EDITION_LABELS[attrs.edition]} · ${LANGUAGE_LABELS[attrs.language].split(' ')[1]} · ${attrs.quality} quality added`);
  updateStats();
}

function updateGridCard(idx) {
  const item = document.querySelector(`.card-item[data-idx="${idx}"]`);
  if (!item) return;
  const key   = cardKey(currentCards[idx]);
  const count = cardCount(key);
  const badge  = item.querySelector('.badge');
  const btnM   = item.querySelector('.btn-minus');
  const tagRow = item.querySelector('.card-tags');
  if (badge) badge.textContent = count;
  if (btnM)  btnM.classList.toggle('hidden', count === 0);
  item.classList.toggle('owned', count > 0);
  if (tagRow) buildCardTags(tagRow, collection[key] || []);
}

// ── Remove modal ──────────────────────────────────────────────────────────────
function openRemoveModal(key, onDone) {
  const entries = collection[key] || [];
  if (!entries.length) return;
  document.getElementById('remove-modal-overlay')?.remove();

  const cardName = (() => {
    const card = currentCards.find(c => cardKey(c) === key);
    return card ? card.name : key.split('/').pop();
  })();

  const overlay = document.createElement('div');
  overlay.id = 'remove-modal-overlay';
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-panel remove-panel">
      <div class="confirm-title">Remove a copy of <em>${cardName}</em></div>
      <p class="remove-subtitle">Choose which copy to remove:</p>
      <div class="remove-list" id="remove-list"></div>
      <div class="confirm-actions">
        <button class="confirm-btn confirm-cancel" id="remove-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const list = overlay.querySelector('#remove-list');
  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'remove-entry';
    row.innerHTML = `
      <div class="remove-entry-info">
        <span class="re-chip re-ed">${EDITION_LABELS[entry.edition]}</span>
        <span class="re-chip re-lang">${LANGUAGE_LABELS[entry.language]}</span>
        <span class="re-chip re-qual" style="--qc:${QUALITY_COLORS[entry.quality]}">${QUALITY_STARS[entry.quality]} ${QUALITY_LABELS[entry.quality]}</span>
      </div>
      <div class="remove-entry-btns">
        <button class="remove-entry-edit" title="Edit this copy">✎ Edit</button>
        <button class="remove-entry-btn">Remove</button>
      </div>`;
    row.querySelector('.remove-entry-edit').addEventListener('click', () => {
      close();
      openEditModal(key, i, () => { onDone(); });
    });
    row.querySelector('.remove-entry-btn').addEventListener('click', () => {
      collection[key].splice(i, 1);
      if (collection[key].length === 0) delete collection[key];
      saveCollection(); close(); onDone();
      showToast('Removed from collection');
    });
    list.appendChild(row);
  });

  const close = () => { overlay.classList.remove('open'); overlay.addEventListener('transitionend', () => overlay.remove(), { once: true }); };
  overlay.querySelector('#remove-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

// ── Edit modal ────────────────────────────────────────────────────────────────
function openEditModal(key, entryIndex, onDone) {
  const entries = collection[key] || [];
  const entry   = entries[entryIndex];
  if (!entry) return;
  document.getElementById('edit-modal-overlay')?.remove();

  const cardName = (() => {
    const card = currentCards.find(c => cardKey(c) === key);
    return card ? card.name : key.split('/').pop();
  })();

  const overlay = document.createElement('div');
  overlay.id = 'edit-modal-overlay';
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-panel edit-panel">
      <div class="confirm-title">Edit copy of <em>${cardName}</em></div>
      <p class="remove-subtitle">Copy #${entryIndex + 1} — adjust settings below</p>
      <div id="edit-attr-container"></div>
      <div class="confirm-actions">
        <button class="confirm-btn confirm-cancel" id="edit-cancel">Cancel</button>
        <button class="confirm-btn confirm-save"   id="edit-save">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const pending  = { edition: entry.edition, language: entry.language, quality: entry.quality };
  const attrWrap = overlay.querySelector('#edit-attr-container');
  attrWrap.appendChild(buildAttrSelector(pending, () => {}));

  const close = () => {
    overlay.classList.remove('open');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  };

  overlay.querySelector('#edit-save').addEventListener('click', () => {
    collection[key][entryIndex] = { ...pending };
    saveCollection();
    showToast(`✦ Copy updated`);
    close();
    onDone();
  });
  overlay.querySelector('#edit-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

// ── Focus view ────────────────────────────────────────────────────────────────
function navigateFocus(dir) {
  const next = focusIndex + dir;
  if (next < 0 || next >= currentCards.length) return;
  focusIndex = next; renderFocus();
}

function renderFocus() {
  const card  = currentCards[focusIndex];
  const key   = cardKey(card);
  const count = cardCount(key);

  focusImg.classList.add('switching');
  setTimeout(() => { focusImg.src = card.url; focusImg.classList.remove('switching'); }, 130);
  focusImg.alt = card.name;
  focusName.textContent    = card.name;
  focusNum.textContent     = formatNum(card.number);
  focusCounter.textContent = `${focusIndex + 1} / ${currentCards.length}`;
  focusBadge.textContent   = count;
  focusBadge.classList.toggle('visible', count > 0);
  focusBtnMinus.classList.toggle('hidden', count === 0);
  focusBtnPrev.disabled = focusIndex === 0;
  focusBtnNext.disabled = focusIndex === currentCards.length - 1;
  focusProgress.style.width = ((focusIndex + 1) / currentCards.length * 100).toFixed(2) + '%';

  // Update focus attr panel
  let focusAttrPanel = document.getElementById('focus-attr-panel');
  if (!focusAttrPanel) {
    focusAttrPanel = document.createElement('div');
    focusAttrPanel.id = 'focus-attr-panel';
    const focusActions = document.getElementById('focus-actions');
    focusActions.parentNode.insertBefore(focusAttrPanel, focusActions);
  }
  focusAttrPanel.innerHTML = '';

  // Owned entries
  const entries = collection[key] || [];
  if (entries.length) {
    const ownedSection = document.createElement('div');
    ownedSection.className = 'focus-owned-list';
    const ownedTitle = document.createElement('div');
    ownedTitle.className = 'focus-section-label';
    ownedTitle.textContent = `Your ${count} cop${count===1?'y':'ies'}:`;
    ownedSection.appendChild(ownedTitle);
    entries.forEach((e, i) => {
      const pill = document.createElement('div');
      pill.className = 'focus-owned-pill editable';
      pill.title = 'Click to edit this copy';
      pill.innerHTML = `
        <span class="fop-chip fop-ed">${EDITION_LABELS[e.edition]}</span>
        <span class="fop-chip fop-lang">${LANGUAGE_LABELS[e.language]}</span>
        <span class="fop-chip fop-qual" style="--qc:${QUALITY_COLORS[e.quality]}">${QUALITY_STARS[e.quality]} ${QUALITY_LABELS[e.quality]}</span>
        <button class="fop-edit-btn" title="Edit">✎</button>
      `;
      pill.addEventListener('click', () => {
        openEditModal(key, i, () => { renderFocus(); updateGridCard(focusIndex); updateStats(); });
      });
      ownedSection.appendChild(pill);
    });
    focusAttrPanel.appendChild(ownedSection);
  }

  // Add section
  const addSection = document.createElement('div');
  addSection.className = 'focus-add-section';
  const addTitle = document.createElement('div');
  addTitle.className = 'focus-section-label';
  addTitle.textContent = 'Add copy with:';
  addSection.appendChild(addTitle);

  const pending = { ...pendingDefaults };
  const selector = buildAttrSelector(pending, () => {});
  addSection.appendChild(selector);
  focusAttrPanel.appendChild(addSection);
  focusAttrPanel._pending = pending;
}

function focusAdjust(delta) {
  if (delta < 0) {
    const key = cardKey(currentCards[focusIndex]);
    openRemoveModal(key, () => { renderFocus(); updateGridCard(focusIndex); updateStats(); });
    return;
  }
  const card      = currentCards[focusIndex];
  const key       = cardKey(card);
  const attrPanel = document.getElementById('focus-attr-panel');
  const pending   = attrPanel?._pending || { ...pendingDefaults };
  if (!collection[key]) collection[key] = [];
  collection[key].push({ ...pending });
  saveCollection();
  showToast(`✦ ${EDITION_LABELS[pending.edition]} · ${LANGUAGE_LABELS[pending.language].split(' ')[1]} · ${pending.quality} quality added`);
  renderFocus(); updateGridCard(focusIndex); updateStats();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
function onKeyDown(e) {
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  if (currentView === 'focus') {
    switch (e.key) {
      case 'ArrowLeft':  case 'ArrowUp':   e.preventDefault(); navigateFocus(-1); break;
      case 'ArrowRight': case 'ArrowDown': e.preventDefault(); navigateFocus(+1); break;
      case ' ':
        e.preventDefault();
        focusAdjust(cardCount(cardKey(currentCards[focusIndex])) > 0 ? -1 : +1);
        break;
      case '+': case '=': focusAdjust(+1); break;
      case '-':           focusAdjust(-1); break;
      case 'Escape':      setView('grid');  break;
    }
  } else {
    if ((e.key === 'f' || e.key === 'F') && currentCards.length) setView('focus');
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats() {
  const total  = currentCards.length;
  const owned  = currentCards.filter(c => cardCount(cardKey(c)) > 0).length;
  const copies = currentCards.reduce((s, c) => s + cardCount(cardKey(c)), 0);
  const pct    = total ? (owned / total * 100) : 0;
  const pctStr = pct.toFixed(1) + '%';
  progressBar.style.width = pct + '%';
  bannerTitle.textContent = formatSetName(currentSet);
  bannerCount.textContent = `${owned} of ${total} unique · ${copies} copies`;
  bannerPct.textContent   = pctStr;
  pillOwned.textContent   = owned;
  pillTotal.textContent   = total;
  mobilePctEl.textContent = pctStr;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

init();
