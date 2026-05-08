'use strict';

let collection   = {};
let currentSet   = null;
let currentCards = [];
let allSets      = {};
let toastTimer   = null;

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

const isMobile = () => window.matchMedia('(max-width: 640px)').matches;

function loadCollection() {
  try { return JSON.parse(localStorage.getItem('pokedex_collection') || '{}'); }
  catch { return {}; }
}
function saveCollection() {
  try { localStorage.setItem('pokedex_collection', JSON.stringify(collection)); }
  catch(e) { console.warn('localStorage save failed:', e); }
}

function formatSetName(s) {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function init() {
  collection = loadCollection();

  let sets;
  try {
    if (window.CARDS_DATA && Object.keys(window.CARDS_DATA).length) {
      // Loaded via cards_data.js — works with file:// and http:// alike
      sets = window.CARDS_DATA;
    } else {
      // Fallback: fetch over HTTP (works when served via a web server)
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

  if (!setNames.length) {
    emptyHint.textContent = 'No sets found in cards.json.';
    return;
  }

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
}

function loadSet(setName) {
  currentSet = setName;
  emptyEl.classList.add('hidden');
  gridWrap.classList.remove('visible');
  setBanner.classList.remove('visible');
  loading.classList.add('visible');

  currentCards = (allSets[setName] || []).map(card => ({
    ...card,
    url: `pokemon_cards/${encodeURIComponent(setName)}/${encodeURIComponent(card.filename)}`
  }));

  loading.classList.remove('visible');
  renderGrid();
  updateStats();
  setBanner.classList.add('visible');
  gridWrap.classList.add('visible');
  pillCollected.style.display = 'flex';
  mobileStatWrap.style.display = 'flex';
}

function renderGrid() {
  cardGrid.innerHTML = '';
  currentCards.forEach((card, idx) => {
    const key   = `${currentSet}/${card.filename}`;
    const count = collection[key] || 0;
    cardGrid.appendChild(buildCardEl(card, key, count, idx));
  });
}

function buildCardEl(card, key, count, idx) {
  const item = document.createElement('div');
  item.className = 'card-item' + (count > 0 ? ' owned' : '');
  item.dataset.key = key;
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
  // card.number may be "42" (plain) or "H8" (letter-prefixed holofoil etc.)
  const numStr = String(card.number);
  const numMatch = numStr.match(/^([A-Za-z]*)(\d+)$/);
  num.textContent = numMatch
    ? `#${numMatch[1]}${numMatch[2].padStart(3, '0')}`
    : `#${numStr}`;

  item.append(wrap, name, num);

  btnPlus.addEventListener('click',  e => { e.stopPropagation(); adjust(key, +1, item, badge, btnMinus); });
  btnMinus.addEventListener('click', e => { e.stopPropagation(); adjust(key, -1, item, badge, btnMinus); });
  item.addEventListener('click', e => {
    if (e.target === btnPlus || e.target === btnMinus) return;
    const c = collection[key] || 0;
    adjust(key, c === 0 ? +1 : -1, item, badge, btnMinus);
  });

  return item;
}

function adjust(key, delta, item, badge, btnMinus) {
  const prev = collection[key] || 0;
  const next = Math.max(0, prev + delta);
  if (next === prev) return;

  if (next === 0) delete collection[key];
  else collection[key] = next;
  saveCollection();

  badge.textContent = next;
  item.classList.toggle('owned', next > 0);
  btnMinus.classList.toggle('hidden', next === 0);

  if (delta > 0 && next === 1)      showToast('✦ Added to collection!');
  else if (delta < 0 && next === 0) showToast('Removed from collection');
  else if (delta > 0)               showToast(`×${next} — double added!`);

  updateStats();
}

function updateStats() {
  const total  = currentCards.length;
  const owned  = currentCards.filter(c => (collection[`${currentSet}/${c.filename}`] || 0) > 0).length;
  const copies = currentCards.reduce((s, c) => s + (collection[`${currentSet}/${c.filename}`] || 0), 0);
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

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

init();
