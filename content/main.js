const MESSAGE = {
  GET_SUBNET_METRICS: 'GET_SUBNET_METRICS',
  REFRESH_METRICS: 'REFRESH_METRICS',
  CAPTURE_TAO_API: 'CAPTURE_TAO_API',
  UPSERT_METRIC: 'UPSERT_METRIC',
  START_BACKGROUND_TRACKING: 'START_BACKGROUND_TRACKING',
  STOP_BACKGROUND_TRACKING: 'STOP_BACKGROUND_TRACKING',
  SYNC_ALL_SUBNETS: 'SYNC_ALL_SUBNETS',
  SYNC_SINGLE_SUBNET: 'SYNC_SINGLE_SUBNET',
  CANCEL_SYNC: 'CANCEL_SYNC',
  GET_SYNC_STATUS: 'GET_SYNC_STATUS',
  SCRAPE_PAGE_READY: 'SCRAPE_PAGE_READY',
  METRICS_REFRESH: 'METRICS_REFRESH',
  SHEETS_PUSH: 'SHEETS_PUSH',
  SHEETS_PULL: 'SHEETS_PULL',
  SHEETS_SYNC: 'SHEETS_SYNC',
  SHEETS_CREATE: 'SHEETS_CREATE',
  SHEETS_PULL_IF_ENABLED: 'SHEETS_PULL_IF_ENABLED',
};

const COLUMN = {
  BURN: 'tao-analytics-burn',
  FEE: 'tao-analytics-fee',
};

const COLUMN_WIDTH = {
  burn: 96,
  fee: 88,
};

const STORAGE_CACHE_KEY = 'subnetMetricsCache';
const SYNC_STATUS_KEY = 'subnetSyncStatus';
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

let metrics = new Map();
let tableObserver = null;
let observedTbody = null;
let isEnhancing = false;
let enhanceDebounceTimer = null;
let pendingCacheReload = false;
const ENHANCE_DEBOUNCE_MS = 200;
const rowSyncing = new Set();
let globalSyncRunning = false;
let globalSyncNetuid = null;
let columnSortState = { key: null, direction: null };

function isExtensionContextValid() {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function sendRuntimeMessage(message) {
  if (!isExtensionContextValid()) {
    return Promise.resolve(null);
  }
  return chrome.runtime.sendMessage(message).catch(() => null);
}

async function getLocalStorage(keys) {
  if (!isExtensionContextValid()) {
    return {};
  }
  try {
    return await chrome.storage.local.get(keys);
  } catch {
    return {};
  }
}

async function setLocalStorage(data) {
  if (!isExtensionContextValid()) {
    return false;
  }
  try {
    await chrome.storage.local.set(data);
    return true;
  } catch {
    return false;
  }
}

function isExplorerPage() {
  return /\/explorer\/?$/i.test(location.pathname) || location.pathname.includes('/explorer');
}

function isSubnetPage() {
  return /^\/subnets\/\d+/i.test(location.pathname);
}

function getNetuidFromPath() {
  const match = location.pathname.match(/\/subnets\/(\d{1,3})/i);
  if (!match) return null;
  const netuid = Number(match[1]);
  return Number.isInteger(netuid) && netuid >= 0 && netuid <= 256 ? netuid : null;
}

function normalizeText(value) {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function parseMoneyLikeNumber(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const cleaned = normalized.replace(/[$,τ\s]|TAO/gi, '').trim();
  if (!cleaned) return null;

  const suffixMatch = cleaned.match(/^([+-]?\d+(?:\.\d+)?)([kmbt])?$/i);
  if (suffixMatch) {
    const base = Number(suffixMatch[1]);
    if (!Number.isFinite(base)) return null;

    const suffix = (suffixMatch[2] || '').toLowerCase();
    const multipliers = {
      k: 1_000,
      m: 1_000_000,
      b: 1_000_000_000,
      t: 1_000_000_000_000,
    };

    return suffix ? base * multipliers[suffix] : base;
  }

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function detectCurrency(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (normalized.includes('$')) return 'USD';
  // tao.app compact USD amounts like "2.93K" (no $ on the value node).
  if (/[kmbt]/i.test(normalized) && /\d/.test(normalized)) return 'USD';
  if (normalized.includes('τ') || /TAO/i.test(normalized)) return 'TAO';
  return null;
}

function scrapeTaoUsdPrice() {
  // tao.app commonly shows TAO/USD in a top bar as "$253.22"
  // Grab the first leaf node that looks like a dollar price.
  const candidates = Array.from(document.querySelectorAll('span, div, p'))
    .filter((el) => el.children.length === 0)
    .map((el) => normalizeText(el.textContent))
    .filter((t) => /^\$\s?\d{1,5}(?:,\d{3})*(?:\.\d{2,6})?$/.test(t));

  if (candidates.length === 0) return null;
  const price = parseMoneyLikeNumber(candidates[0]);
  return price && price > 0 ? price : null;
}

function formatUsd(value) {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }

  const abs = Math.abs(value);
  const fractionDigits = abs >= 100 ? 0 : abs >= 1 ? 2 : 2;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function parseNetuid(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/^(\d{1,3})$/);
  if (!match) {
    return null;
  }

  const netuid = Number(match[1]);
  return netuid >= 0 && netuid <= 256 ? netuid : null;
}

function formatTaoDisplay(value) {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  if (value >= 100) {
    return value.toFixed(2);
  }
  if (value >= 1) {
    return value.toFixed(3);
  }
  if (value >= 0.01) {
    return value.toFixed(4);
  }
  return value.toFixed(6);
}

function isValidBurnRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

function parseBurnRate(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  if (/%/.test(normalized)) {
    const pct = parseMoneyLikeNumber(normalized.replace(/%/g, ''));
    if (pct == null) {
      return null;
    }
    const rate = pct / 100;
    return isValidBurnRate(rate) ? rate : null;
  }

  const num = parseMoneyLikeNumber(normalized);
  if (num == null) {
    return null;
  }

  if (num > 1 && num <= 100) {
    const rate = num / 100;
    return isValidBurnRate(rate) ? rate : null;
  }

  return isValidBurnRate(num) ? num : null;
}

function normalizeBurnRate(value) {
  const parsed = parseBurnRate(String(value));
  if (parsed != null) {
    return parsed;
  }
  const n = Number(value);
  return Number.isFinite(n) && isValidBurnRate(n) ? n : 0;
}

function formatBurnRate(value) {
  if (!isValidBurnRate(value)) {
    return '—';
  }
  return Number(value).toFixed(4);
}

function getBurnRateFromData(data) {
  if (!data || data.ownerIncentive == null) {
    return null;
  }
  return normalizeBurnRate(data.ownerIncentive);
}

function isBurnRateKnown(data) {
  return Boolean(data && data.ownerIncentive != null);
}

function isFullBurnRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 - 1e-9;
}

function getBurnVisualState(data, burnRate) {
  if (!data) {
    return 'loading';
  }
  if (!isBurnRateKnown(data)) {
    return 'unknown';
  }
  if (burnRate != null && isFullBurnRate(burnRate)) {
    return 'full';
  }
  return 'known';
}

function applyBurnCellVisualState(burnCell, visualState) {
  burnCell.classList.remove(
    'tao-analytics-owner-incentive',
    'tao-analytics-burn-known',
    'tao-analytics-burn-unknown',
    'tao-analytics-burn-full'
  );

  if (visualState === 'unknown' || visualState === 'loading') {
    burnCell.classList.add('tao-analytics-burn-unknown');
  } else if (visualState === 'full') {
    burnCell.classList.add('tao-analytics-burn-full');
  } else if (visualState === 'known') {
    burnCell.classList.add('tao-analytics-burn-known');
  }
}

function findSubnetTable() {
  for (const table of document.querySelectorAll('table')) {
    const headerCells = [...table.querySelectorAll('thead th')];
    if (headerCells.length < 4) {
      continue;
    }

    const labels = headerCells.map((cell) => normalizeText(cell.textContent));
    const snIdx = labels.findIndex((label) => label === 'SN');
    const nameIdx = labels.findIndex((label) => label === 'Name');

    if (snIdx >= 0 && nameIdx >= 0) {
      return { table, headerCells, snIdx, nameIdx };
    }
  }

  return null;
}

function collectVisibleNetuids(tableInfo) {
  const netuids = new Set();

  tableInfo.table.querySelectorAll('tbody tr').forEach((row) => {
    const cells = row.querySelectorAll('td');
    const netuid = parseNetuid(cells[tableInfo.snIdx]?.textContent);
    if (netuid != null) {
      netuids.add(netuid);
    }
  });

  return [...netuids];
}

function collectAllExplorerNetuids() {
  const tableInfo = findSubnetTable();
  if (tableInfo) {
    const fromTable = collectVisibleNetuids(tableInfo);
    if (fromTable.length > 0) {
      return [...fromTable].sort((a, b) => a - b);
    }
  }

  // Fallback when the table is not mounted yet.
  return Array.from({ length: 128 }, (_, i) => i + 1);
}

async function collectSyncAllNetuids() {
  const tableInfo = findSubnetTable();
  const netuids = collectAllExplorerNetuids();

  if (tableInfo) {
    try {
      await loadMetricsFromLocalCache(tableInfo);
    } catch {
      // Continue with table netuids even if cache read fails.
    }
  }

  const unknownBurn = [];
  const knownBurn = [];

  netuids.forEach((netuid) => {
    const data = metrics.get(netuid);
    if (!data || !isBurnRateKnown(data)) {
      unknownBurn.push(netuid);
    } else {
      knownBurn.push(netuid);
    }
  });

  unknownBurn.sort((a, b) => a - b);
  knownBurn.sort((a, b) => a - b);

  return [...unknownBurn, ...knownBurn];
}

function findExplorerToolbarAnchor() {
  const deregBtn = [...document.querySelectorAll('button')].find((btn) =>
    /^dereg$/i.test(normalizeText(btn.textContent))
  );
  return deregBtn?.parentElement ?? null;
}

function buildSyncIcon(size = 14) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute(
    'd',
    'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6'
  );
  svg.appendChild(path);
  return svg;
}

function applySyncStatus(status) {
  globalSyncRunning = Boolean(status?.running);
  globalSyncNetuid =
    status?.currentNetuid != null ? Number(status.currentNetuid) : null;
  updateSyncButton(status);
}

function updateSyncButton(status) {
  const btn = document.getElementById('tao-analytics-sync-btn');
  const label = btn?.querySelector('.tao-analytics-sync-label');
  if (!btn || !label) {
    return;
  }

  if (status?.running) {
    btn.disabled = false;
    btn.classList.add('tao-analytics-sync-running');
    btn.title = 'Click again to stop sync';
    const done = status.done ?? 0;
    const total = status.total ?? 0;
    const sn = status.currentNetuid != null ? ` SN${status.currentNetuid}` : '';
    label.textContent = total > 0 ? `Stop ${done}/${total}${sn}` : 'Stopping…';
    return;
  }

  btn.title =
    'Sync all subnets: unknown burn rates (grey —) first, then the rest';

  btn.disabled = false;
  btn.classList.remove('tao-analytics-sync-running');
  label.textContent = 'Sync All';
}

function ensureSyncButton() {
  const anchor = findExplorerToolbarAnchor();
  if (!anchor) {
    return;
  }

  let btn = document.getElementById('tao-analytics-sync-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'tao-analytics-sync-btn';
    btn.type = 'button';
    btn.className = 'tao-analytics-sync-btn';
    btn.title =
      'Sync all subnets: unknown burn rates (grey —) first, then the rest';

    btn.appendChild(buildSyncIcon());
    const label = document.createElement('span');
    label.className = 'tao-analytics-sync-label';
    label.textContent = 'Sync All';
    btn.appendChild(label);

    btn.addEventListener('click', async () => {
      const status = await getLocalStorage(SYNC_STATUS_KEY);
      if (status?.[SYNC_STATUS_KEY]?.running) {
        await sendRuntimeMessage({ type: MESSAGE.CANCEL_SYNC });
        applySyncStatus({
          running: false,
          cancelled: true,
          done: status[SYNC_STATUS_KEY].done ?? 0,
          total: status[SYNC_STATUS_KEY].total ?? 0,
        });
        rowSyncing.clear();
        scheduleCacheEnhance();
        return;
      }

      const netuids = await collectSyncAllNetuids();
      const response = await sendRuntimeMessage({
        type: MESSAGE.SYNC_ALL_SUBNETS,
        netuids,
      });

      if (response?.error) {
        console.warn('[TAO Subnet Analytics] Sync failed to start:', response.error);
      }
    });

    anchor.insertBefore(btn, anchor.firstElementChild);
  }

  getLocalStorage(SYNC_STATUS_KEY).then((stored) => {
    applySyncStatus(stored[SYNC_STATUS_KEY]);
  });
}

async function syncSingleSubnet(netuid) {
  if (rowSyncing.has(netuid)) {
    return;
  }

  const stored = await getLocalStorage(SYNC_STATUS_KEY);
  if (stored?.[SYNC_STATUS_KEY]?.running) {
    console.warn('[TAO Subnet Analytics] Sync already in progress');
    return;
  }

  rowSyncing.add(netuid);
  scheduleTableEnhance();

  try {
    const response = await sendRuntimeMessage({
      type: MESSAGE.SYNC_SINGLE_SUBNET,
      netuid,
    });
    if (response?.error) {
      console.warn('[TAO Subnet Analytics] Subnet sync failed:', response.error);
      return;
    }

    const tableInfo = findSubnetTable();
    if (tableInfo) {
      await loadMetricsFromLocalCache(tableInfo);
      isEnhancing = true;
      try {
        enhanceTable(tableInfo);
      } finally {
        isEnhancing = false;
      }
    }
  } catch (error) {
    console.warn('[TAO Subnet Analytics] Subnet sync failed:', error.message);
  } finally {
    rowSyncing.delete(netuid);
    scheduleCacheEnhance();
  }
}

async function requestMetrics(tableInfo, force = false) {
  const netuids = collectVisibleNetuids(tableInfo);
  if (netuids.length === 0) {
    return;
  }

  const response = await sendRuntimeMessage({
    type: force ? MESSAGE.REFRESH_METRICS : MESSAGE.GET_SUBNET_METRICS,
    netuids,
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  metrics = new Map(
    Object.entries(response || {}).map(([netuid, value]) => [Number(netuid), value])
  );
}

async function upsertMetricCache(netuid, patch) {
  if (!isExtensionContextValid()) {
    return;
  }

  const response = await sendRuntimeMessage({
    type: MESSAGE.UPSERT_METRIC,
    netuid: Number(netuid),
    patch,
  });

  if (response?.ok) {
    return;
  }

  const stored = await getLocalStorage(STORAGE_CACHE_KEY);
  const entry = stored?.[STORAGE_CACHE_KEY] ?? null;
  const value =
    entry?.value && typeof entry.value === 'object' ? { ...entry.value } : {};
  const key = String(netuid);
  const current =
    value[key] && typeof value[key] === 'object' ? value[key] : { netuid };

  value[key] = {
    ...current,
    ...patch,
    source: patch.source ?? current.source ?? 'dom',
  };

  await setLocalStorage({
    [STORAGE_CACHE_KEY]: {
      timestamp: Date.now(),
      ttl: entry?.ttl ?? DEFAULT_CACHE_TTL_MS,
      value,
    },
  });
}

async function loadMetricsFromLocalCache(tableInfo) {
  const netuids = collectVisibleNetuids(tableInfo);
  if (netuids.length === 0) {
    return;
  }

  const stored = await getLocalStorage(STORAGE_CACHE_KEY);
  const entry = stored?.[STORAGE_CACHE_KEY] ?? null;
  const value = entry?.value && typeof entry.value === 'object' ? entry.value : {};

  // Merge visible rows from cache into the in-memory map.
  netuids.forEach((netuid) => {
    const cached = value[String(netuid)];
    if (cached) {
      metrics.set(Number(netuid), cached);
    }
  });
}

function matchesOwnerIncentiveLabel(text) {
  const t = normalizeText(text).toLowerCase().replace(/[:.]/g, ' ');
  return t.includes('owner') && t.includes('incentive');
}

function isOrangeBurnElement(el) {
  if (!(el instanceof Element)) {
    return false;
  }

  let current = el;
  for (let depth = 0; depth < 6 && current instanceof Element; depth += 1) {
    const cls = current.className?.toString() ?? '';
    if (/text-orange|text-amber|orange-500|amber-500/i.test(cls)) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

function isMetagraphBurnPageReady() {
  const activeTab = getActiveSubnetTab();
  if (activeTab !== 'metagraph') {
    return false;
  }

  return Boolean(
    document.querySelector('[aria-label="Owner incentive"]') ||
    document.querySelector('table tbody tr')
  );
}

function collectOwnerIncentiveFromDom() {
  let best = null;

  const rows = document.querySelectorAll('div.flex.items-center.justify-between');
  for (const row of rows) {
    const children = [...row.children];
    if (children.length < 2) {
      continue;
    }

    const labelText = normalizeText(children[0]?.textContent ?? '');
    if (!matchesOwnerIncentiveLabel(labelText)) {
      continue;
    }

    const valueEl =
      row.querySelector(':scope > .font-bold') ||
      row.querySelector(':scope > .text-sm.font-bold') ||
      children[children.length - 1];
    if (!isOrangeBurnElement(valueEl)) {
      continue;
    }

    const rate = parseBurnRate(valueEl?.textContent ?? '');
    if (rate != null && (best == null || rate > best)) {
      best = rate;
    }
  }

  for (const ownerEl of document.querySelectorAll('[aria-label="Owner incentive"]')) {
    if (!isOrangeBurnElement(ownerEl)) {
      continue;
    }

    const rate = parseBurnRate(ownerEl.textContent);
    if (rate != null && (best == null || rate > best)) {
      best = rate;
    }
  }

  for (const el of document.querySelectorAll('.text-orange-500, .text-orange-400, .text-amber-500')) {
    if (!el.closest('table')) {
      continue;
    }

    const rate = parseBurnRate(el.textContent);
    if (rate == null) {
      continue;
    }

    if (best == null || rate > best) {
      best = rate;
    }
  }

  if (best != null) {
    return best;
  }

  // On metagraph: no yellow/orange owner incentive visible → burn rate is 0.
  if (isMetagraphBurnPageReady()) {
    return 0;
  }

  return null;
}

function matchesRegCostLabel(text) {
  const t = normalizeText(text).toLowerCase().replace(/[:.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) {
    return false;
  }
  const hasReg = t.includes('reg') || t.includes('registration');
  const hasCost = t.includes('cost') || t.includes('fee');
  return hasReg && hasCost;
}

async function upsertRegFeePatch(netuid, valueText, lastRegSignatureRef) {
  const value = parseMoneyLikeNumber(valueText);
  if (value == null) {
    return false;
  }

  const currency = detectCurrency(valueText);
  const taoUsd = scrapeTaoUsdPrice();
  const burnUsd = currency === 'USD' ? value : null;
  const burnTao =
    currency === 'USD' && taoUsd
      ? value / taoUsd
      : currency === 'TAO'
        ? value
        : null;

  if (burnUsd == null && burnTao == null) {
    return false;
  }

  const signature = `${burnTao}:${burnUsd}:${taoUsd}`;

  if (signature === lastRegSignatureRef.value) {
    return true;
  }

  lastRegSignatureRef.value = signature;
  await upsertMetricCache(netuid, {
    burnTao,
    burnRao: Math.round(burnTao * 1_000_000_000),
    burnUsd,
    taoUsd,
    source: 'dom',
    domCapturedAt: Date.now(),
  });
  return true;
}

function getActiveSubnetTab() {
  const tab = new URLSearchParams(location.search).get('active_tab');
  return tab ? tab.toLowerCase() : null;
}

function isAboutSubnetTab() {
  const activeTab = getActiveSubnetTab();
  return activeTab == null || activeTab === 'about';
}

function insertAfter(referenceNode, newNode) {
  if (!referenceNode?.parentElement) {
    return false;
  }

  referenceNode.parentElement.insertBefore(newNode, referenceNode.nextSibling);
  return true;
}

function applyColumnWidth(el, px) {
  el.style.width = `${px}px`;
  el.style.minWidth = `${px}px`;
  el.style.maxWidth = `${px}px`;
}

function getStyleReference(tableInfo) {
  const headerRow = tableInfo.table.querySelector('thead tr');
  const headerCells = headerRow ? [...headerRow.querySelectorAll('th')] : tableInfo.headerCells;
  const labels = headerCells.map((cell) => normalizeText(cell.textContent));
  const priceIdx = labels.findIndex((label) => label === 'Price' || label.startsWith('Price'));
  const snIdx = labels.findIndex((label) => label === 'SN');
  const refIdx = priceIdx >= 0 ? priceIdx : snIdx;
  const refTh = headerCells[refIdx];
  const refRow = tableInfo.table.querySelector('tbody tr');
  const refTd = refRow?.querySelectorAll('td')[refIdx] ?? null;

  return { refTh, refTd };
}

function ensureColgroup(tableInfo) {
  const colgroup = tableInfo.table.querySelector('colgroup');
  if (!colgroup) {
    return;
  }

  const cols = [...colgroup.children];
  const nameCol = cols[tableInfo.nameIdx];
  let burnCol = colgroup.querySelector('.tao-analytics-col-burn');
  let feeCol = colgroup.querySelector('.tao-analytics-col-fee');

  if (!burnCol) {
    burnCol = document.createElement('col');
    burnCol.className = 'tao-analytics-col-burn';
    if (nameCol?.nextSibling) {
      colgroup.insertBefore(burnCol, nameCol.nextSibling);
    } else {
      colgroup.appendChild(burnCol);
    }
  }

  if (!feeCol) {
    feeCol = document.createElement('col');
    feeCol.className = 'tao-analytics-col-fee';
    if (burnCol.nextSibling) {
      colgroup.insertBefore(feeCol, burnCol.nextSibling);
    } else {
      colgroup.appendChild(feeCol);
    }
  }

  applyColumnWidth(burnCol, COLUMN_WIDTH.burn);
  applyColumnWidth(feeCol, COLUMN_WIDTH.fee);
}

function setSortableHeaderLabel(button, label) {
  if (!button) {
    return;
  }

  const svg = button.querySelector('svg');
  if (!svg) {
    button.textContent = label;
    return;
  }

  const insertParent = svg.parentElement;
  if (!insertParent) {
    button.textContent = label;
    return;
  }

  const removeTextNodes = (root) => {
    [...root.childNodes].forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        node.remove();
      }
    });
  };

  removeTextNodes(button);
  if (insertParent !== button) {
    removeTextNodes(insertParent);
  }

  insertParent.insertBefore(document.createTextNode(label), svg);
}

function buildSortableHeaderContent(label, referenceTh) {
  const refButton = referenceTh?.querySelector('button') ?? referenceTh?.firstElementChild;
  if (!refButton) {
    const fallback = document.createElement('button');
    fallback.type = 'button';
    fallback.className = 'tao-analytics-sort-btn';
    fallback.textContent = label;
    return fallback;
  }

  const button = refButton.cloneNode(true);
  button.removeAttribute('id');
  setSortableHeaderLabel(button, label);
  return button;
}

function populateSortableHeader(th, label, referenceTh, sortKey) {
  const hasSortUi = th.dataset.taoAnalyticsSort === sortKey &&
    Boolean(th.querySelector('svg, .tao-analytics-sort-btn'));

  if (!hasSortUi) {
    th.dataset.taoAnalyticsSort = sortKey;
    th.replaceChildren(buildSortableHeaderContent(label, referenceTh));
  } else {
    const button = th.querySelector('button') ?? th.firstElementChild ?? th;
    setSortableHeaderLabel(button, label);
  }

  if (referenceTh?.style?.cursor) {
    th.style.cursor = referenceTh.style.cursor;
  }
}

function createHeaderCell(label, className, title, referenceTh, widthPx, sortKey) {
  const th = document.createElement('th');
  th.className = `tao-analytics-header ${className}`;
  if (referenceTh?.className) {
    th.className = `${referenceTh.className} tao-analytics-header ${className}`;
  }
  th.title = title;
  applyColumnWidth(th, widthPx);
  populateSortableHeader(th, label, referenceTh, sortKey);
  return th;
}

function getFeeUsdFromData(data, taoUsdPrice) {
  if (!data) {
    return null;
  }

  if (data.burnUsd != null && Number.isFinite(Number(data.burnUsd))) {
    return Number(data.burnUsd);
  }

  if (data.burnTao != null && taoUsdPrice) {
    const tao = Number(data.burnTao);
    return Number.isFinite(tao) ? tao * taoUsdPrice : null;
  }

  return null;
}

function parseBurnFromCell(burnCell) {
  const text = readBurnCellText(burnCell);
  if (!text || text === '…' || text === '—') {
    return null;
  }
  return parseBurnRate(text);
}

function parseFeeFromCell(feeCell) {
  const text = normalizeText(feeCell?.textContent);
  if (!text || text === '…' || text === '—') {
    return null;
  }
  return parseMoneyLikeNumber(text);
}

function getRowSortValue(row, tableInfo, sortKey, taoUsdPrice) {
  const cells = [...row.querySelectorAll('td')];
  const netuid = parseNetuid(cells[tableInfo.snIdx]?.textContent);
  if (netuid == null) {
    return null;
  }

  const data = metrics.get(netuid);

  if (sortKey === 'burn') {
    if (isBurnRateKnown(data)) {
      return getBurnRateFromData(data);
    }
    return parseBurnFromCell(row.querySelector(`.${COLUMN.BURN}`));
  }

  if (sortKey === 'fee') {
    const feeUsd = getFeeUsdFromData(data, taoUsdPrice);
    if (feeUsd != null) {
      return feeUsd;
    }
    return parseFeeFromCell(row.querySelector(`.${COLUMN.FEE}`));
  }

  return null;
}

function updateAnalyticsSortIndicators(tableInfo) {
  const headerRow = tableInfo.table.querySelector('thead tr');
  if (!headerRow) {
    return;
  }

  headerRow.querySelectorAll(`th[data-tao-analytics-sort]`).forEach((th) => {
    const isActive = th.dataset.taoAnalyticsSort === columnSortState.key;
    if (isActive && columnSortState.direction) {
      th.setAttribute(
        'aria-sort',
        columnSortState.direction === 'asc' ? 'ascending' : 'descending'
      );
    } else {
      th.removeAttribute('aria-sort');
    }
  });
}

function applyColumnSort(tableInfo) {
  const { key, direction } = columnSortState;
  if (!key || !direction) {
    return;
  }

  const tbody = tableInfo.table.querySelector('tbody');
  if (!tbody) {
    return;
  }

  const taoUsdPrice = scrapeTaoUsdPrice();
  const rows = [...tbody.querySelectorAll('tr')];
  const indexed = rows.map((row, originalIndex) => ({
    row,
    originalIndex,
    value: getRowSortValue(row, tableInfo, key, taoUsdPrice),
  }));

  indexed.sort((a, b) => {
    const aVal = a.value;
    const bVal = b.value;

    if (aVal == null && bVal == null) {
      return a.originalIndex - b.originalIndex;
    }
    if (aVal == null) {
      return 1;
    }
    if (bVal == null) {
      return -1;
    }
    if (aVal === bVal) {
      return a.originalIndex - b.originalIndex;
    }

    const cmp = aVal < bVal ? -1 : 1;
    return direction === 'asc' ? cmp : -cmp;
  });

  indexed.forEach(({ row }) => tbody.appendChild(row));
  updateAnalyticsSortIndicators(tableInfo);
}

function ensureColumnSortDelegation(tableInfo) {
  const table = tableInfo.table;
  if (table.dataset.taoAnalyticsColumnSortBound === '1') {
    return;
  }

  table.dataset.taoAnalyticsColumnSortBound = '1';
  table.addEventListener('click', (event) => {
    const th = event.target.closest(`th.${COLUMN.BURN}, th.${COLUMN.FEE}`);
    if (!th?.dataset.taoAnalyticsSort) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const sortKey = th.dataset.taoAnalyticsSort;
    const nextDirection =
      columnSortState.key === sortKey && columnSortState.direction === 'desc'
        ? 'asc'
        : 'desc';

    columnSortState = { key: sortKey, direction: nextDirection };
    applyColumnSort(tableInfo);
  }, true);
}

function createBodyCell(className, text, title, referenceTd, widthPx) {
  const td = document.createElement('td');
  td.className = `tao-analytics-cell ${className}`;
  if (referenceTd?.className) {
    td.className = `${referenceTd.className} tao-analytics-cell ${className}`;
  }
  td.textContent = text;
  td.title = title;
  applyColumnWidth(td, widthPx);
  return td;
}

function buildBurnRateNode(netuid, valueText, isSyncing = false) {
  const wrapper = document.createElement('span');
  wrapper.className = 'tao-analytics-burn-inline inline-flex items-center';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tao-analytics-row-sync-btn';
  btn.dataset.netuid = String(netuid);
  btn.title = `Sync burn rate & reg fee for SN${netuid}`;
  btn.setAttribute('aria-label', `Sync subnet ${netuid}`);
  if (isSyncing) {
    btn.classList.add('tao-analytics-sync-running');
    btn.disabled = true;
  }
  btn.appendChild(buildSyncIcon(12));

  const text = document.createElement('span');
  text.className = 'tao-analytics-burn-value inline-flex items-center';
  text.textContent = valueText;

  wrapper.appendChild(btn);
  wrapper.appendChild(text);
  return wrapper;
}

function ensureRowSyncDelegation(table) {
  if (table.dataset.taoAnalyticsSyncBound === '1') {
    return;
  }

  table.dataset.taoAnalyticsSyncBound = '1';

  const handleRowSync = (event) => {
    const btn = event.target.closest('.tao-analytics-row-sync-btn');
    if (!btn || btn.disabled) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const netuid = Number(btn.dataset.netuid);
    if (Number.isInteger(netuid)) {
      syncSingleSubnet(netuid);
    }
  };

  table.addEventListener('mousedown', handleRowSync, true);
  table.addEventListener('click', handleRowSync, true);
}

function ensureHeader(tableInfo) {
  const headerRow = tableInfo.table.querySelector('thead tr');
  if (!headerRow) {
    return null;
  }

  const { refTh } = getStyleReference(tableInfo);
  const headerCells = [...headerRow.querySelectorAll('th')];
  const nameIdx = headerCells.findIndex((cell) => normalizeText(cell.textContent) === 'Name');
  const nameTh = nameIdx >= 0 ? headerCells[nameIdx] : null;
  if (!nameTh) {
    return null;
  }

  ensureColgroup(tableInfo);

  let burnHeader = headerRow.querySelector(`.${COLUMN.BURN}`);
  let feeHeader = headerRow.querySelector(`.${COLUMN.FEE}`);

  if (!burnHeader) {
    burnHeader = createHeaderCell(
      'Burn Rate',
      COLUMN.BURN,
      'Owner incentive (0–1, inclusive) from subnet metagraph',
      refTh,
      COLUMN_WIDTH.burn,
      'burn'
    );
    insertAfter(nameTh, burnHeader);
  } else {
    populateSortableHeader(burnHeader, 'Burn Rate', refTh, 'burn');
  }

  if (!feeHeader) {
    feeHeader = createHeaderCell(
      'Reg. Fee',
      COLUMN.FEE,
      'TAO required for burned registration',
      refTh,
      COLUMN_WIDTH.fee,
      'fee'
    );
    insertAfter(burnHeader, feeHeader);
  } else {
    populateSortableHeader(feeHeader, 'Reg. Fee', refTh, 'fee');
  }

  applyColumnWidth(burnHeader, COLUMN_WIDTH.burn);
  applyColumnWidth(feeHeader, COLUMN_WIDTH.fee);

  return { burnHeader, feeHeader, nameTh, refTh };
}

function getNameCell(row, tableInfo) {
  const headerRow = tableInfo.table.querySelector('thead tr');
  const headerCells = headerRow ? [...headerRow.querySelectorAll('th')] : [];
  const nameIdx = headerCells.findIndex((cell) => normalizeText(cell.textContent) === 'Name');
  if (nameIdx < 0) {
    return null;
  }

  const cells = [...row.querySelectorAll('td')];
  return cells[nameIdx] ?? null;
}

function readBurnCellText(burnCell) {
  const value = burnCell.querySelector('.tao-analytics-burn-value');
  return normalizeText(value?.textContent ?? burnCell.textContent);
}

function readBurnCellSyncState(burnCell, netuid) {
  const btn = burnCell.querySelector('.tao-analytics-row-sync-btn');
  const isSyncing = rowSyncing.has(netuid) ||
    (globalSyncRunning && globalSyncNetuid === netuid);
  let visualState = 'loading';
  if (burnCell.classList.contains('tao-analytics-burn-full')) {
    visualState = 'full';
  } else if (burnCell.classList.contains('tao-analytics-burn-known')) {
    visualState = 'known';
  } else if (burnCell.classList.contains('tao-analytics-burn-unknown')) {
    visualState = 'unknown';
  }

  return {
    display: readBurnCellText(burnCell),
    isSyncing: Boolean(btn?.classList.contains('tao-analytics-sync-running') || isSyncing),
    visualState,
  };
}

function enhanceRow(row, tableInfo, styleRef, taoUsdPrice) {
  const cells = row.querySelectorAll('td');
  const netuid = parseNetuid(cells[tableInfo.snIdx]?.textContent);
  if (netuid == null) {
    return;
  }

  const nameTd = getNameCell(row, tableInfo);
  if (!nameTd) {
    return;
  }

  const data = metrics.get(netuid);
  const taoUsd = taoUsdPrice ?? data?.taoUsd ?? null;
  const feeUsd =
    data?.burnUsd != null
      ? Number(data.burnUsd)
      : (data?.burnTao != null && taoUsd ? Number(data.burnTao) * taoUsd : null);

  const feeText = data ? formatUsd(feeUsd) : '—';
  const burnKnown = isBurnRateKnown(data);
  const burnRate = burnKnown ? getBurnRateFromData(data) : null;
  const burnVisual = getBurnVisualState(data, burnRate);
  const burnDisplay = !data ? '—' : (burnKnown ? formatBurnRate(burnRate) : '—');
  const burnTitle = !data
    ? 'Loading burn rate'
    : burnKnown
      ? (isFullBurnRate(burnRate)
        ? `Burn rate: ${burnDisplay} (full)`
        : `Burn rate: ${burnDisplay}`)
      : 'Burn rate unknown — click sync to load';
  const feeTitle = data
    ? `Registration fee: ${feeUsd != null ? formatUsd(feeUsd) : '—'}`
    : 'Loading registration fee';

  let burnCell = row.querySelector(`.${COLUMN.BURN}`);
  let feeCell = row.querySelector(`.${COLUMN.FEE}`);

  if (!burnCell) {
    burnCell = createBodyCell(
      COLUMN.BURN,
      burnDisplay,
      burnTitle,
      styleRef.refTd,
      COLUMN_WIDTH.burn
    );
    insertAfter(nameTd, burnCell);
  }

  if (burnCell.title !== burnTitle) {
    burnCell.title = burnTitle;
  }

  const cellState = readBurnCellSyncState(burnCell, netuid);
  const isSyncing =
    rowSyncing.has(netuid) || (globalSyncRunning && globalSyncNetuid === netuid);
  const hasSyncUi = Boolean(burnCell.querySelector('.tao-analytics-row-sync-btn'));

  if (
    !hasSyncUi ||
    cellState.display !== burnDisplay ||
    cellState.isSyncing !== isSyncing ||
    cellState.visualState !== burnVisual
  ) {
    burnCell.replaceChildren(buildBurnRateNode(netuid, burnDisplay, isSyncing));
    applyBurnCellVisualState(burnCell, burnVisual);
  }

  if (!feeCell) {
    feeCell = createBodyCell(
      COLUMN.FEE,
      feeText,
      feeTitle,
      styleRef.refTd,
      COLUMN_WIDTH.fee
    );
    insertAfter(burnCell, feeCell);
  } else {
    if (feeCell.textContent !== feeText) {
      feeCell.textContent = feeText;
    }
    if (feeCell.title !== feeTitle) {
      feeCell.title = feeTitle;
    }
    applyColumnWidth(feeCell, COLUMN_WIDTH.fee);
  }
}

function enhanceTable(tableInfo) {
  const header = ensureHeader(tableInfo);
  if (!header) {
    return false;
  }

  const taoUsdPrice = scrapeTaoUsdPrice();
  ensureRowSyncDelegation(tableInfo.table);
  ensureColumnSortDelegation(tableInfo);
  tableInfo.table.querySelectorAll('tbody tr').forEach((row) => {
    enhanceRow(row, tableInfo, header, taoUsdPrice);
  });

  if (columnSortState.key) {
    applyColumnSort(tableInfo);
  }

  attachTableObserver(tableInfo);
  return true;
}

function attachTableObserver(tableInfo) {
  const tbody = tableInfo?.table?.querySelector('tbody');
  if (!tbody) {
    return;
  }

  if (!tableObserver) {
    tableObserver = new MutationObserver(() => {
      if (isEnhancing) {
        return;
      }
      scheduleEnhance();
    });
  }

  if (tbody === observedTbody) {
    return;
  }

  tableObserver.disconnect();
  tableObserver.observe(tbody, { childList: true });
  observedTbody = tbody;
}

function observeDom() {
  const tableInfo = findSubnetTable();
  if (tableInfo) {
    attachTableObserver(tableInfo);
  }
}

function scheduleTableEnhance({ reloadCache = false } = {}) {
  if (reloadCache) {
    pendingCacheReload = true;
  }

  if (enhanceDebounceTimer != null) {
    return;
  }

  enhanceDebounceTimer = setTimeout(async () => {
    enhanceDebounceTimer = null;
    const shouldReload = pendingCacheReload;
    pendingCacheReload = false;

    const tableInfo = findSubnetTable();
    if (!tableInfo) {
      return;
    }

    attachTableObserver(tableInfo);

    if (shouldReload) {
      try {
        await loadMetricsFromLocalCache(tableInfo);
      } catch {
        // Ignore cache read errors.
      }
    }

    isEnhancing = true;
    try {
      enhanceTable(tableInfo);
    } finally {
      isEnhancing = false;
    }
  }, ENHANCE_DEBOUNCE_MS);
}

function scheduleCacheEnhance() {
  scheduleTableEnhance({ reloadCache: true });
}

function scheduleEnhance() {
  scheduleTableEnhance({ reloadCache: false });
}

async function refreshMetricsAndEnhance(force = false) {
  const tableInfo = findSubnetTable();
  if (!tableInfo) {
    return;
  }

  isEnhancing = true;
  try {
    enhanceTable(tableInfo);

    try {
      await loadMetricsFromLocalCache(tableInfo);
      enhanceTable(tableInfo);
    } catch {
      // Ignore cache read errors; we'll still attempt background fetch.
    }
  } finally {
    isEnhancing = false;
  }

  requestMetrics(tableInfo, force)
    .then(() => {
      const latest = findSubnetTable();
      if (!latest) {
        return;
      }
      isEnhancing = true;
      try {
        enhanceTable(latest);
      } finally {
        isEnhancing = false;
      }
    })
    .catch((error) => {
      console.warn('[TAO Subnet Analytics] Failed to load metrics:', error.message);
    });
}

async function init() {
  if (!isExplorerPage() && !isSubnetPage()) {
    return;
  }

  console.info('[TAO Subnet Analytics] Active on', location.href);
  observeDom();

  if (isSubnetPage()) {
    initSubnetPageScrape();
    return;
  }

  // Stop automatic background scraping; sync runs only via toolbar or row buttons.
  sendRuntimeMessage({ type: MESSAGE.STOP_BACKGROUND_TRACKING });

  ensureSyncButton();

  sendRuntimeMessage({ type: MESSAGE.SHEETS_PULL_IF_ENABLED }).catch(() => {});

  await refreshMetricsAndEnhance(false);

  // Repaint immediately when cache changes (subnet visit, sync, or background tracker).
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes?.[STORAGE_CACHE_KEY]) {
      scheduleCacheEnhance();
    }

    if (changes?.[SYNC_STATUS_KEY]) {
      applySyncStatus(changes[SYNC_STATUS_KEY].newValue);
      scheduleTableEnhance();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE.METRICS_REFRESH) {
      scheduleCacheEnhance();
    }
  });

  let attempts = 0;
  const bootstrap = setInterval(async () => {
    attempts += 1;
    ensureSyncButton();
    await refreshMetricsAndEnhance(false);

    const tableInfo = findSubnetTable();
    const hasColumns = tableInfo?.table.querySelector(`.${COLUMN.BURN}`);
    if (attempts >= 40 || hasColumns) {
      clearInterval(bootstrap);
      if (!hasColumns) {
        console.warn('[TAO Subnet Analytics] Subnet table not found yet. Scroll to the Subnets section.');
      }
    }
  }, 1500);

  setInterval(() => {
    refreshMetricsAndEnhance(false);
  }, 60 * 1000);
}

function initSubnetPageScrape() {
  const netuid = getNetuidFromPath();
  if (netuid == null) {
    return;
  }

  let lastOwnerIncentive = null;
  const lastRegSignatureRef = { value: null };
  let lastHref = location.href;
  let scrapeReadyTimer = null;
  let contextWatch = null;
  let observer = null;
  let urlWatcher = null;
  let burst = null;

  const teardownSubnetScrape = () => {
    if (scrapeReadyTimer != null) {
      clearTimeout(scrapeReadyTimer);
      scrapeReadyTimer = null;
    }
    if (contextWatch != null) {
      clearInterval(contextWatch);
      contextWatch = null;
    }
    if (urlWatcher != null) {
      clearInterval(urlWatcher);
      urlWatcher = null;
    }
    if (burst != null) {
      clearInterval(burst);
      burst = null;
    }
    observer?.disconnect();
    observer = null;
  };

  const notifyScrapeReady = () => {
    if (!isExtensionContextValid()) {
      teardownSubnetScrape();
      return;
    }

    if (scrapeReadyTimer != null) {
      clearTimeout(scrapeReadyTimer);
    }

    scrapeReadyTimer = setTimeout(() => {
      scrapeReadyTimer = null;
      if (!isExtensionContextValid()) {
        teardownSubnetScrape();
        return;
      }

      sendRuntimeMessage({
        type: MESSAGE.SCRAPE_PAGE_READY,
        netuid,
        href: location.href,
      });
    }, 400);
  };

  const scrapeOwnerIncentive = async () => {
    const ownerIncentive = collectOwnerIncentiveFromDom();
    if (ownerIncentive == null) {
      return false;
    }

    if (ownerIncentive === lastOwnerIncentive) {
      return true;
    }

    lastOwnerIncentive = ownerIncentive;
    await upsertMetricCache(netuid, {
      ownerIncentive,
      ownerIncentiveCapturedAt: Date.now(),
      source: 'dom',
    });
    return true;
  };

  const scrapeRegFee = async () => {
    // tao.app PARAMETERS panel: label + value in a flex row (label has info button).
    const rows = document.querySelectorAll('div.flex.items-center.justify-between');
    for (const row of rows) {
      const children = [...row.children];
      if (children.length < 2) {
        continue;
      }

      const labelText = normalizeText(children[0]?.textContent ?? '');
      if (!matchesRegCostLabel(labelText)) {
        continue;
      }

      const valueEl =
        row.querySelector(':scope > .font-bold') ||
        row.querySelector(':scope > .text-sm.font-bold') ||
        children[children.length - 1];
      const valueText = normalizeText(valueEl?.textContent ?? '');
      if (await upsertRegFeePatch(netuid, valueText, lastRegSignatureRef)) {
        return true;
      }
    }

    // Fallback: older about-tab layout with leaf label nodes.
    const labelCandidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (el.children.length > 0) {
        return false;
      }
      return matchesRegCostLabel(el.textContent);
    });

    for (const labelEl of labelCandidates.slice(0, 10)) {
      const row = labelEl.closest('.flex.items-center.justify-between') || labelEl.parentElement;
      if (!row) {
        continue;
      }

      const valueEl =
        row.querySelector('.font-bold') ||
        row.querySelector('.text-sm.font-bold') ||
        row.lastElementChild;
      const valueText = normalizeText(valueEl?.textContent ?? '');
      if (await upsertRegFeePatch(netuid, valueText, lastRegSignatureRef)) {
        return true;
      }
    }

    return false;
  };

  const tryScrape = async () => {
    if (!isExtensionContextValid()) {
      teardownSubnetScrape();
      return;
    }

    const activeTab = getActiveSubnetTab();
    let scraped = false;

    if (activeTab === 'metagraph') {
      scraped = (await scrapeOwnerIncentive()) || scraped;
      if (scraped || isMetagraphBurnPageReady()) {
        notifyScrapeReady();
      }
      return;
    }

    if (isAboutSubnetTab()) {
      scraped = (await scrapeRegFee()) || scraped;
      if (scraped) {
        notifyScrapeReady();
      }
    }
  };

  tryScrape();

  observer = new MutationObserver(() => {
    if (!isExtensionContextValid()) {
      teardownSubnetScrape();
      return;
    }
    tryScrape();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // SPA tab switches update ?active_tab= without always mutating watched nodes.
  urlWatcher = setInterval(() => {
    if (!isExtensionContextValid()) {
      teardownSubnetScrape();
      return;
    }

    if (location.href === lastHref) {
      return;
    }

    lastHref = location.href;
    lastOwnerIncentive = null;
    lastRegSignatureRef.value = null;
    tryScrape();
  }, 400);

  // Fast burst while the page hydrates.
  let burstAttempts = 0;
  burst = setInterval(() => {
    if (!isExtensionContextValid()) {
      teardownSubnetScrape();
      return;
    }

    burstAttempts += 1;
    tryScrape();
    if (burstAttempts >= 30) {
      clearInterval(burst);
    }
  }, 500);

  contextWatch = setInterval(() => {
    if (!isExtensionContextValid()) {
      teardownSubnetScrape();
    }
  }, 1500);

  window.addEventListener('beforeunload', teardownSubnetScrape);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
