'use strict';

let collection   = {};
let currentSet   = null;
let currentCards = [];
let allSets      = {};
let toastTimer   = null;
let focusIndex   = 0;
let currentView  = 'grid';

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

// ── Persistence ───────────────────────────────────────────────────────────────

function loadCollection() {
  try { return JSON.parse(localStorage.getItem('pokedex_collection') || '{}'); }
  catch { return {}; }
}
function saveCollection() {
  try { localStorage.setItem('pokedex_collection', JSON.stringify(collection)); }
  catch(e) { console.warn('localStorage save failed:', e); }
  // Auto-sync to the signed-in user's Google Drive
  if (window.GDrive) window.GDrive.save(collection);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSetName(s) {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function cardKey(card) { return `${currentSet}/${card.filename}`; }
function formatNum(n) {
  const s = String(n);
  const m = s.match(/^([A-Za-z]*)(\d+)$/);
  return m ? `#${m[1]}${m[2].padStart(3,'0')}` : `#${s}`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  collection = loadCollection();

  // ── Google Drive callbacks ─────────────────────────────────────
  if (window.GDrive) {
    window.GDrive.onSignIn(driveData => {
      const driveCount = Object.keys(driveData).length;
      if (driveCount > 0) {
        // Drive has saved data — load it
        collection = driveData;
        try { localStorage.setItem('pokedex_collection', JSON.stringify(collection)); }
        catch(_) {}
        if (currentSet) {
          if (currentView === 'focus') renderFocus(); else renderGrid();
          updateStats();
        }
        showToast(`☁ Loaded ${driveCount} entries from Google Drive`);
      } else {
        // First time this user signs in — push local data up as initial backup
        if (Object.keys(collection).length > 0) window.GDrive.save(collection);
        showToast('☁ Google Drive connected');
      }
    });
    window.GDrive.onSignOut(() => {
      showToast('Signed out — changes saved locally only');
    });
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
    emptyHint.textContent  = 'Run the downloader script first — it creates cards.json and cards_data.js automatically.';
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

  if (isMobile()) {
    emptyPickerWrap.style.display = 'flex';
    emptyHint.textContent = 'Pick a set to start tracking:';
  } else {
    emptyHint.textContent = 'Select a set from the dropdown above.';
  }

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
  focusBtnMinus.addEventListener('click', () => focusAdjust(-1));

  // Swipe on mobile
  let tx = 0;
  focusOverlay.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
  focusOverlay.addEventListener('touchend',   e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 50) navigateFocus(dx < 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('keydown', onKeyDown);

  // ── Import / Export ────────────────────────────────────────────
  btnExport.addEventListener('click', exportCollection);
  btnImport.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', importCollection);
}

// ── Import / Export ──────────────────────────────────────────────────────────

function exportCollection() {
  const total = Object.keys(collection).length;
  if (total === 0) { showToast('Nothing to save yet!'); return; }

  const date    = new Date().toISOString().slice(0,10);
  const payload = JSON.stringify(collection, null, 2);
  const blob    = new Blob([payload], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = `pokedex-collection-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`✦ Saved ${total} card entries!`);
}

function importCollection(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (typeof data !== 'object' || Array.isArray(data)) throw new Error('bad format');

      const applyImport = () => {
        const count = Object.keys(data).length;
        collection = data;
        saveCollection();
        if (currentSet) {
          if (currentView === 'focus') renderFocus(); else renderGrid();
          updateStats();
        }
        showToast(`✦ Loaded ${count} card entries!`);
      };

      // If Drive is connected and already has data, warn before overwriting
      const driveConnected = window.GDrive?.isSignedIn;
      const currentCount   = Object.keys(collection).length;
      if (driveConnected && currentCount > 0) {
        showImportConfirm(currentCount, Object.keys(data).length, applyImport);
      } else {
        applyImport();
      }
    } catch {
      showToast('⚠ Could not read that file.');
    }
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
        Your Google Drive has <strong>${currentCount}</strong>
        card entr${currentCount === 1 ? 'y' : 'ies'} saved.
        Loading this file (<strong>${incomingCount}</strong>
        entr${incomingCount === 1 ? 'y' : 'ies'}) will
        <strong>permanently replace</strong> the Drive backup.
      </div>
      <div class="confirm-actions">
        <button class="confirm-btn confirm-cancel">Keep Drive data</button>
        <button class="confirm-btn confirm-ok">Yes, overwrite</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const close = () => {
    overlay.classList.remove('open');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  };
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
  currentSet  = setName;
  focusIndex  = 0;
  emptyEl.classList.add('hidden');
  loading.classList.add('visible');

  currentCards = (allSets[setName] || []).map(card => ({
    ...card,
    url: `pokemon_cards/${encodeURIComponent(setName)}/${encodeURIComponent(card.filename)}`
  }));

  loading.classList.remove('visible');
  document.getElementById('view-toggle').style.display = 'flex';
  setView('grid');
  updateStats();
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
    focusOverlay.classList.remove('open');
    document.body.classList.remove('focus-open');
    renderGrid();
    gridWrap.classList.add('visible');
  } else {
    gridWrap.classList.remove('visible');
    focusOverlay.classList.add('open');
    document.body.classList.add('focus-open');
    renderFocus();
    if (focusHint) focusHint.style.display = isMobile() ? 'none' : '';
  }
}

// ── Grid view ─────────────────────────────────────────────────────────────────

function renderGrid() {
  cardGrid.innerHTML = '';
  currentCards.forEach((card, idx) => {
    const key   = cardKey(card);
    const count = collection[key] || 0;
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
  img.alt = card.name;
  img.loading = 'lazy';
  img.onload  = () => img.classList.remove('shimmer');
  img.onerror = () => { img.classList.remove('shimmer'); img.style.opacity = '.3'; };
  img.src = card.url;

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const btnMinus = document.createElement('button');
  btnMinus.className = 'act-btn btn-minus' + (count === 0 ? ' hidden' : '');
  btnMinus.title = 'Remove one';
  btnMinus.innerHTML = '&#x2212;';

  const btnPlus = document.createElement('button');
  btnPlus.className = 'act-btn btn-plus';
  btnPlus.title = 'Add one';
  btnPlus.innerHTML = '&#x2b;';

  actions.append(btnMinus, btnPlus);
  wrap.append(img, badge, actions);

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = card.name;

  const num = document.createElement('div');
  num.className = 'card-num';
  num.textContent = formatNum(card.number);

  item.append(wrap, name, num);

  btnPlus.addEventListener('click',  e => { e.stopPropagation(); gridAdjust(key, +1, item, badge, btnMinus); });
  btnMinus.addEventListener('click', e => { e.stopPropagation(); gridAdjust(key, -1, item, badge, btnMinus); });
  item.addEventListener('click', e => {
    if (e.target === btnPlus || e.target === btnMinus) return;
    focusIndex = idx;
    setView('focus');
  });

  return item;
}

function gridAdjust(key, delta, item, badge, btnMinus) {
  const prev = collection[key] || 0;
  const next = Math.max(0, prev + delta);
  if (next === prev) return;
  if (next === 0) delete collection[key]; else collection[key] = next;
  saveCollection();
  badge.textContent = next;
  item.classList.toggle('owned', next > 0);
  btnMinus.classList.toggle('hidden', next === 0);
  if (delta > 0 && next === 1)      showToast('✦ Added to collection!');
  else if (delta < 0 && next === 0) showToast('Removed from collection');
  else if (delta > 0)               showToast(`×${next} — double added!`);
  updateStats();
}

// ── Focus view ────────────────────────────────────────────────────────────────

function navigateFocus(dir) {
  const next = focusIndex + dir;
  if (next < 0 || next >= currentCards.length) return;
  focusIndex = next;
  renderFocus();
}

function renderFocus() {
  const card  = currentCards[focusIndex];
  const key   = cardKey(card);
  const count = collection[key] || 0;

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
}

function focusAdjust(delta) {
  const card  = currentCards[focusIndex];
  const key   = cardKey(card);
  const prev  = collection[key] || 0;
  const next  = Math.max(0, prev + delta);
  if (next === prev) return;
  if (next === 0) delete collection[key]; else collection[key] = next;
  saveCollection();

  focusBadge.textContent = next;
  focusBadge.classList.toggle('visible', next > 0);
  focusBtnMinus.classList.toggle('hidden', next === 0);

  const gridItem = document.querySelector(`.card-item[data-idx="${focusIndex}"]`);
  if (gridItem) {
    const b = gridItem.querySelector('.badge');
    const m = gridItem.querySelector('.btn-minus');
    if (b) b.textContent = next;
    if (m) m.classList.toggle('hidden', next === 0);
    gridItem.classList.toggle('owned', next > 0);
  }

  if (delta > 0 && next === 1)      showToast('✦ Added to collection!');
  else if (delta < 0 && next === 0) showToast('Removed from collection');
  else if (delta > 0)               showToast(`×${next} — double added!`);
  updateStats();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function onKeyDown(e) {
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  if (currentView === 'focus') {
    switch (e.key) {
      case 'ArrowLeft':  case 'ArrowUp':    e.preventDefault(); navigateFocus(-1); break;
      case 'ArrowRight': case 'ArrowDown':  e.preventDefault(); navigateFocus(+1); break;
      case ' ':
        e.preventDefault();
        focusAdjust((collection[cardKey(currentCards[focusIndex])] || 0) > 0 ? -1 : +1);
        break;
      case '+': case '=': focusAdjust(+1); break;
      case '-':           focusAdjust(-1); break;
      case 'Escape':      setView('grid'); break;
    }
  } else {
    if ((e.key === 'f' || e.key === 'F') && currentCards.length) setView('focus');
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function updateStats() {
  const total  = currentCards.length;
  const owned  = currentCards.filter(c => (collection[cardKey(c)] || 0) > 0).length;
  const copies = currentCards.reduce((s, c) => s + (collection[cardKey(c)] || 0), 0);
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
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

init();
