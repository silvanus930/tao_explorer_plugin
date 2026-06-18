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
  REQUEST_EXPLORER_REFRESH: 'REQUEST_EXPLORER_REFRESH',
  SHEETS_PUSH: 'SHEETS_PUSH',
  SHEETS_PULL: 'SHEETS_PULL',
  SHEETS_SYNC: 'SHEETS_SYNC',
  SHEETS_CREATE: 'SHEETS_CREATE',
  SHEETS_PULL_IF_ENABLED: 'SHEETS_PULL_IF_ENABLED',
};

const COLUMN = {
  BURN: 'tao-analytics-burn',
  FEE: 'tao-analytics-fee',
  MINERS: 'tao-analytics-miners',
};

const COLUMN_WIDTH = {
  burn: 96,
  fee: 88,
};

const COLUMN_WIDTH_MINERS_EXPANDED = 200;
const MINERS_EMISSIONS_PREF_KEY = 'showMinerEmissions';
const HIDE_SUBNET_TRADING_VIEW_KEY = 'hideSubnetTradingView';
const METagraph_SCRAPE_DEBUG_KEY = 'metagraphScrapeDebug';

const MINER_COUNT_DISPLAY_CAP = 40;
const SUBNET_NETUID_MAX = 128;

const STORAGE_CACHE_KEY = 'subnetMetricsCache';
const SYNC_STATUS_KEY = 'subnetSyncStatus';
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

let metrics = new Map();
let tableObserver = null;
let observedTbody = null;
let isEnhancing = false;
let isSorting = false;
let enhanceDebounceTimer = null;
let pendingCacheReload = false;
const ENHANCE_DEBOUNCE_MS = 120;
const ENHANCE_IMMEDIATE_MS = 0;
const rowSyncing = new Set();
let globalSyncRunning = false;
let globalSyncNetuid = null;
let headerSortObserver = null;
let observedSortThead = null;
let columnSortState = { key: null, direction: null };
let columnDragState = null;
let columnOrderObserver = null;
let observedColumnOrderRow = null;
let showMinerEmissions = false;
let hideSubnetTradingView = false;
let metagraphScrapeDebug = false;
let metagraphDebugModalHost = null;
let lastMetagraphDebugSignature = null;
let lastAboutDebugSignature = null;
let tradingViewHideObserver = null;
let tradingViewHideUrlWatch = null;
let tradingViewHideTimer = null;

const ANALYTICS_COLUMN_CLASSES = [COLUMN.BURN, COLUMN.FEE, COLUMN.MINERS];

function isAnalyticsSortHeader(th) {
  return Boolean(
    th &&
    (th.classList.contains(COLUMN.BURN) ||
      th.classList.contains(COLUMN.FEE) ||
      th.classList.contains(COLUMN.MINERS)) &&
    th.dataset.taoAnalyticsSort
  );
}

function resetAnalyticsSortHeaderUi(tableInfo) {
  const headerRow = tableInfo?.table?.querySelector('thead tr');
  if (!headerRow) {
    return;
  }

  const { refTh } = getStyleReference(tableInfo);
  if (!refTh) {
    return;
  }

  const burnHeader = headerRow.querySelector(`.${COLUMN.BURN}`);
  const feeHeader = headerRow.querySelector(`.${COLUMN.FEE}`);
  const minersHeader = headerRow.querySelector(`.${COLUMN.MINERS}`);

  if (burnHeader && refTh) {
    burnHeader.dataset.taoAnalyticsSort = 'burn';
    burnHeader.replaceChildren(...buildSortableHeaderContent('Burn Rate', refTh));
    ensureMoveButtonOnHeader(burnHeader, refTh);
    wrapAnalyticsHeaderContent(burnHeader);
    burnHeader.removeAttribute('aria-sort');
  }

  if (feeHeader && refTh) {
    feeHeader.dataset.taoAnalyticsSort = 'fee';
    feeHeader.replaceChildren(...buildSortableHeaderContent('Reg. Fee', refTh));
    ensureMoveButtonOnHeader(feeHeader, refTh);
    wrapAnalyticsHeaderContent(feeHeader);
    feeHeader.removeAttribute('aria-sort');
  }

  if (minersHeader && refTh) {
    minersHeader.dataset.taoAnalyticsSort = 'miners';
    minersHeader.replaceChildren(...buildSortableHeaderContent('Miners', refTh));
    ensureMoveButtonOnHeader(minersHeader, refTh);
    wrapAnalyticsHeaderContent(minersHeader);
    minersHeader.removeAttribute('aria-sort');
  }
}

function clearAnalyticsColumnSort(tableInfo) {
  columnSortState = { key: null, direction: null };
  if (tableInfo) {
    resetAnalyticsSortHeaderUi(tableInfo);
  }
}

function attachNativeSortObserver(tableInfo) {
  const thead = tableInfo?.table?.querySelector('thead');
  if (!thead) {
    return;
  }

  if (!headerSortObserver) {
    headerSortObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes' || mutation.attributeName !== 'aria-sort') {
          continue;
        }

        const th = mutation.target;
        if (!(th instanceof Element) || th.tagName !== 'TH') {
          continue;
        }

        if (isAnalyticsSortHeader(th)) {
          continue;
        }

        const sortValue = th.getAttribute('aria-sort');
        if (!sortValue || sortValue === 'none') {
          continue;
        }

        clearAnalyticsColumnSort(findSubnetTable());
        return;
      }
    });
  }

  if (thead === observedSortThead) {
    return;
  }

  headerSortObserver.disconnect();
  headerSortObserver.observe(thead, {
    attributes: true,
    subtree: true,
    attributeFilter: ['aria-sort'],
  });
  observedSortThead = thead;
}

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

async function getSyncStorage(keys) {
  if (!isExtensionContextValid()) {
    return {};
  }
  try {
    return await chrome.storage.sync.get(keys);
  } catch {
    return {};
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
  return Number.isInteger(netuid) && netuid >= 0 && netuid <= SUBNET_NETUID_MAX ? netuid : null;
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
  return netuid >= 0 && netuid <= SUBNET_NETUID_MAX ? netuid : null;
}

function parseMinerUid(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/^(\d+)$/);
  if (!match) {
    return null;
  }

  const uid = Number(match[1]);
  return Number.isInteger(uid) && uid >= 0 && uid <= 65535 ? uid : null;
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

function isRegFeeKnown(data) {
  return Boolean(
    data &&
      (data.burnTao != null ||
        (data.burnUsd != null && Number.isFinite(Number(data.burnUsd))))
  );
}

function formatRegFeeDisplay(data, taoUsd) {
  if (!data) {
    return { text: '—', title: 'Loading registration fee' };
  }

  if (data.burnUsd != null && Number.isFinite(Number(data.burnUsd))) {
    const usd = Number(data.burnUsd);
    return {
      text: formatUsd(usd),
      title: `Registration fee: ${formatUsd(usd)}`,
    };
  }

  const price = taoUsd ?? data.taoUsd ?? null;
  if (data.burnTao != null && price) {
    const usd = Number(data.burnTao) * price;
    return {
      text: formatUsd(usd),
      title: `Registration fee: ${formatUsd(usd)}`,
    };
  }

  if (data.burnTao != null && Number.isFinite(Number(data.burnTao))) {
    const text = `${formatTaoDisplay(Number(data.burnTao))} τ`;
    return {
      text,
      title: `Registration fee: ${text}`,
    };
  }

  return {
    text: '—',
    title: 'Registration fee unknown — click sync to load',
  };
}

function isMinersCountKnown(data) {
  const count = Number(data?.incentiveMinerCount);
  return Number.isInteger(count) && count >= 0;
}

function needsSyncPriority(data) {
  return !isBurnRateKnown(data) || !isRegFeeKnown(data) || !isMinersCountKnown(data);
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

  const priority = [];
  const complete = [];

  netuids.forEach((netuid) => {
    const data = metrics.get(netuid);
    if (needsSyncPriority(data)) {
      priority.push(netuid);
    } else {
      complete.push(netuid);
    }
  });

  priority.sort((a, b) => a - b);
  complete.sort((a, b) => a - b);

  return [...priority, ...complete];
}

function getMinersColumnWidth() {
  return showMinerEmissions ? COLUMN_WIDTH_MINERS_EXPANDED : COLUMN_WIDTH.fee;
}

function shouldShowMinerEmissions() {
  return showMinerEmissions;
}

async function loadMinerEmissionsPreference() {
  const stored = await getLocalStorage(MINERS_EMISSIONS_PREF_KEY);
  showMinerEmissions = Boolean(stored?.[MINERS_EMISSIONS_PREF_KEY]);
  document.documentElement.dataset.taoAnalyticsMinerEmissions = showMinerEmissions ? 'on' : 'off';
}

async function setMinerEmissionsVisible(enabled) {
  showMinerEmissions = Boolean(enabled);
  document.documentElement.dataset.taoAnalyticsMinerEmissions = showMinerEmissions ? 'on' : 'off';
  await setLocalStorage({ [MINERS_EMISSIONS_PREF_KEY]: showMinerEmissions });
  syncMinerEmissionsToggleUi();
  applyMinersColumnWidth();
  scheduleTableEnhance();
}

function findActiveOnlyContainer() {
  const switchBtn = document.getElementById('desktop-active-only');
  if (switchBtn?.parentElement instanceof HTMLElement) {
    return switchBtn.parentElement;
  }

  for (const label of document.querySelectorAll('label[data-slot="label"], label')) {
    if (normalizeText(label.textContent) !== 'Active Only') {
      continue;
    }

    const container = label.parentElement;
    if (container?.querySelector('[role="switch"]')) {
      return container;
    }
  }

  for (const switchEl of document.querySelectorAll('[role="switch"]')) {
    const container = switchEl.parentElement;
    if (container && /active only/i.test(container.textContent)) {
      return container;
    }
  }

  return null;
}

function applyMinerEmissionsSwitchState(switchBtn, checked) {
  if (!switchBtn) {
    return;
  }

  const state = checked ? 'checked' : 'unchecked';
  switchBtn.setAttribute('aria-checked', checked ? 'true' : 'false');
  switchBtn.dataset.state = state;
  switchBtn.value = checked ? 'on' : 'off';

  const thumb = switchBtn.querySelector('span');
  if (thumb) {
    thumb.dataset.state = state;
  }
}

function syncMinerEmissionsToggleUi() {
  const switchBtn = document.getElementById('tao-analytics-miner-emissions-switch');
  applyMinerEmissionsSwitchState(switchBtn, showMinerEmissions);
}

function buildMinerEmissionsToggle() {
  const activeOnlyContainer = findActiveOnlyContainer();
  const refLabel = activeOnlyContainer?.querySelector('label[data-slot="label"], label');
  const refSwitch = activeOnlyContainer?.querySelector('[role="switch"]');
  const refThumb = refSwitch?.querySelector('span');

  const wrapper = document.createElement('div');
  wrapper.id = 'tao-analytics-miner-emissions-toggle';
  wrapper.className = activeOnlyContainer?.className || 'ml-4 flex items-center gap-2';

  const label = document.createElement('label');
  label.dataset.slot = 'label';
  label.htmlFor = 'tao-analytics-miner-emissions-switch';
  label.className =
    refLabel?.className ||
    'flex items-center gap-2 font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 text-muted-foreground cursor-pointer text-[11px]';
  label.textContent = 'Miner Emissions';

  const switchBtn = document.createElement('button');
  switchBtn.type = 'button';
  switchBtn.id = 'tao-analytics-miner-emissions-switch';
  switchBtn.setAttribute('role', 'switch');
  switchBtn.className =
    refSwitch?.className ||
    'peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  switchBtn.title = 'Show top 3 miner emissions in the Miners column';

  const thumb = document.createElement('span');
  thumb.className =
    refThumb?.className ||
    'bg-background pointer-events-none block h-5 w-5 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0';
  switchBtn.appendChild(thumb);

  const toggleMinerEmissions = (event) => {
    event.preventDefault();
    event.stopPropagation();
    void setMinerEmissionsVisible(!showMinerEmissions);
  };

  switchBtn.addEventListener('click', toggleMinerEmissions);

  wrapper.append(label, switchBtn);
  syncMinerEmissionsToggleUi();
  return wrapper;
}

function ensureMinerEmissionsToggle() {
  const activeOnlyContainer = findActiveOnlyContainer();
  if (!activeOnlyContainer?.parentElement) {
    return;
  }

  let toggle = document.getElementById('tao-analytics-miner-emissions-toggle');
  if (!toggle) {
    toggle = buildMinerEmissionsToggle();
    activeOnlyContainer.parentElement.insertBefore(toggle, activeOnlyContainer.nextSibling);
    return;
  }

  syncMinerEmissionsToggleUi();
}

function applyMinersColumnWidth() {
  const tableInfo = findSubnetTable();
  if (!tableInfo) {
    return;
  }

  syncAnalyticsColumnWidths(tableInfo);
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
    'Sync all subnets: missing burn rate, reg fee, or miners first, then the rest';

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
      'Sync all subnets: missing burn rate, reg fee, or miners first, then the rest';

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
        scheduleCacheEnhance({ immediate: true });
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

  rowSyncing.add(netuid);
  updateRowSyncIndicator(netuid, true);

  try {
    const stored = await getLocalStorage(SYNC_STATUS_KEY);
    if (stored?.[SYNC_STATUS_KEY]?.running) {
      console.warn('[TAO Subnet Analytics] Sync already in progress');
      return;
    }

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
    updateRowSyncIndicator(netuid, false);
    scheduleCacheEnhance({ immediate: true });
  }
}

function updateRowSyncIndicator(netuid, isSyncing) {
  const tableInfo = findSubnetTable();
  if (!tableInfo) {
    return;
  }

  for (const row of tableInfo.table.querySelectorAll('tbody tr')) {
    const cells = row.querySelectorAll('td');
    const rowNetuid = parseNetuid(cells[tableInfo.snIdx]?.textContent);
    if (rowNetuid !== netuid) {
      continue;
    }

    const btn = row.querySelector(`.${COLUMN.BURN} .tao-analytics-row-sync-btn`);
    if (!btn) {
      return;
    }

    btn.disabled = isSyncing;
    btn.classList.toggle('tao-analytics-sync-running', isSyncing);
    return;
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

  if (!response || typeof response !== 'object') {
    return;
  }

  Object.entries(response).forEach(([netuid, value]) => {
    if (value && typeof value === 'object') {
      const id = Number(netuid);
      const existing = metrics.get(id);
      metrics.set(
        id,
        existing && typeof existing === 'object' ? mergeCacheEntry(existing, value) : value
      );
    }
  });
}

function applyLiveMetricsUpdate(netuid, entry) {
  if (netuid == null || !entry || typeof entry !== 'object') {
    return;
  }

  const id = Number(netuid);
  const existing = metrics.get(id);
  metrics.set(
    id,
    existing && typeof existing === 'object' ? mergeCacheEntry(existing, entry) : { ...entry, netuid: id }
  );
}

function handleMetricsRefreshMessage(message) {
  if (message?.netuid != null && message?.entry && typeof message.entry === 'object') {
    applyLiveMetricsUpdate(Number(message.netuid), message.entry);
    scheduleTableEnhance({ reloadCache: false, delayMs: 0 });
    return;
  }

  scheduleCacheEnhance({ immediate: true });
}

function requestExplorerRefresh() {
  sendRuntimeMessage({ type: MESSAGE.REQUEST_EXPLORER_REFRESH }).catch(() => {});
}

async function upsertMetricCache(netuid, patch) {
  if (!isExtensionContextValid()) {
    return { ok: false, reason: 'invalid_context' };
  }

  const normalizedNetuid = Number(netuid);
  const normalizedPatch = {
    ...patch,
    netuid: normalizedNetuid,
    updatedAt: Date.now(),
  };

  const response = await sendRuntimeMessage({
    type: MESSAGE.UPSERT_METRIC,
    netuid: normalizedNetuid,
    patch: normalizedPatch,
  });

  if (response?.ok) {
    const entry =
      response.entry && typeof response.entry === 'object'
        ? { ...response.entry, netuid: normalizedNetuid }
        : mergeCacheEntry(metrics.get(normalizedNetuid), normalizedPatch);
    metrics.set(normalizedNetuid, entry);
    if (isExplorerPage()) {
      scheduleTableEnhance({ reloadCache: false, delayMs: 0 });
    } else {
      requestExplorerRefresh();
    }
    return { ok: true, entry };
  }

  try {
    const stored = await getLocalStorage(STORAGE_CACHE_KEY);
    const entry = stored?.[STORAGE_CACHE_KEY] ?? null;
    const value =
      entry?.value && typeof entry.value === 'object' ? { ...entry.value } : {};
    const key = String(normalizedNetuid);
    const current =
      value[key] && typeof value[key] === 'object'
        ? value[key]
        : { netuid: normalizedNetuid };

    const mergedEntry = mergeCacheEntry(current, normalizedPatch);

    value[key] = mergedEntry;

    await setLocalStorage({
      [STORAGE_CACHE_KEY]: {
        timestamp: Date.now(),
        ttl: entry?.ttl ?? DEFAULT_CACHE_TTL_MS,
        value,
      },
    });

    metrics.set(normalizedNetuid, mergedEntry);
    requestExplorerRefresh();
    return { ok: true, entry: mergedEntry, source: 'local' };
  } catch {
    return { ok: false, reason: 'storage_error' };
  }
}

function mergeCacheEntry(existing, incoming) {
  const base =
    existing && typeof existing === 'object'
      ? existing
      : { netuid: Number(incoming?.netuid ?? 0) };
  const patch = incoming && typeof incoming === 'object' ? incoming : {};
  const netuid = Number(patch.netuid ?? base.netuid ?? 0);
  const stamps = [
    base.updatedAt,
    patch.updatedAt,
    base.domCapturedAt,
    patch.domCapturedAt,
    base.rpcCapturedAt,
    patch.rpcCapturedAt,
    base.ownerIncentiveCapturedAt,
    patch.ownerIncentiveCapturedAt,
    base.incentiveMinerCountCapturedAt,
    patch.incentiveMinerCountCapturedAt,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    ...base,
    ...patch,
    netuid,
    updatedAt: stamps.length > 0 ? Math.max(...stamps) : Date.now(),
  };
}

async function loadMetricsFromLocalCache(tableInfo) {
  const netuids = collectVisibleNetuids(tableInfo);
  if (netuids.length === 0) {
    return;
  }

  const stored = await getLocalStorage(STORAGE_CACHE_KEY);
  const entry = stored?.[STORAGE_CACHE_KEY] ?? null;
  const value = entry?.value && typeof entry.value === 'object' ? entry.value : {};

  netuids.forEach((netuid) => {
    const cached =
      value[String(netuid)] ??
      value[netuid] ??
      null;
    if (cached && typeof cached === 'object') {
      const id = Number(netuid);
      const existing = metrics.get(id);
      metrics.set(
        id,
        existing && typeof existing === 'object'
          ? mergeCacheEntry(existing, { ...cached, netuid: id })
          : { ...cached, netuid: id }
      );
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMetagraphScrapePageReady() {
  if (!isMetagraphTabActive()) {
    return false;
  }

  const tableInfo = findMetagraphTable();
  if (tableInfo) {
    return isMetagraphIncentiveSortedDesc(tableInfo);
  }

  return Boolean(document.querySelector('[aria-label="Owner incentive"]'));
}

function isAboutScrapePageReady() {
  if (!isAboutSubnetTab()) {
    return false;
  }

  const rows = document.querySelectorAll('div.flex.items-center.justify-between');
  for (const row of rows) {
    const labelText = normalizeText(row.children[0]?.textContent ?? '');
    if (matchesRegCostLabel(labelText)) {
      return true;
    }
  }

  return false;
}

function isMetagraphBurnPageReady() {
  return isMetagraphScrapePageReady();
}

function findMetagraphTable() {
  if (!isMetagraphTabActive()) {
    return null;
  }

  const panel = findMetagraphTabPanel();
  const scope = panel instanceof HTMLElement ? panel : document;

  for (const table of scope.querySelectorAll('table')) {
    const headerCells = [...table.querySelectorAll('thead th')];
    if (headerCells.length < 4) {
      continue;
    }

    const headers = headerCells.map((cell) => normalizeText(cell.textContent));
    const uidIdx = headers.findIndex((label) => label === 'UID');
    const incentiveIdx = headers.findIndex((label) => /^incentive$/i.test(label));
    const emissionIdx = headers.findIndex((label) => /^emission$/i.test(label));

    if (uidIdx >= 0 && incentiveIdx >= 0) {
      return { table, headers, uidIdx, incentiveIdx, emissionIdx };
    }
  }

  return null;
}

function collectMetagraphTableSampleRows(limit = 8) {
  const tableInfo = findMetagraphTable();
  if (!tableInfo) {
    return [];
  }

  const rows = [];
  for (const row of tableInfo.table.querySelectorAll('tbody tr')) {
    if (rows.length >= limit) {
      break;
    }

    const cells = [...row.querySelectorAll('td')];
    const incentiveCell = cells[tableInfo.incentiveIdx];
    const emissionCell = tableInfo.emissionIdx >= 0 ? cells[tableInfo.emissionIdx] : null;
    const uidCell = tableInfo.uidIdx >= 0 ? cells[tableInfo.uidIdx] : null;

    rows.push({
      uid: normalizeText(uidCell?.textContent ?? ''),
      incentive: parseIncentiveCellValue(incentiveCell?.textContent ?? ''),
      incentiveText: normalizeText(incentiveCell?.textContent ?? ''),
      emission: normalizeText(emissionCell?.textContent ?? ''),
      isOwner: isMetagraphOwnerMinerRow(row, tableInfo),
      hasFlame: Boolean(
        incentiveCell?.querySelector('svg.lucide-flame, [class*="flame"]') ||
          isOrangeBurnElement(incentiveCell)
      ),
    });
  }

  return rows;
}

async function resolveCacheEntryForNetuid(netuid) {
  const id = Number(netuid);
  const cached = metrics.get(id);
  if (cached && typeof cached === 'object') {
    return { ...cached, netuid: id };
  }

  try {
    const stored = await getLocalStorage(STORAGE_CACHE_KEY);
    const root = stored?.[STORAGE_CACHE_KEY]?.value;
    if (root && typeof root === 'object') {
      const entry = root[String(id)] ?? root[id];
      if (entry && typeof entry === 'object') {
        const normalized = { ...entry, netuid: id };
        metrics.set(id, normalized);
        return normalized;
      }
    }
  } catch {
    // Ignore cache read errors in debug path.
  }

  return null;
}

function formatCacheStatus(status) {
  switch (status) {
    case 'updated':
      return 'Updated';
    case 'unchanged':
      return 'Skipped (unchanged)';
    case 'failed':
      return 'Failed';
    case 'missing':
      return 'Not scraped';
    default:
      return status || '—';
  }
}

function deriveOverallCacheStatus(scrapeDetails = {}) {
  const statuses = [scrapeDetails.ownerCacheStatus, scrapeDetails.minersCacheStatus].filter(Boolean);
  if (statuses.length === 0) {
    return scrapeDetails.cacheEntry ? 'unchanged' : 'missing';
  }
  if (statuses.some((status) => status === 'updated')) {
    return 'updated';
  }
  if (statuses.some((status) => status === 'failed')) {
    return 'failed';
  }
  if (statuses.every((status) => status === 'unchanged')) {
    return 'unchanged';
  }
  return 'unknown';
}

function buildMetagraphScrapeDebugSnapshot(netuid, scrapeDetails = {}) {
  const tableInfo = findMetagraphTable();
  const cacheEntry = scrapeDetails.cacheEntry ?? metrics.get(Number(netuid)) ?? null;
  const overallCacheStatus =
    scrapeDetails.overallCacheStatus ?? deriveOverallCacheStatus({ ...scrapeDetails, cacheEntry });

  return {
    netuid: Number(netuid),
    href: location.href,
    tab: getEffectiveActiveSubnetTab(),
    scrapedAt: new Date().toISOString(),
    pageReady: isMetagraphScrapePageReady(),
    tableFound: Boolean(tableInfo),
    incentiveSortedDesc: tableInfo ? isMetagraphIncentiveSortedDesc(tableInfo) : false,
    ownerIncentive: scrapeDetails.ownerIncentive ?? collectOwnerIncentiveFromDom(),
    ownerCacheStatus: scrapeDetails.ownerCacheStatus ?? 'unknown',
    minerCount: scrapeDetails.minerCount ?? null,
    topMinerEmissions: scrapeDetails.topEmissions ?? null,
    minersCacheStatus: scrapeDetails.minersCacheStatus ?? 'unknown',
    overallCacheStatus,
    cacheUpdatedAt: cacheEntry?.updatedAt ?? null,
    tableSample: collectMetagraphTableSampleRows(8),
    cacheEntry,
    diagnostics: scrapeDetails.diagnostics ?? {},
  };
}

function formatDebugValue(value) {
  if (value == null) {
    return '—';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '—';
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : '—';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function hideMetagraphScrapeDebugModal() {
  metagraphDebugModalHost?.remove();
  metagraphDebugModalHost = null;
  document.documentElement.classList.remove('tao-analytics-debug-modal-open');
}

function showMetagraphScrapeDebugModal(snapshot) {
  if (!metagraphScrapeDebug || document.visibilityState === 'hidden') {
    return;
  }

  hideMetagraphScrapeDebugModal();

  const host = document.createElement('div');
  host.className = 'tao-analytics-debug-modal-host';
  host.innerHTML = `
    <div class="tao-analytics-debug-modal-backdrop" data-close="1"></div>
    <div class="tao-analytics-debug-modal" role="dialog" aria-labelledby="tao-analytics-debug-title">
      <div class="tao-analytics-debug-modal-header">
        <div>
          <p class="tao-analytics-debug-eyebrow">Metagraph scrape debug</p>
          <h2 id="tao-analytics-debug-title">Subnet ${snapshot.netuid} scrape succeeded</h2>
        </div>
        <button type="button" class="tao-analytics-debug-close" aria-label="Close">×</button>
      </div>
      <div class="tao-analytics-debug-modal-body">
        <div class="tao-analytics-debug-grid">
          <div class="tao-analytics-debug-card">
            <h3>Burn rate</h3>
            <p class="tao-analytics-debug-value">${formatBurnRate(getBurnRateFromData({ ownerIncentive: snapshot.ownerIncentive }))}</p>
            <p class="tao-analytics-debug-meta">ownerIncentive: ${formatDebugValue(snapshot.ownerIncentive)}</p>
            <p class="tao-analytics-debug-meta">Cache: ${formatCacheStatus(snapshot.ownerCacheStatus)}</p>
          </div>
          <div class="tao-analytics-debug-card">
            <h3>Miners</h3>
            <p class="tao-analytics-debug-value">${formatDebugValue(snapshot.minerCount)}</p>
            <p class="tao-analytics-debug-meta">Top emissions: ${formatDebugValue(snapshot.topMinerEmissions)}</p>
            <p class="tao-analytics-debug-meta">Count excludes owner row</p>
            <p class="tao-analytics-debug-meta">Cache: ${formatCacheStatus(snapshot.minersCacheStatus)}</p>
          </div>
          <div class="tao-analytics-debug-card">
            <h3>Cache</h3>
            <p class="tao-analytics-debug-value tao-analytics-debug-cache-${snapshot.overallCacheStatus}">${formatCacheStatus(snapshot.overallCacheStatus)}</p>
            <p class="tao-analytics-debug-meta">Entry present: ${snapshot.cacheEntry ? 'yes' : 'no'}</p>
            <p class="tao-analytics-debug-meta">updatedAt: ${snapshot.cacheUpdatedAt ? new Date(snapshot.cacheUpdatedAt).toLocaleString() : '—'}</p>
          </div>
          <div class="tao-analytics-debug-card">
            <h3>Page state</h3>
            <p class="tao-analytics-debug-meta">Table: ${snapshot.tableFound ? 'found' : 'missing'}</p>
            <p class="tao-analytics-debug-meta">Incentive sorted ↓: ${snapshot.incentiveSortedDesc ? 'yes' : 'no'}</p>
            <p class="tao-analytics-debug-meta">Page ready: ${snapshot.pageReady ? 'yes' : 'no'}</p>
          </div>
        </div>
        <div class="tao-analytics-debug-section">
          <div class="tao-analytics-debug-section-head">
            <h3>Incentive table sample</h3>
            <span class="tao-analytics-debug-chip">${snapshot.tableSample.length} rows</span>
          </div>
          <div class="tao-analytics-debug-table-wrap">
            <table class="tao-analytics-debug-table">
              <thead>
                <tr>
                  <th>UID</th>
                  <th>Incentive</th>
                  <th>Emission</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                ${snapshot.tableSample
                  .map(
                    (row) => `
                  <tr class="${row.isOwner ? 'is-owner' : ''}">
                    <td>${row.uid || '—'}</td>
                    <td class="${row.hasFlame ? 'has-flame' : ''}">${row.incentiveText || formatDebugValue(row.incentive)}</td>
                    <td>${row.emission || '—'}</td>
                    <td>${row.isOwner ? 'yes' : 'no'}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
        <details class="tao-analytics-debug-details">
          <summary>Raw cache entry &amp; JSON</summary>
          <pre class="tao-analytics-debug-pre">${formatDebugValue(snapshot.cacheEntry)}</pre>
        </details>
        <details class="tao-analytics-debug-details">
          <summary>Full debug snapshot</summary>
          <pre class="tao-analytics-debug-pre">${formatDebugValue(snapshot)}</pre>
        </details>
      </div>
      <div class="tao-analytics-debug-modal-footer">
        <button type="button" class="tao-analytics-debug-btn" data-copy="1">Copy JSON</button>
        <button type="button" class="tao-analytics-debug-btn tao-analytics-debug-btn-primary" data-close="1">Close</button>
      </div>
    </div>
  `;

  host.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', hideMetagraphScrapeDebugModal);
  });

  host.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
    } catch {
      // Ignore clipboard failures.
    }
  });

  document.documentElement.classList.add('tao-analytics-debug-modal-open');
  document.body.appendChild(host);
  metagraphDebugModalHost = host;
}

function maybeShowMetagraphScrapeDebugModal(netuid, scrapeDetails) {
  if (!metagraphScrapeDebug) {
    return;
  }

  const signature = [
    scrapeDetails.ownerIncentive,
    scrapeDetails.minerCount,
    (scrapeDetails.topEmissions || []).join(','),
    scrapeDetails.overallCacheStatus,
    scrapeDetails.cacheEntry?.updatedAt ?? '',
  ].join('|');

  if (signature === lastMetagraphDebugSignature) {
    return;
  }

  lastMetagraphDebugSignature = signature;
  showMetagraphScrapeDebugModal(buildMetagraphScrapeDebugSnapshot(netuid, scrapeDetails));
}

function buildAboutScrapeDebugSnapshot(netuid, scrapeDetails = {}) {
  const cacheEntry = scrapeDetails.cacheEntry ?? null;
  const feeData = cacheEntry ?? {
    burnTao: scrapeDetails.burnTao,
    burnUsd: scrapeDetails.burnUsd,
    taoUsd: scrapeDetails.taoUsd,
  };
  const regDisplay = formatRegFeeDisplay(feeData, scrapeDetails.taoUsd ?? cacheEntry?.taoUsd);

  return {
    netuid: Number(netuid),
    href: location.href,
    tab: 'about',
    scrapedAt: new Date().toISOString(),
    pageReady: isAboutScrapePageReady(),
    labelFound: Boolean(scrapeDetails.labelFound),
    valueText: scrapeDetails.valueText ?? null,
    burnTao: scrapeDetails.burnTao ?? cacheEntry?.burnTao ?? null,
    burnUsd: scrapeDetails.burnUsd ?? cacheEntry?.burnUsd ?? null,
    taoUsd: scrapeDetails.taoUsd ?? cacheEntry?.taoUsd ?? null,
    regFeeDisplay: regDisplay.text,
    regFeeTitle: regDisplay.title,
    regCacheStatus: scrapeDetails.regCacheStatus ?? 'unknown',
    cacheEntry,
    cacheUpdatedAt: cacheEntry?.updatedAt ?? null,
    source: scrapeDetails.source ?? null,
    diagnostics: scrapeDetails.diagnostics ?? {},
  };
}

function showAboutScrapeDebugModal(snapshot) {
  if (!metagraphScrapeDebug || document.visibilityState === 'hidden') {
    return;
  }

  hideMetagraphScrapeDebugModal();

  const host = document.createElement('div');
  host.className = 'tao-analytics-debug-modal-host';
  host.innerHTML = `
    <div class="tao-analytics-debug-modal-backdrop" data-close="1"></div>
    <div class="tao-analytics-debug-modal" role="dialog" aria-labelledby="tao-analytics-about-debug-title">
      <div class="tao-analytics-debug-modal-header">
        <div>
          <p class="tao-analytics-debug-eyebrow">About scrape debug</p>
          <h2 id="tao-analytics-about-debug-title">Subnet ${snapshot.netuid} reg fee scrape ${snapshot.labelFound ? 'succeeded' : 'incomplete'}</h2>
        </div>
        <button type="button" class="tao-analytics-debug-close" aria-label="Close">×</button>
      </div>
      <div class="tao-analytics-debug-modal-body">
        <div class="tao-analytics-debug-grid tao-analytics-debug-grid-about">
          <div class="tao-analytics-debug-card">
            <h3>Registration fee</h3>
            <p class="tao-analytics-debug-value">${snapshot.regFeeDisplay}</p>
            <p class="tao-analytics-debug-meta">DOM value: ${formatDebugValue(snapshot.valueText)}</p>
            <p class="tao-analytics-debug-meta">burnTao: ${formatDebugValue(snapshot.burnTao)}</p>
            <p class="tao-analytics-debug-meta">burnUsd: ${formatDebugValue(snapshot.burnUsd)}</p>
          </div>
          <div class="tao-analytics-debug-card">
            <h3>Cache</h3>
            <p class="tao-analytics-debug-value tao-analytics-debug-cache-${snapshot.regCacheStatus}">${formatCacheStatus(snapshot.regCacheStatus)}</p>
            <p class="tao-analytics-debug-meta">Entry present: ${snapshot.cacheEntry ? 'yes' : 'no'}</p>
            <p class="tao-analytics-debug-meta">updatedAt: ${snapshot.cacheUpdatedAt ? new Date(snapshot.cacheUpdatedAt).toLocaleString() : '—'}</p>
          </div>
          <div class="tao-analytics-debug-card">
            <h3>Page state</h3>
            <p class="tao-analytics-debug-meta">Reg label found: ${snapshot.labelFound ? 'yes' : 'no'}</p>
            <p class="tao-analytics-debug-meta">Page ready: ${snapshot.pageReady ? 'yes' : 'no'}</p>
            <p class="tao-analytics-debug-meta">Source: ${snapshot.source || '—'}</p>
            <p class="tao-analytics-debug-meta">taoUsd: ${formatDebugValue(snapshot.taoUsd)}</p>
          </div>
        </div>
        <details class="tao-analytics-debug-details">
          <summary>Raw cache entry &amp; JSON</summary>
          <pre class="tao-analytics-debug-pre">${formatDebugValue(snapshot.cacheEntry)}</pre>
        </details>
        <details class="tao-analytics-debug-details">
          <summary>Full debug snapshot</summary>
          <pre class="tao-analytics-debug-pre">${formatDebugValue(snapshot)}</pre>
        </details>
      </div>
      <div class="tao-analytics-debug-modal-footer">
        <button type="button" class="tao-analytics-debug-btn" data-copy="1">Copy JSON</button>
        <button type="button" class="tao-analytics-debug-btn tao-analytics-debug-btn-primary" data-close="1">Close</button>
      </div>
    </div>
  `;

  host.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', hideMetagraphScrapeDebugModal);
  });

  host.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
    } catch {
      // Ignore clipboard failures.
    }
  });

  document.documentElement.classList.add('tao-analytics-debug-modal-open');
  document.body.appendChild(host);
  metagraphDebugModalHost = host;
}

function maybeShowAboutScrapeDebugModal(netuid, scrapeDetails) {
  if (!metagraphScrapeDebug) {
    return;
  }

  const signature = [
    scrapeDetails.valueText,
    scrapeDetails.burnTao,
    scrapeDetails.burnUsd,
    scrapeDetails.regCacheStatus,
    scrapeDetails.cacheEntry?.updatedAt ?? '',
  ].join('|');

  if (signature === lastAboutDebugSignature) {
    return;
  }

  lastAboutDebugSignature = signature;
  showAboutScrapeDebugModal(buildAboutScrapeDebugSnapshot(netuid, scrapeDetails));
}

async function loadMetagraphScrapeDebugPreference() {
  const stored = await getSyncStorage(METagraph_SCRAPE_DEBUG_KEY);
  metagraphScrapeDebug = stored?.[METagraph_SCRAPE_DEBUG_KEY] === true;
  document.documentElement.dataset.taoAnalyticsMetagraphDebug = metagraphScrapeDebug ? 'on' : 'off';
}

function bindMetagraphScrapeDebugPreferenceListener() {
  if (bindMetagraphScrapeDebugPreferenceListener.bound) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes?.[METagraph_SCRAPE_DEBUG_KEY]) {
      return;
    }

    metagraphScrapeDebug = changes[METagraph_SCRAPE_DEBUG_KEY].newValue === true;
    document.documentElement.dataset.taoAnalyticsMetagraphDebug = metagraphScrapeDebug ? 'on' : 'off';
    if (!metagraphScrapeDebug) {
      hideMetagraphScrapeDebugModal();
    }
  });

  bindMetagraphScrapeDebugPreferenceListener.bound = true;
}

function parseIncentiveCellValue(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized === '—' || normalized === '-') {
    return null;
  }

  const value = Number(normalized.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function findMetagraphPaginationRoot(tableInfo) {
  let root = tableInfo?.table ?? null;

  for (let depth = 0; depth < 14 && root instanceof Element; depth += 1) {
    const buttons = root.querySelectorAll('button');
    const text = normalizeText(root.textContent);
    if (buttons.length >= 2 && /\d+\s*\/\s*\d+/.test(text)) {
      return root;
    }
    root = root.parentElement;
  }

  return tableInfo?.table?.closest('div') ?? null;
}

function findMetagraphPaginationButton(tableInfo, direction) {
  const root = findMetagraphPaginationRoot(tableInfo);
  if (!root) {
    return null;
  }

  const buttons = [...root.querySelectorAll('button')];
  const wantNext = direction === 'next';

  return (
    buttons.find((btn) => {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
        return false;
      }

      const aria = String(btn.getAttribute('aria-label') || '').toLowerCase();
      const text = normalizeText(btn.textContent).toLowerCase();

      if (wantNext) {
        return (
          aria.includes('next page') ||
          aria.includes('go to next') ||
          text === 'next' ||
          Boolean(btn.querySelector('svg.lucide-chevron-right, [class*="chevron-right"]'))
        );
      }

      return (
        aria.includes('previous page') ||
        aria.includes('go to previous') ||
        aria.includes('first page') ||
        aria.includes('go to first') ||
        text === 'previous' ||
        text === 'prev' ||
        Boolean(btn.querySelector('svg.lucide-chevron-left, [class*="chevron-left"]'))
      );
    }) ?? null
  );
}

function findMetagraphPaginationNext(tableInfo) {
  return findMetagraphPaginationButton(tableInfo, 'next');
}

function findMetagraphPaginationPrev(tableInfo) {
  return findMetagraphPaginationButton(tableInfo, 'prev');
}

function findMetagraphIncentiveSortButton(tableInfo) {
  const headerRow = tableInfo.table.querySelector('thead tr');
  if (!headerRow) {
    return null;
  }

  const headers = [...headerRow.querySelectorAll('th')];
  const th = headers[tableInfo.incentiveIdx];
  return th?.querySelector('button') ?? null;
}

function isMetagraphIncentiveSortArrowUp(tableInfo) {
  const button = findMetagraphIncentiveSortButton(tableInfo);
  if (!button) {
    return false;
  }

  const th = button.closest('th');
  const aria = th?.getAttribute('aria-sort');
  if (aria === 'ascending') {
    return true;
  }
  if (aria === 'descending') {
    return false;
  }

  const svg = button.querySelector('svg');
  if (!svg) {
    return false;
  }

  const cls = svg.className?.toString() ?? '';
  const style = svg.getAttribute('style') ?? '';
  return /rotate-180|scale-y-\[-1\]|rotate\(180deg\)/i.test(`${cls} ${style}`);
}

function isMetagraphIncentiveSortArrowDown(tableInfo) {
  const button = findMetagraphIncentiveSortButton(tableInfo);
  if (!button) {
    return false;
  }

  const th = button.closest('th');
  const aria = th?.getAttribute('aria-sort');
  if (aria === 'descending') {
    return true;
  }
  if (aria === 'ascending') {
    return false;
  }

  const svg = button.querySelector('svg');
  if (!svg) {
    return false;
  }

  const cls = svg.className?.toString() ?? '';
  const style = svg.getAttribute('style') ?? '';
  const arrowPointsUp = /rotate-180|scale-y-\[-1\]|rotate\(180deg\)/i.test(`${cls} ${style}`);

  // tao.app uses a down-chevron SVG; rotate-180 flips it to point up (ascending).
  return !arrowPointsUp;
}

function isMetagraphIncentiveSortedDesc(tableInfo) {
  return isMetagraphIncentiveSortArrowDown(tableInfo);
}

async function ensureMetagraphIncentiveSortDesc(tableInfo) {
  if (isMetagraphIncentiveSortedDesc(tableInfo)) {
    return tableInfo;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isMetagraphIncentiveSortedDesc(tableInfo)) {
      return tableInfo;
    }

    const sortButton = findMetagraphIncentiveSortButton(tableInfo);
    if (!sortButton) {
      return tableInfo;
    }

    sortButton.click();
    await delay(500);
    tableInfo = findMetagraphTable() || tableInfo;
  }

  return tableInfo;
}

async function prepareMetagraphTableForScrape() {
  let tableInfo = findMetagraphTable();
  if (!tableInfo) {
    return null;
  }

  if (!isMetagraphIncentiveSortedDesc(tableInfo)) {
    tableInfo = await ensureMetagraphIncentiveSortDesc(tableInfo);
  }

  if (!isMetagraphIncentiveSortedDesc(tableInfo)) {
    return null;
  }

  return tableInfo;
}

async function goToMetagraphFirstPage(tableInfo) {
  let current = tableInfo;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const prev = findMetagraphPaginationPrev(current);
    if (!prev) {
      break;
    }

    const before = current.table.querySelector('tbody')?.textContent ?? '';
    prev.click();
    await delay(400);
    const refreshed = findMetagraphTable();
    if (!refreshed) {
      break;
    }

    const after = refreshed.table.querySelector('tbody')?.textContent ?? '';
    current = refreshed;
    if (after === before) {
      break;
    }
  }

  return current;
}

function metagraphPageHasOnlyZeroIncentives(tableInfo) {
  let sawNonOwner = false;

  for (const row of tableInfo.table.querySelectorAll('tbody tr')) {
    if (isMetagraphOwnerMinerRow(row, tableInfo)) {
      continue;
    }

    sawNonOwner = true;
    const cells = [...row.querySelectorAll('td')];
    const incentive = parseIncentiveCellValue(cells[tableInfo.incentiveIdx]?.textContent);
    if (incentive != null && incentive > 0) {
      return false;
    }
  }

  return sawNonOwner;
}

function isMetagraphOwnerMinerRow(row, tableInfo) {
  const cells = [...row.querySelectorAll('td')];
  const incentiveCell = cells[tableInfo.incentiveIdx];
  if (!incentiveCell) {
    return false;
  }

  if (row.querySelector('[aria-label="Owner incentive"]')) {
    return true;
  }

  if (isOrangeBurnElement(incentiveCell)) {
    return true;
  }

  if (incentiveCell.querySelector('svg.lucide-flame, [class*="flame"]')) {
    return true;
  }

  const typeIdx = tableInfo.headers.findIndex((label) => label === 'Type');
  if (typeIdx >= 0) {
    const typeCell = cells[typeIdx];
    const typeText = normalizeText(typeCell?.textContent).toLowerCase();
    const typeAria = String(typeCell?.getAttribute('aria-label') || '').toLowerCase();
    if (typeText.includes('owner') || typeAria.includes('owner')) {
      return true;
    }
  }

  return false;
}

function collectPositiveIncentiveUidsFromMetagraphPage(tableInfo) {
  const positiveUids = new Set();

  tableInfo.table.querySelectorAll('tbody tr').forEach((row) => {
    if (isMetagraphOwnerMinerRow(row, tableInfo)) {
      return;
    }

    const cells = [...row.querySelectorAll('td')];
    const uid = parseMinerUid(cells[tableInfo.uidIdx]?.textContent);
    const incentive = parseIncentiveCellValue(cells[tableInfo.incentiveIdx]?.textContent);

    if (uid != null && incentive != null && incentive > 0) {
      positiveUids.add(uid);
    }
  });

  return positiveUids;
}

function parseEmissionCellValue(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized === '—' || normalized === '-') {
    return null;
  }

  const value = parseMoneyLikeNumber(normalized) ?? Number(normalized.replace(/,/g, ''));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function formatTopMinerEmission(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }

  if (value >= 10) {
    return (Math.round(value * 10) / 10).toFixed(1);
  }

  return (Math.round(value * 100) / 100).toFixed(2);
}

function collectTopMinerEmissionsFromMetagraphPage(tableInfo, limit = 3) {
  if (tableInfo.emissionIdx < 0) {
    return [];
  }

  const emissions = [];

  for (const row of tableInfo.table.querySelectorAll('tbody tr')) {
    if (isMetagraphOwnerMinerRow(row, tableInfo)) {
      continue;
    }

    const cells = [...row.querySelectorAll('td')];
    const incentive = parseIncentiveCellValue(cells[tableInfo.incentiveIdx]?.textContent);
    if (incentive == null || incentive <= 0) {
      continue;
    }

    const emission = parseEmissionCellValue(cells[tableInfo.emissionIdx]?.textContent);
    if (emission == null) {
      continue;
    }

    emissions.push(emission);
    if (emissions.length >= limit) {
      break;
    }
  }

  return emissions;
}

function topMinerEmissionsEqual(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) {
    return false;
  }

  return a.every((value, index) => Number(value) === Number(b[index]));
}

async function collectIncentiveMinerCountFromMetagraphTable() {
  let tableInfo = await prepareMetagraphTableForScrape();
  if (!tableInfo) {
    return null;
  }

  tableInfo = await goToMetagraphFirstPage(tableInfo);

  const topEmissions = collectTopMinerEmissionsFromMetagraphPage(tableInfo, 3);
  const positiveUids = new Set();
  let pages = 0;

  while (pages < 40) {
    collectPositiveIncentiveUidsFromMetagraphPage(tableInfo).forEach((uid) => {
      positiveUids.add(uid);
    });

    if (positiveUids.size > MINER_COUNT_DISPLAY_CAP) {
      break;
    }

    if (metagraphPageHasOnlyZeroIncentives(tableInfo)) {
      break;
    }

    const next = findMetagraphPaginationNext(tableInfo);
    if (!next) {
      break;
    }

    const before = tableInfo.table.querySelector('tbody')?.textContent ?? '';
    next.click();
    await delay(500);

    const refreshed = findMetagraphTable();
    if (!refreshed) {
      break;
    }

    const after = refreshed.table.querySelector('tbody')?.textContent ?? '';
    if (after === before) {
      break;
    }

    tableInfo = refreshed;
    pages += 1;
  }

  return {
    count: positiveUids.size,
    topEmissions,
  };
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

  if (!isMetagraphTabActive()) {
    return null;
  }

  // On metagraph: no yellow/orange owner incentive visible → burn rate is 0.
  if (isMetagraphScrapePageReady()) {
    const readyTable = findMetagraphTable();
    if (readyTable && !isMetagraphIncentiveSortedDesc(readyTable)) {
      return null;
    }
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
    return {
      ok: false,
      cacheStatus: 'missing',
      reason: 'parse_failed',
      valueText,
      burnTao: null,
      burnUsd: null,
      taoUsd: scrapeTaoUsdPrice(),
    };
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
    return {
      ok: false,
      cacheStatus: 'missing',
      reason: 'currency_unknown',
      valueText,
      burnTao: null,
      burnUsd: null,
      taoUsd,
    };
  }

  const signature = `${burnTao}:${burnUsd}:${taoUsd}`;

  if (signature === lastRegSignatureRef.value) {
    return {
      ok: true,
      cacheStatus: 'unchanged',
      valueText,
      burnTao,
      burnUsd,
      taoUsd,
      cacheEntry: await resolveCacheEntryForNetuid(netuid),
    };
  }

  lastRegSignatureRef.value = signature;
  const patch = {
    burnTao,
    burnUsd,
    taoUsd,
    source: 'dom',
    domCapturedAt: Date.now(),
  };
  if (burnTao != null && Number.isFinite(burnTao)) {
    patch.burnRao = Math.round(burnTao * 1_000_000_000);
  }

  const upsert = await upsertMetricCache(netuid, patch);
  if (upsert?.ok) {
    return {
      ok: true,
      cacheStatus: 'updated',
      valueText,
      burnTao,
      burnUsd,
      taoUsd,
      cacheEntry: upsert.entry ?? (await resolveCacheEntryForNetuid(netuid)),
    };
  }

  return {
    ok: false,
    cacheStatus: 'failed',
    valueText,
    burnTao,
    burnUsd,
    taoUsd,
    cacheEntry: await resolveCacheEntryForNetuid(netuid),
  };
}

function getActiveSubnetTab() {
  const tab = new URLSearchParams(location.search).get('active_tab');
  return tab ? tab.toLowerCase() : null;
}

const SUBNET_TAB_LABELS = new Set([
  'About',
  'Social',
  'Metagraph',
  'Hyperparams',
  'Liquidity',
  'Holders',
  'Transactions',
  'Volume',
]);

function getEffectiveActiveSubnetTab() {
  const activeTabBtn = document.querySelector('[role="tablist"] [role="tab"][data-state="active"]');
  if (activeTabBtn instanceof HTMLElement) {
    const label = normalizeText(activeTabBtn.textContent);
    if (SUBNET_TAB_LABELS.has(label)) {
      return label.toLowerCase();
    }

    const id = activeTabBtn.id || '';
    if (/metagraph/i.test(id)) {
      return 'metagraph';
    }
    if (/about/i.test(id)) {
      return 'about';
    }
  }

  const urlTab = getActiveSubnetTab();
  if (urlTab) {
    return urlTab;
  }

  return 'about';
}

function isAboutSubnetTab() {
  return getEffectiveActiveSubnetTab() === 'about';
}

function isMetagraphTabActive() {
  return getEffectiveActiveSubnetTab() === 'metagraph';
}

function buildSubnetPageQuery() {
  const activeTab = new URLSearchParams(location.search).get('active_tab');
  if (!activeTab) {
    return '';
  }
  return `?active_tab=${encodeURIComponent(activeTab)}`;
}

function buildSubnetPageUrl(netuid) {
  const id = Number(netuid);
  if (!Number.isInteger(id) || id < 0 || id > SUBNET_NETUID_MAX) {
    return null;
  }
  return `${location.origin}/subnets/${id}${buildSubnetPageQuery()}`;
}

function navigateToSubnet(netuid, { newTab = false } = {}) {
  const url = buildSubnetPageUrl(netuid);
  if (!url) {
    return false;
  }

  if (newTab) {
    window.open(url, '_blank', 'noopener');
    return true;
  }

  if (url === location.href) {
    return false;
  }

  location.href = url;
  return true;
}

function parseSubnetInputValue(input) {
  const raw = input?.value;
  if (raw === '' || raw == null) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > SUBNET_NETUID_MAX) {
    return null;
  }
  return value;
}

function resolveSubnetNavTarget(direction, input, currentNetuid) {
  const inputValue = parseSubnetInputValue(input);
  const inputDiffers = inputValue != null && inputValue !== currentNetuid;

  if (direction === 'next') {
    if (inputDiffers) {
      return inputValue;
    }
    if (currentNetuid != null && currentNetuid < SUBNET_NETUID_MAX) {
      return currentNetuid + 1;
    }
    return null;
  }

  if (inputDiffers) {
    return inputValue > 0 ? inputValue - 1 : null;
  }
  if (currentNetuid != null && currentNetuid > 0) {
    return currentNetuid - 1;
  }
  return null;
}

function bindSubnetNavButton(button, direction, input) {
  const go = (newTab) => {
    const target = resolveSubnetNavTarget(direction, input, getNetuidFromPath());
    if (target == null) {
      return;
    }
    navigateToSubnet(target, { newTab });
  };

  button.addEventListener('click', () => {
    go(false);
  });

  button.addEventListener('auxclick', (event) => {
    if (event.button !== 1) {
      return;
    }
    event.preventDefault();
    go(true);
  });

  button.addEventListener('mousedown', (event) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  });
}

function findSubnetNavMountPoint() {
  for (const parent of document.querySelectorAll('div, nav')) {
    const directTabs = [...parent.children].filter((child) => {
      if (!(child instanceof HTMLElement)) {
        return false;
      }

      const link = child.matches('a, button')
        ? child
        : child.querySelector(':scope > a, :scope > button');

      if (!link) {
        return false;
      }

      return SUBNET_TAB_LABELS.has(normalizeText(link.textContent));
    });

    if (directTabs.length >= 3) {
      return { tabBar: parent, before: directTabs[0] };
    }
  }

  const aboutTab = [...document.querySelectorAll('a, button')].find(
    (el) => normalizeText(el.textContent) === 'About',
  );
  if (aboutTab?.parentElement) {
    return { tabBar: aboutTab.parentElement, before: aboutTab };
  }

  return null;
}

function findSubnetHeaderMountPoint() {
  const h2 = [...document.querySelectorAll('h2')].find((el) =>
    /^Subnet\s+\d/i.test(normalizeText(el.textContent)),
  );
  if (!h2) {
    return null;
  }

  const leftCluster = h2.closest('.flex.items-center.gap-4');
  if (!(leftCluster instanceof HTMLElement)) {
    return null;
  }

  return { header: leftCluster, before: null };
}

function findSubnetToolbarRow() {
  const snapshotLabel = [...document.querySelectorAll('label')].find(
    (el) => normalizeText(el.textContent) === 'Snapshot',
  );
  const form = snapshotLabel?.closest('form');
  if (!(form instanceof HTMLElement)) {
    return null;
  }

  const row = form.parentElement;
  if (!(row instanceof HTMLElement)) {
    return null;
  }

  const tabHost =
    row.querySelector('[role="tablist"]')?.parentElement ||
    row.querySelector('[data-tao-subnet-toolbar-host]');
  if (!(tabHost instanceof HTMLElement)) {
    return null;
  }

  return { row, form, tabHost };
}

function findActiveMetagraphTabTrigger() {
  return (
    document.querySelector('[role="tablist"] [role="tab"][id*="metagraph"][data-state="active"]') ||
    [...document.querySelectorAll('[role="tablist"] [role="tab"]')].find(
      (el) =>
        el.getAttribute('data-state') === 'active' &&
        normalizeText(el.textContent) === 'Metagraph',
    ) ||
    null
  );
}

function findMetagraphTabPanel() {
  const trigger = findActiveMetagraphTabTrigger();
  if (trigger) {
    const panelId = trigger.getAttribute('aria-controls');
    if (panelId) {
      const panel = document.getElementById(panelId);
      if (panel instanceof HTMLElement) {
        return panel;
      }
    }
  }

  if (!isMetagraphTabActive()) {
    return null;
  }

  for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
    const searchInput = panel.querySelector('input[placeholder*="Search"]');
    const table = panel.querySelector('table');
    if (!(searchInput instanceof HTMLElement) || !table) {
      continue;
    }

    const headers = [...table.querySelectorAll('thead th')].map((cell) =>
      normalizeText(cell.textContent),
    );
    if (headers.includes('UID')) {
      return panel;
    }
  }

  return null;
}

function findMetagraphControlsBarInPanel() {
  if (!isMetagraphTabActive()) {
    return null;
  }

  const panel = findMetagraphTabPanel();
  if (!(panel instanceof HTMLElement)) {
    return null;
  }

  const searchInput = panel.querySelector('input[placeholder*="Search"]');
  if (!(searchInput instanceof HTMLElement)) {
    return null;
  }

  const bar =
    searchInput.closest('.mb-4.flex') ||
    searchInput.closest('.flex.flex-wrap')?.parentElement;

  if (!(bar instanceof HTMLElement) || !panel.contains(bar)) {
    return null;
  }

  return bar;
}

function findMovedMetagraphControlsBar() {
  const toolbar = findSubnetToolbarRow();
  const bar = toolbar?.row?.querySelector('.tao-analytics-metagraph-controls-bar');
  return bar instanceof HTMLElement ? bar : null;
}

const metagraphControlsPlacement = {
  bar: null,
  originParent: null,
  originNext: null,
};

function clearMetagraphControlsPlacementState() {
  metagraphControlsPlacement.bar = null;
  metagraphControlsPlacement.originParent = null;
  metagraphControlsPlacement.originNext = null;
}

function detachMetagraphControlsFromToolbar() {
  const bar = findMovedMetagraphControlsBar() || metagraphControlsPlacement.bar;
  if (!(bar instanceof HTMLElement) || !bar.isConnected) {
    clearMetagraphControlsPlacementState();
    return;
  }

  bar.classList.remove('tao-analytics-metagraph-controls-bar');
  delete bar.dataset.taoMetagraphControlsMoved;

  const { originParent, originNext } = metagraphControlsPlacement;
  if (originParent?.isConnected) {
    originParent.insertBefore(bar, originNext);
  } else {
    bar.remove();
  }

  clearMetagraphControlsPlacementState();
}

function isMetagraphControlsPlaced(toolbar, bar) {
  return (
    toolbar?.row &&
    bar &&
    bar.parentElement === toolbar.row &&
    bar.previousElementSibling === toolbar.form
  );
}

function ensureMetagraphControlsPlacement() {
  if (!isSubnetPage()) {
    return;
  }

  if (!isMetagraphTabActive()) {
    detachMetagraphControlsFromToolbar();
    return;
  }

  const toolbar = findSubnetToolbarRow();
  if (!toolbar) {
    return;
  }

  const movedBar = findMovedMetagraphControlsBar();
  const freshBar = findMetagraphControlsBarInPanel();

  if (movedBar && freshBar && movedBar !== freshBar) {
    movedBar.remove();
    clearMetagraphControlsPlacementState();
  } else if (movedBar && isMetagraphControlsPlaced(toolbar, movedBar)) {
    return;
  } else if (movedBar && !freshBar) {
    return;
  } else if (movedBar && !isMetagraphControlsPlaced(toolbar, movedBar)) {
    movedBar.remove();
    clearMetagraphControlsPlacementState();
  }

  const bar = findMetagraphControlsBarInPanel();
  if (!bar) {
    return;
  }

  if (metagraphControlsPlacement.bar !== bar) {
    metagraphControlsPlacement.bar = bar;
    metagraphControlsPlacement.originParent = bar.parentElement;
    metagraphControlsPlacement.originNext = bar.nextSibling;
  }

  bar.classList.add('tao-analytics-metagraph-controls-bar');
  bar.dataset.taoMetagraphControlsMoved = '1';
  toolbar.row.insertBefore(bar, toolbar.tabHost);
}

function normalizeSubnetNavControls(nav) {
  if (!nav) {
    return;
  }

  const input = nav.querySelector('.tao-analytics-subnet-nav-input');
  const wrap = input?.closest('.tao-analytics-subnet-nav-input-wrap');
  if (wrap && input) {
    wrap.replaceWith(input);
  }

  for (const btn of nav.querySelectorAll('.tao-analytics-subnet-nav-btn')) {
    btn.className = 'tao-analytics-subnet-nav-btn';
    btn.removeAttribute('style');
  }

  if (input) {
    input.className = 'tao-analytics-subnet-nav-input';
    input.removeAttribute('style');
  }
}

function applySubnetNavBarStyles(section) {
  if (!(section instanceof HTMLElement)) {
    return false;
  }

  section.style.display = 'inline-flex';
  section.style.alignItems = 'center';
  section.style.flexShrink = '0';
  section.style.padding = '';
  section.style.gap = '';
  section.style.borderRadius = '';
  section.style.background = '';
  section.style.backgroundColor = '';
  section.style.boxShadow = '';
  section.style.border = '';
  section.style.marginRight = '';
  section.style.marginLeft = '';
  return true;
}

function unwrapLegacySubnetNavLayout() {
  const tabsCard = document.querySelector('.tao-analytics-subnet-tabs-card');
  if (tabsCard?.parentElement) {
    const parent = tabsCard.parentElement;
    [...tabsCard.children].forEach((child) => {
      parent.insertBefore(child, tabsCard);
    });
    tabsCard.remove();
  }

  const row = document.querySelector('.tao-analytics-subnet-nav-row');
  if (!row?.parentElement) {
    return;
  }

  const section = row.querySelector('.tao-analytics-subnet-nav-section');
  if (section) {
    row.parentElement.insertBefore(section, row);
  }
  row.remove();
}

function isSubnetNavigatorPlaced(mount, section) {
  if (!section || !mount?.header) {
    return false;
  }

  if (section.parentElement !== mount.header) {
    return false;
  }

  if (mount.before) {
    return section.nextSibling === mount.before;
  }

  return section === mount.header.lastElementChild;
}

function bindSubnetNavigator(nav) {
  if (nav.dataset.taoSubnetNavBound === '1') {
    return;
  }
  nav.dataset.taoSubnetNavBound = '1';

  const input = nav.querySelector('.tao-analytics-subnet-nav-input');
  const prevBtn = nav.querySelector('[data-action="prev"]');
  const nextBtn = nav.querySelector('[data-action="next"]');

  if (prevBtn) {
    bindSubnetNavButton(prevBtn, 'prev', input);
  }
  if (nextBtn) {
    bindSubnetNavButton(nextBtn, 'next', input);
  }

  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    const value = parseSubnetInputValue(input);
    if (value != null) {
      navigateToSubnet(value);
    }
  });

  input?.addEventListener('input', () => {
    updateSubnetNavigatorState(nav);
  });
}

function updateSubnetNavigatorState(nav) {
  const netuid = getNetuidFromPath();
  const input = nav.querySelector('.tao-analytics-subnet-nav-input');
  const prevBtn = nav.querySelector('[data-action="prev"]');
  const nextBtn = nav.querySelector('[data-action="next"]');

  if (input && netuid != null && document.activeElement !== input) {
    input.value = String(netuid);
  }

  const inputValue = parseSubnetInputValue(input);
  const inputDiffers = inputValue != null && inputValue !== netuid;

  if (prevBtn) {
    if (inputDiffers) {
      prevBtn.disabled = inputValue <= 0;
    } else {
      prevBtn.disabled = netuid == null || netuid <= 0;
    }
  }

  if (nextBtn) {
    if (inputDiffers) {
      nextBtn.disabled = false;
    } else {
      nextBtn.disabled = netuid == null || netuid >= SUBNET_NETUID_MAX;
    }
  }
}

function createSubnetNavigator() {
  const section = document.createElement('div');
  section.className = 'tao-analytics-subnet-nav-section';

  const nav = document.createElement('div');
  nav.className = 'tao-analytics-subnet-nav';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'tao-analytics-subnet-nav-btn';
  prevBtn.dataset.action = 'prev';
  prevBtn.textContent = 'Prev';
  prevBtn.setAttribute('aria-label', 'Previous subnet');

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'tao-analytics-subnet-nav-input';
  input.min = '0';
  input.max = String(SUBNET_NETUID_MAX);
  input.inputMode = 'numeric';
  input.placeholder = 'SN';
  input.title = 'Subnet number (Enter to go)';
  input.setAttribute('aria-label', 'Subnet number');

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'tao-analytics-subnet-nav-btn';
  nextBtn.dataset.action = 'next';
  nextBtn.textContent = 'Next';
  nextBtn.setAttribute('aria-label', 'Next subnet');

  nav.append(prevBtn, input, nextBtn);
  section.append(nav);
  bindSubnetNavigator(nav);
  return section;
}

function wrapSubnetNavigatorSection(nav) {
  if (!nav || nav.closest('.tao-analytics-subnet-nav-section')) {
    return nav?.closest('.tao-analytics-subnet-nav-section') ?? nav;
  }

  const section = document.createElement('div');
  section.className = 'tao-analytics-subnet-nav-section';
  nav.parentElement?.insertBefore(section, nav);
  section.appendChild(nav);
  return section;
}

let subnetNavObserver = null;
let subnetNavUrlWatch = null;
let subnetNavTabClickHandler = null;
let lastMetagraphTabActive = null;
let subnetNavIsMounting = false;

function ensureSubnetNavigator() {
  if (!isSubnetPage() || subnetNavIsMounting) {
    return;
  }

  const mount = findSubnetHeaderMountPoint();
  if (!mount) {
    ensureMetagraphControlsPlacement();
    return;
  }

  subnetNavIsMounting = true;
  subnetNavObserver?.disconnect();

  try {
    unwrapLegacySubnetNavLayout();

    let section = document.querySelector('.tao-analytics-subnet-nav-section');
    let nav = section?.querySelector('.tao-analytics-subnet-nav') ?? null;

    if (!nav) {
      const orphanNav = document.querySelector('.tao-analytics-subnet-nav');
      if (orphanNav) {
        section = wrapSubnetNavigatorSection(orphanNav);
        nav = orphanNav;
      } else {
        section = createSubnetNavigator();
        nav = section.querySelector('.tao-analytics-subnet-nav');
      }
    }

    if (section && !isSubnetNavigatorPlaced(mount, section)) {
      if (mount.before) {
        mount.header.insertBefore(section, mount.before);
      } else {
        mount.header.appendChild(section);
      }
    }

    section?.querySelector('.tao-analytics-subnet-nav-gap')?.remove();

    ensureMetagraphControlsPlacement();

    if (section) {
      applySubnetNavBarStyles(section);
    }

    if (nav) {
      normalizeSubnetNavControls(nav);
      updateSubnetNavigatorState(nav);
    }
  } finally {
    subnetNavIsMounting = false;
    if (subnetNavObserver && isSubnetPage()) {
      subnetNavObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }
}

function teardownSubnetNavigator() {
  if (subnetNavObserver) {
    subnetNavObserver.disconnect();
    subnetNavObserver = null;
  }
  if (subnetNavUrlWatch) {
    clearInterval(subnetNavUrlWatch);
    subnetNavUrlWatch = null;
  }
  detachMetagraphControlsFromToolbar();
  if (subnetNavTabClickHandler) {
    document.removeEventListener('click', subnetNavTabClickHandler, true);
    subnetNavTabClickHandler = null;
  }
  lastMetagraphTabActive = null;
}

function isSubnetTradingViewRoot(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  const className = node.className || '';
  if (!className.includes('flex-col') || !className.includes('flex-row')) {
    return false;
  }

  const hasChart = node.querySelector(
    'iframe[id^="tradingview_"], iframe[title="Financial Chart"]',
  );
  const hasTradePanel = node.querySelector('[role="tablist"]');

  return Boolean(hasChart && hasTradePanel);
}

function findSubnetTradingViewRoot() {
  for (const iframe of document.querySelectorAll(
    'iframe[id^="tradingview_"], iframe[title="Financial Chart"]',
  )) {
    let node = iframe.parentElement;

    for (let depth = 0; depth < 14 && node instanceof HTMLElement; depth += 1) {
      if (isSubnetTradingViewRoot(node)) {
        return node;
      }
      node = node.parentElement;
    }
  }

  return null;
}

function removeSubnetTradingView() {
  if (!hideSubnetTradingView || !isSubnetPage()) {
    return;
  }

  const root = findSubnetTradingViewRoot();
  if (root) {
    root.remove();
  }
}

function scheduleSubnetTradingViewHide() {
  if (!hideSubnetTradingView || !isSubnetPage()) {
    return;
  }

  if (tradingViewHideTimer) {
    clearTimeout(tradingViewHideTimer);
  }

  tradingViewHideTimer = setTimeout(() => {
    tradingViewHideTimer = null;
    removeSubnetTradingView();
  }, 80);
}

async function loadHideSubnetTradingViewPreference() {
  const stored = await getSyncStorage({ [HIDE_SUBNET_TRADING_VIEW_KEY]: false });
  hideSubnetTradingView = stored?.[HIDE_SUBNET_TRADING_VIEW_KEY] === true;
  document.documentElement.dataset.taoAnalyticsHideTradingView = hideSubnetTradingView
    ? 'on'
    : 'off';
}

function teardownSubnetTradingViewHider() {
  if (tradingViewHideObserver) {
    tradingViewHideObserver.disconnect();
    tradingViewHideObserver = null;
  }
  if (tradingViewHideUrlWatch) {
    clearInterval(tradingViewHideUrlWatch);
    tradingViewHideUrlWatch = null;
  }
  if (tradingViewHideTimer) {
    clearTimeout(tradingViewHideTimer);
    tradingViewHideTimer = null;
  }
}

function initSubnetTradingViewHider() {
  const schedule = () => {
    scheduleSubnetTradingViewHide();
  };

  schedule();

  if (!tradingViewHideObserver) {
    tradingViewHideObserver = new MutationObserver(schedule);
    tradingViewHideObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  if (!tradingViewHideUrlWatch) {
    let lastHref = location.href;
    tradingViewHideUrlWatch = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        schedule();
      }
    }, 400);
  }

  if (!initSubnetTradingViewHider.storageListenerBound) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes?.[HIDE_SUBNET_TRADING_VIEW_KEY]) {
        return;
      }

      hideSubnetTradingView = changes[HIDE_SUBNET_TRADING_VIEW_KEY].newValue === true;
      document.documentElement.dataset.taoAnalyticsHideTradingView = hideSubnetTradingView
        ? 'on'
        : 'off';
      schedule();
    });
    initSubnetTradingViewHider.storageListenerBound = true;
  }
}

function scheduleMetagraphControlsPlacement() {
  ensureMetagraphControlsPlacement();
  setTimeout(() => ensureMetagraphControlsPlacement(), 200);
}

function initSubnetNavigator() {
  if (!isSubnetPage()) {
    return;
  }

  unwrapLegacySubnetNavLayout();

  let mountTimer = null;
  const scheduleMount = () => {
    if (mountTimer) {
      clearTimeout(mountTimer);
    }
    mountTimer = setTimeout(() => {
      mountTimer = null;
      ensureSubnetNavigator();
    }, 120);
  };

  ensureSubnetNavigator();

  subnetNavObserver = new MutationObserver(scheduleMount);
  subnetNavObserver.observe(document.documentElement, { childList: true, subtree: true });

  if (!subnetNavTabClickHandler) {
    subnetNavTabClickHandler = (event) => {
      if (!isSubnetPage()) {
        return;
      }
      const tab = event.target.closest?.('[role="tab"]');
      if (tab?.closest('[role="tablist"]')) {
        scheduleMetagraphControlsPlacement();
      }
    };
    document.addEventListener('click', subnetNavTabClickHandler, true);
  }

  let lastHref = location.href;
  lastMetagraphTabActive = isMetagraphTabActive();
  subnetNavUrlWatch = setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastMetagraphTabActive = isMetagraphTabActive();
      ensureSubnetNavigator();
      return;
    }

    const metagraphActive = isMetagraphTabActive();
    if (metagraphActive !== lastMetagraphTabActive) {
      lastMetagraphTabActive = metagraphActive;
      scheduleMetagraphControlsPlacement();
    }
  }, 400);

  window.addEventListener('beforeunload', teardownSubnetNavigator, { once: true });
}

function insertAfter(referenceNode, newNode) {
  if (!referenceNode?.parentElement) {
    return false;
  }

  referenceNode.parentElement.insertBefore(newNode, referenceNode.nextSibling);
  return true;
}

function applyColumnWidth(el, px) {
  if (el.tagName === 'COL') {
    el.style.width = `${px}px`;
    return;
  }

  el.style.width = `${px}px`;
  el.style.minWidth = `${px}px`;
  el.style.maxWidth = `${px}px`;
}

function getAnalyticsColumnWidth(className) {
  if (className === COLUMN.BURN) {
    return COLUMN_WIDTH.burn;
  }
  if (className === COLUMN.FEE) {
    return COLUMN_WIDTH.fee;
  }
  if (className === COLUMN.MINERS) {
    return getMinersColumnWidth();
  }
  return null;
}

function wrapAnalyticsHeaderContent(th) {
  if (!th || th.querySelector(':scope > .tao-analytics-header-inner')) {
    return;
  }

  const inner = document.createElement('div');
  inner.className = 'tao-analytics-header-inner';
  while (th.firstChild) {
    inner.appendChild(th.firstChild);
  }
  th.appendChild(inner);
}

function syncAnalyticsColumnWidths(tableInfo) {
  const table = tableInfo.table;
  const headerRow = table.querySelector('thead tr');
  const colgroup = table.querySelector('colgroup');
  if (!headerRow) {
    return;
  }

  const headers = [...headerRow.querySelectorAll('th')];
  if (colgroup) {
    syncAnalyticsColgroup(tableInfo, headers);
  }

  headers.forEach((th, idx) => {
    const className = ANALYTICS_COLUMN_CLASSES.find((cls) => th.classList.contains(cls));
    if (!className) {
      return;
    }

    const width = getAnalyticsColumnWidth(className);
    if (width == null) {
      return;
    }

    wrapAnalyticsHeaderContent(th);
    applyColumnWidth(th, width);

    if (colgroup) {
      const cols = [...colgroup.children];
      if (cols[idx]) {
        applyColumnWidth(cols[idx], width);
      }
    }

    table.querySelectorAll('tbody tr').forEach((row) => {
      const tds = [...row.querySelectorAll('td')];
      const td = tds[idx];
      if (td?.classList.contains(className)) {
        applyColumnWidth(td, width);
      }
    });
  });
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
  let minersCol = colgroup.querySelector('.tao-analytics-col-miners');

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

  if (!minersCol) {
    minersCol = document.createElement('col');
    minersCol.className = 'tao-analytics-col-miners';
    if (feeCol.nextSibling) {
      colgroup.insertBefore(minersCol, feeCol.nextSibling);
    } else {
      colgroup.appendChild(minersCol);
    }
  }

  applyColumnWidth(burnCol, COLUMN_WIDTH.burn);
  applyColumnWidth(feeCol, COLUMN_WIDTH.fee);
  applyColumnWidth(minersCol, getMinersColumnWidth());
  syncAnalyticsColumnWidths(tableInfo);
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

function isColumnMoveHandle(element) {
  const btn = element?.closest?.('button') ?? (element?.matches?.('button') ? element : null);
  if (!btn) {
    return false;
  }

  const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
  if (/move|reorder|drag|column position/.test(aria)) {
    return true;
  }

  return Boolean(
    btn.querySelector(
      'svg.lucide-move, svg.lucide-grip-vertical, svg.lucide-grip-horizontal, svg.lucide-grip'
    )
  );
}

function getSortButtonFromHeader(th) {
  if (!th) {
    return null;
  }

  const buttons = [...th.querySelectorAll('button')];
  if (buttons.length === 0) {
    return null;
  }

  if (buttons.length === 1) {
    return isColumnMoveHandle(buttons[0]) ? null : buttons[0];
  }

  return buttons.find((btn) => !isColumnMoveHandle(btn)) || buttons[0];
}

function getMoveButtonFromHeader(th) {
  if (!th) {
    return null;
  }

  return [...th.querySelectorAll('button')].find((btn) => isColumnMoveHandle(btn)) ?? null;
}

function findNativeMoveButtonReference(headerRow) {
  if (!headerRow) {
    return null;
  }

  for (const th of headerRow.querySelectorAll('th')) {
    if (isAnalyticsSortHeader(th)) {
      continue;
    }

    const moveBtn = getMoveButtonFromHeader(th);
    if (moveBtn) {
      return moveBtn;
    }
  }

  return null;
}

function ensureMoveButtonOnHeader(th, referenceTh) {
  if (getMoveButtonFromHeader(th)) {
    return;
  }

  const refMove = getMoveButtonFromHeader(referenceTh);
  const headerRow = th.closest('tr');
  const nativeMove = refMove || findNativeMoveButtonReference(headerRow);
  if (!nativeMove) {
    return;
  }

  const clone = nativeMove.cloneNode(true);
  clone.removeAttribute('id');
  th.appendChild(clone);
}

function buildSortableHeaderContent(label, referenceTh) {
  if (!referenceTh?.querySelector('button')) {
    const fallback = document.createElement('button');
    fallback.type = 'button';
    fallback.className = 'tao-analytics-sort-btn';
    fallback.textContent = label;
    return [fallback];
  }

  const shell = referenceTh.cloneNode(true);
  shell.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));

  const sortBtn = getSortButtonFromHeader(shell);
  if (sortBtn) {
    setSortableHeaderLabel(sortBtn, label);
  }

  return [...shell.childNodes];
}

function populateSortableHeader(th, label, referenceTh, sortKey) {
  const hasSortUi = th.dataset.taoAnalyticsSort === sortKey &&
    Boolean(th.querySelector('svg, .tao-analytics-sort-btn, button'));

  if (!hasSortUi) {
    th.dataset.taoAnalyticsSort = sortKey;
    th.replaceChildren(...buildSortableHeaderContent(label, referenceTh));
    ensureMoveButtonOnHeader(th, referenceTh);
  } else {
    const button = getSortButtonFromHeader(th) ?? th.querySelector('button') ?? th.firstElementChild ?? th;
    setSortableHeaderLabel(button, label);
    ensureMoveButtonOnHeader(th, referenceTh);
  }

  wrapAnalyticsHeaderContent(th);

  if (referenceTh?.style?.cursor) {
    th.style.cursor = referenceTh.style.cursor;
  }
}

function createHeaderCell(label, className, title, referenceTh, widthPx, sortKey) {
  const th = document.createElement('th');
  th.className = `tao-analytics-header ${className}`;
  th.title = title;
  applyColumnWidth(th, widthPx);
  populateSortableHeader(th, label, referenceTh, sortKey);
  return th;
}

function getHeaderColumnIndex(headerRow, th) {
  return [...headerRow.querySelectorAll('th')].indexOf(th);
}

function moveColumnInRow(row, fromIdx, toIdx) {
  const tds = [...row.querySelectorAll('td')];
  const td = tds[fromIdx];
  if (!td) {
    return;
  }

  const refreshed = [...row.querySelectorAll('td')];
  const target = refreshed[toIdx];
  row.insertBefore(td, fromIdx < toIdx ? target?.nextSibling ?? null : target);
}

function reorderTableColumn(table, fromIdx, toIdx) {
  if (fromIdx === toIdx) {
    return;
  }

  const headerRow = table.querySelector('thead tr');
  if (!headerRow) {
    return;
  }

  const ths = [...headerRow.querySelectorAll('th')];
  const th = ths[fromIdx];
  const targetTh = ths[toIdx];
  if (!th || !targetTh) {
    return;
  }

  headerRow.insertBefore(th, fromIdx < toIdx ? targetTh.nextSibling : targetTh);

  const colgroup = table.querySelector('colgroup');
  if (colgroup) {
    const cols = [...colgroup.children];
    const col = cols[fromIdx];
    if (col) {
      const refreshedCols = [...colgroup.children];
      const targetCol = refreshedCols[toIdx];
      colgroup.insertBefore(col, fromIdx < toIdx ? targetCol?.nextSibling ?? null : targetCol);
    }
  }

  table.querySelectorAll('tbody tr').forEach((row) => {
    moveColumnInRow(row, fromIdx, toIdx);
  });
}

function syncAnalyticsColgroup(tableInfo, headers) {
  const colgroup = tableInfo.table.querySelector('colgroup');
  if (!colgroup) {
    return;
  }

  const colByClass = {
    [COLUMN.BURN]: colgroup.querySelector('.tao-analytics-col-burn'),
    [COLUMN.FEE]: colgroup.querySelector('.tao-analytics-col-fee'),
    [COLUMN.MINERS]: colgroup.querySelector('.tao-analytics-col-miners'),
  };

  headers.forEach((th, idx) => {
    const className = ANALYTICS_COLUMN_CLASSES.find((cls) => th.classList.contains(cls));
    const col = className ? colByClass[className] : null;
    if (!col) {
      return;
    }

    const cols = [...colgroup.children];
    const currentIdx = cols.indexOf(col);
    if (currentIdx === idx) {
      return;
    }

    const before = cols[idx];
    colgroup.insertBefore(col, currentIdx < idx ? before?.nextSibling ?? null : before);
  });
}

function syncAnalyticsColumnCells(tableInfo) {
  const headerRow = tableInfo.table.querySelector('thead tr');
  if (!headerRow) {
    return;
  }

  const headers = [...headerRow.querySelectorAll('th')];

  tableInfo.table.querySelectorAll('tbody tr').forEach((row) => {
    ANALYTICS_COLUMN_CLASSES.forEach((className) => {
      const headerIdx = headers.findIndex((th) => th.classList.contains(className));
      const cell = row.querySelector(`.${className}`);
      if (headerIdx < 0 || !cell) {
        return;
      }

      const tds = [...row.querySelectorAll('td')];
      const currentIdx = tds.indexOf(cell);
      if (currentIdx === headerIdx) {
        return;
      }

      const before = tds[headerIdx];
      row.insertBefore(cell, currentIdx < headerIdx ? before?.nextSibling ?? null : before);
    });
  });

  syncAnalyticsColgroup(tableInfo, headers);
}

function bindAnalyticsMoveHandles(headerRow) {
  ANALYTICS_COLUMN_CLASSES.forEach((className) => {
    const th = headerRow.querySelector(`.${className}`);
    const moveBtn = th ? getMoveButtonFromHeader(th) : null;
    if (!moveBtn || moveBtn.dataset.taoAnalyticsMoveBound === '1') {
      return;
    }

    moveBtn.dataset.taoAnalyticsMoveBound = '1';
    moveBtn.draggable = true;
    moveBtn.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    moveBtn.addEventListener('click', (event) => {
      event.stopPropagation();
    });
  });
}

function attachColumnOrderObserver(tableInfo) {
  const headerRow = tableInfo.table.querySelector('thead tr');
  if (!headerRow) {
    return;
  }

  if (!columnOrderObserver) {
    columnOrderObserver = new MutationObserver(() => {
      if (isEnhancing || isSorting) {
        return;
      }

      const currentTable = findSubnetTable();
      if (!currentTable) {
        return;
      }

      isEnhancing = true;
      try {
        syncAnalyticsColumnCells(currentTable);
        syncAnalyticsColumnWidths(currentTable);
        bindAnalyticsMoveHandles(currentTable.table.querySelector('thead tr'));
      } finally {
        isEnhancing = false;
      }
    });
  }

  if (headerRow === observedColumnOrderRow) {
    return;
  }

  columnOrderObserver.disconnect();
  columnOrderObserver.observe(headerRow, { childList: true });
  observedColumnOrderRow = headerRow;
}

function ensureColumnReorder(tableInfo) {
  const table = tableInfo.table;
  const headerRow = table.querySelector('thead tr');
  if (!headerRow) {
    return;
  }

  bindAnalyticsMoveHandles(headerRow);
  attachColumnOrderObserver(tableInfo);

  if (table.dataset.taoAnalyticsReorderBound === '1') {
    return;
  }

  table.dataset.taoAnalyticsReorderBound = '1';

  headerRow.addEventListener('dragstart', (event) => {
    const moveBtn = event.target.closest('button');
    if (!moveBtn || !isColumnMoveHandle(moveBtn)) {
      return;
    }

    const th = moveBtn.closest('th');
    if (!th || !ANALYTICS_COLUMN_CLASSES.some((cls) => th.classList.contains(cls))) {
      return;
    }

    const fromIdx = getHeaderColumnIndex(headerRow, th);
    if (fromIdx < 0) {
      return;
    }

    columnDragState = { table, fromIdx };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(fromIdx));
  }, true);

  headerRow.addEventListener('dragover', (event) => {
    if (!columnDragState || columnDragState.table !== table) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });

  headerRow.addEventListener('drop', (event) => {
    if (!columnDragState || columnDragState.table !== table) {
      return;
    }

    event.preventDefault();
    const th = event.target.closest('th');
    const toIdx = th ? getHeaderColumnIndex(headerRow, th) : -1;
    const fromIdx = columnDragState.fromIdx;
    columnDragState = null;

    if (toIdx < 0 || fromIdx < 0 || fromIdx === toIdx) {
      return;
    }

    isEnhancing = true;
    try {
      reorderTableColumn(table, fromIdx, toIdx);
      syncAnalyticsColumnWidths(findSubnetTable() || tableInfo);
    } finally {
      isEnhancing = false;
    }
  });
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

function formatMinerCount(value, topEmissions) {
  if (!Number.isInteger(value) || value < 0) {
    return '—';
  }

  let base;
  if (value > MINER_COUNT_DISPLAY_CAP) {
    base = `${MINER_COUNT_DISPLAY_CAP}+`;
  } else {
    base = String(value);
  }

  const emissions = Array.isArray(topEmissions)
    ? topEmissions.filter((entry) => Number.isFinite(Number(entry)))
    : [];
  if (!shouldShowMinerEmissions() || emissions.length === 0) {
    return base;
  }

  const suffix = emissions.map((entry) => formatTopMinerEmission(Number(entry))).join('/');
  return `${base} (${suffix})`;
}

function formatMinerCountTitle(value, topEmissions) {
  if (!Number.isInteger(value) || value < 0) {
    return 'Loading miner count';
  }

  let title;
  if (value > MINER_COUNT_DISPLAY_CAP) {
    title = `More than ${MINER_COUNT_DISPLAY_CAP} active miners with positive incentive (owner excluded)`;
  } else {
    title = `Active miners with positive incentive: ${value} (owner row excluded)`;
  }

  const emissions = Array.isArray(topEmissions)
    ? topEmissions.filter((entry) => Number.isFinite(Number(entry)))
    : [];
  if (shouldShowMinerEmissions() && emissions.length > 0) {
    const formatted = emissions.map((entry) => formatTopMinerEmission(Number(entry))).join(', ');
    title += `. Top ${emissions.length} miner emission: ${formatted}`;
  }

  return title;
}

function getIncentiveMinerCountFromData(data) {
  const count = Number(data?.incentiveMinerCount);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function getTopMinerEmissionsFromData(data) {
  const emissions = data?.topMinerEmissions;
  if (!Array.isArray(emissions)) {
    return null;
  }

  const normalized = emissions
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);

  return normalized.length > 0 ? normalized : null;
}

function parseMinerCountFromCell(minersCell) {
  const text = normalizeText(minersCell?.textContent);
  if (!text || text === '…' || text === '—') {
    return null;
  }

  const baseText = text.split('(')[0].trim();
  const capped = baseText.match(/^(\d+)\+$/);
  if (capped) {
    return Number(capped[1]) + 1;
  }

  const count = Number(baseText.replace(/,/g, ''));
  return Number.isInteger(count) && count >= 0 ? count : null;
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

  if (sortKey === 'miners') {
    const minerCount = getIncentiveMinerCountFromData(data);
    if (minerCount != null) {
      return minerCount;
    }
    return parseMinerCountFromCell(row.querySelector(`.${COLUMN.MINERS}`));
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

  const alreadySorted = indexed.every(({ row }, index) => row === rows[index]);
  updateAnalyticsSortIndicators(tableInfo);
  if (alreadySorted) {
    return;
  }

  isSorting = true;
  try {
    const fragment = document.createDocumentFragment();
    indexed.forEach(({ row }) => fragment.appendChild(row));
    tbody.appendChild(fragment);
  } finally {
    isSorting = false;
  }
}

function ensureColumnSortDelegation(tableInfo) {
  const table = tableInfo.table;
  attachNativeSortObserver(tableInfo);

  if (table.dataset.taoAnalyticsColumnSortBound === '1') {
    return;
  }

  table.dataset.taoAnalyticsColumnSortBound = '1';
  table.addEventListener('click', (event) => {
    if (isColumnMoveHandle(event.target)) {
      return;
    }

    const th = event.target.closest('thead th');
    if (!th) {
      return;
    }

    if (isAnalyticsSortHeader(th)) {
      event.preventDefault();
      event.stopPropagation();

      const sortKey = th.dataset.taoAnalyticsSort;
      const nextDirection =
        columnSortState.key === sortKey && columnSortState.direction === 'desc'
          ? 'asc'
          : 'desc';

      columnSortState = { key: sortKey, direction: nextDirection };
      applyColumnSort(tableInfo);
      return;
    }

    if (event.target.closest('thead th button')) {
      clearAnalyticsColumnSort(tableInfo);
    }
  }, true);
}

function createBodyCell(className, text, title, referenceTd, widthPx) {
  const td = document.createElement('td');
  td.className = `tao-analytics-cell ${className}`;
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
  let minersHeader = headerRow.querySelector(`.${COLUMN.MINERS}`);

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

  if (!minersHeader) {
    minersHeader = createHeaderCell(
      'Miners',
      COLUMN.MINERS,
      'Miners with positive incentive in the metagraph table (excludes owner/burn row)',
      refTh,
      getMinersColumnWidth(),
      'miners'
    );
    insertAfter(feeHeader, minersHeader);
  } else {
    populateSortableHeader(minersHeader, 'Miners', refTh, 'miners');
  }

  applyColumnWidth(burnHeader, COLUMN_WIDTH.burn);
  applyColumnWidth(feeHeader, COLUMN_WIDTH.fee);
  applyColumnWidth(minersHeader, getMinersColumnWidth());
  syncAnalyticsColumnWidths(tableInfo);

  return { burnHeader, feeHeader, minersHeader, nameTh, refTh };
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
  const taoUsd = taoUsdPrice ?? data?.taoUsd ?? scrapeTaoUsdPrice() ?? null;
  const regFee = formatRegFeeDisplay(data, taoUsd);
  const feeText = data ? regFee.text : '—';
  const feeTitle = data ? regFee.title : 'Loading registration fee';
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
  const minerCount = getIncentiveMinerCountFromData(data);
  const topEmissions = getTopMinerEmissionsFromData(data);
  const minersText = data ? formatMinerCount(minerCount, topEmissions) : '—';
  const minersTitle = data ? formatMinerCountTitle(minerCount, topEmissions) : 'Loading miner count';

  let burnCell = row.querySelector(`.${COLUMN.BURN}`);
  let feeCell = row.querySelector(`.${COLUMN.FEE}`);
  let minersCell = row.querySelector(`.${COLUMN.MINERS}`);

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

  if (!minersCell) {
    minersCell = createBodyCell(
      COLUMN.MINERS,
      minersText,
      minersTitle,
      styleRef.refTd,
      getMinersColumnWidth()
    );
    insertAfter(feeCell, minersCell);
  } else {
    if (minersCell.textContent !== minersText) {
      minersCell.textContent = minersText;
    }
    if (minersCell.title !== minersTitle) {
      minersCell.title = minersTitle;
    }
    applyColumnWidth(minersCell, getMinersColumnWidth());
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
  ensureColumnReorder(tableInfo);
  syncAnalyticsColumnCells(tableInfo);
  tableInfo.table.querySelectorAll('tbody tr').forEach((row) => {
    enhanceRow(row, tableInfo, header, taoUsdPrice);
  });

  if (columnSortState.key) {
    applyColumnSort(tableInfo);
  }

  syncAnalyticsColumnWidths(tableInfo);
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
      if (isEnhancing || isSorting) {
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

function scheduleTableEnhance({ reloadCache = false, delayMs = ENHANCE_DEBOUNCE_MS } = {}) {
  if (reloadCache) {
    pendingCacheReload = true;
  }

  if (enhanceDebounceTimer != null) {
    clearTimeout(enhanceDebounceTimer);
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
  }, delayMs);
}

function scheduleCacheEnhance({ immediate = false } = {}) {
  scheduleTableEnhance({
    reloadCache: true,
    delayMs: immediate ? ENHANCE_IMMEDIATE_MS : ENHANCE_DEBOUNCE_MS,
  });
}

function scheduleEnhance() {
  scheduleTableEnhance({ reloadCache: false });
}

async function refreshMetricsAndEnhance(force = false) {
  const tableInfo = findSubnetTable();
  if (!tableInfo) {
    return;
  }

  try {
    await loadMetricsFromLocalCache(tableInfo);
  } catch {
    // Ignore cache read errors; we'll still attempt background fetch.
  }

  isEnhancing = true;
  try {
    enhanceTable(tableInfo);
  } finally {
    isEnhancing = false;
  }

  requestMetrics(tableInfo, force)
    .then(async () => {
      const latest = findSubnetTable();
      if (!latest) {
        return;
      }

      try {
        await loadMetricsFromLocalCache(latest);
      } catch {
        // Ignore cache read errors.
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

  await loadHideSubnetTradingViewPreference();
  initSubnetTradingViewHider();
  await loadMetagraphScrapeDebugPreference();
  bindMetagraphScrapeDebugPreferenceListener();

  if (isSubnetPage()) {
    initSubnetPageScrape();
    initSubnetNavigator();
    return;
  }

  // Stop automatic background scraping; sync runs only via toolbar or row buttons.
  sendRuntimeMessage({ type: MESSAGE.STOP_BACKGROUND_TRACKING });

  await loadMinerEmissionsPreference();
  ensureMinerEmissionsToggle();
  ensureSyncButton();

  sendRuntimeMessage({ type: MESSAGE.SHEETS_PULL_IF_ENABLED }).catch(() => {});

  await refreshMetricsAndEnhance(false);

  // Repaint immediately when cache changes (subnet visit, sync, or background tracker).
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes?.[STORAGE_CACHE_KEY]) {
      scheduleCacheEnhance({ immediate: true });
    }

    if (changes?.[SYNC_STATUS_KEY]) {
      applySyncStatus(changes[SYNC_STATUS_KEY].newValue);
      scheduleCacheEnhance({ immediate: true });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE.METRICS_REFRESH) {
      handleMetricsRefreshMessage(message);
    }
    return false;
  });

  let attempts = 0;
  const bootstrap = setInterval(async () => {
    attempts += 1;
    ensureMinerEmissionsToggle();
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
  let lastIncentiveMinerCount = null;
  let lastTopMinerEmissions = null;
  const lastRegSignatureRef = { value: null };
  let lastHref = location.href;
  let lastEffectiveTab = getEffectiveActiveSubnetTab();
  let scrapeReadyTimer = null;
  let contextWatch = null;
  let observer = null;
  let urlWatcher = null;
  let tabStateWatcher = null;
  let burst = null;

  let metagraphScrapeChain = Promise.resolve();
  let aboutScrapeChain = Promise.resolve();

  const resetScrapeDedupState = () => {
    lastOwnerIncentive = null;
    lastIncentiveMinerCount = null;
    lastTopMinerEmissions = null;
    lastRegSignatureRef.value = null;
    lastMetagraphDebugSignature = null;
    lastAboutDebugSignature = null;
  };

  const onSubnetTabContextChange = () => {
    resetScrapeDedupState();
    tryScrape();
  };

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
    if (tabStateWatcher != null) {
      clearInterval(tabStateWatcher);
      tabStateWatcher = null;
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
    }, 150);
  };

  const scrapeOwnerIncentive = async () => {
    const ownerIncentive = collectOwnerIncentiveFromDom();
    if (ownerIncentive == null) {
      return {
        success: false,
        ownerIncentive: null,
        ownerCacheStatus: 'missing',
        cacheEntry: null,
      };
    }

    if (ownerIncentive === lastOwnerIncentive) {
      return {
        success: true,
        ownerIncentive,
        ownerCacheStatus: 'unchanged',
        cacheEntry: await resolveCacheEntryForNetuid(netuid),
      };
    }

    const upsert = await upsertMetricCache(netuid, {
      ownerIncentive,
      ownerIncentiveCapturedAt: Date.now(),
      source: 'dom',
    });

    if (upsert?.ok) {
      lastOwnerIncentive = ownerIncentive;
      return {
        success: true,
        ownerIncentive,
        ownerCacheStatus: 'updated',
        cacheEntry: upsert.entry ?? (await resolveCacheEntryForNetuid(netuid)),
      };
    }

    return {
      success: true,
      ownerIncentive,
      ownerCacheStatus: 'failed',
      cacheEntry: await resolveCacheEntryForNetuid(netuid),
    };
  };

  const scrapeIncentiveMinerCount = async () => {
    const minerMetrics = await collectIncentiveMinerCountFromMetagraphTable();
    if (minerMetrics == null || minerMetrics.count == null) {
      return {
        success: false,
        minerCount: null,
        topEmissions: null,
        minersCacheStatus: 'missing',
        cacheEntry: null,
      };
    }

    const { count: minerCount, topEmissions } = minerMetrics;
    if (
      minerCount === lastIncentiveMinerCount &&
      topMinerEmissionsEqual(topEmissions, lastTopMinerEmissions)
    ) {
      return {
        success: true,
        minerCount,
        topEmissions,
        minersCacheStatus: 'unchanged',
        cacheEntry: await resolveCacheEntryForNetuid(netuid),
      };
    }

    const upsert = await upsertMetricCache(netuid, {
      incentiveMinerCount: minerCount,
      topMinerEmissions: topEmissions,
      incentiveMinerCountCapturedAt: Date.now(),
      source: 'dom',
    });

    if (upsert?.ok) {
      lastIncentiveMinerCount = minerCount;
      lastTopMinerEmissions = topEmissions;
      return {
        success: true,
        minerCount,
        topEmissions,
        minersCacheStatus: 'updated',
        cacheEntry: upsert.entry ?? (await resolveCacheEntryForNetuid(netuid)),
      };
    }

    return {
      success: true,
      minerCount,
      topEmissions,
      minersCacheStatus: 'failed',
      cacheEntry: await resolveCacheEntryForNetuid(netuid),
    };
  };

  const scrapeRegFee = async () => {
    const finalizeRegFeeResult = async (result, source) => {
      if (!result) {
        return null;
      }

      const cacheEntry =
        result.cacheEntry ?? (await resolveCacheEntryForNetuid(netuid));

      return {
        success: result.cacheStatus === 'updated' || result.cacheStatus === 'unchanged',
        labelFound: true,
        valueText: result.valueText ?? null,
        burnTao: result.burnTao ?? null,
        burnUsd: result.burnUsd ?? null,
        taoUsd: result.taoUsd ?? null,
        regCacheStatus: result.cacheStatus ?? 'unknown',
        cacheEntry,
        source,
        diagnostics: {
          reason: result.reason ?? null,
        },
      };
    };

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
      const result = await finalizeRegFeeResult(
        await upsertRegFeePatch(netuid, valueText, lastRegSignatureRef),
        'parameters_panel'
      );
      if (result) {
        return result;
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
      const result = await finalizeRegFeeResult(
        await upsertRegFeePatch(netuid, valueText, lastRegSignatureRef),
        'legacy_layout'
      );
      if (result) {
        return result;
      }
    }

    return {
      success: false,
      labelFound: false,
      valueText: null,
      burnTao: null,
      burnUsd: null,
      taoUsd: scrapeTaoUsdPrice(),
      regCacheStatus: 'missing',
      cacheEntry: await resolveCacheEntryForNetuid(netuid),
      source: null,
      diagnostics: {
        reason: 'reg_label_not_found',
      },
    };
  };

  const tryScrape = async () => {
    if (!isExtensionContextValid()) {
      teardownSubnetScrape();
      return;
    }

    const effectiveTab = getEffectiveActiveSubnetTab();
    let scraped = false;

    if (effectiveTab === 'metagraph') {
      metagraphScrapeChain = metagraphScrapeChain
        .then(async () => {
          if (!isExtensionContextValid() || getEffectiveActiveSubnetTab() !== 'metagraph') {
            return;
          }

          const ownerResult = await scrapeOwnerIncentive();
          const minerResult = await scrapeIncentiveMinerCount();
          const scraped = ownerResult.success || minerResult.success;
          const cacheEntry =
            minerResult.cacheEntry ??
            ownerResult.cacheEntry ??
            (await resolveCacheEntryForNetuid(netuid));
          const overallCacheStatus = deriveOverallCacheStatus({
            ownerCacheStatus: ownerResult.ownerCacheStatus,
            minersCacheStatus: minerResult.minersCacheStatus,
            cacheEntry,
          });

          if (scraped && (ownerResult.success || minerResult.success)) {
            maybeShowMetagraphScrapeDebugModal(netuid, {
              ownerIncentive: ownerResult.ownerIncentive,
              ownerCacheStatus: ownerResult.ownerCacheStatus,
              minerCount: minerResult.minerCount,
              topEmissions: minerResult.topEmissions,
              minersCacheStatus: minerResult.minersCacheStatus,
              overallCacheStatus,
              cacheEntry,
              diagnostics: {
                ownerSuccess: ownerResult.success,
                minersSuccess: minerResult.success,
              },
            });
          }

          if (scraped || isMetagraphScrapePageReady()) {
            notifyScrapeReady();
          }
        })
        .catch(() => {});

      return;
    }

    if (effectiveTab === 'about') {
      aboutScrapeChain = aboutScrapeChain
        .then(async () => {
          if (!isExtensionContextValid() || getEffectiveActiveSubnetTab() !== 'about') {
            return;
          }

          const regResult = await scrapeRegFee();
          const scraped = regResult.success || regResult.labelFound;

          if (regResult.labelFound || isAboutScrapePageReady()) {
            maybeShowAboutScrapeDebugModal(netuid, regResult);
          }

          if (scraped || isAboutScrapePageReady()) {
            notifyScrapeReady();
          }
        })
        .catch(() => {});

      return;
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
    onSubnetTabContextChange();
  }, 400);

  tabStateWatcher = setInterval(() => {
    if (!isExtensionContextValid()) {
      teardownSubnetScrape();
      return;
    }

    const effectiveTab = getEffectiveActiveSubnetTab();
    if (effectiveTab === lastEffectiveTab) {
      return;
    }

    lastEffectiveTab = effectiveTab;
    onSubnetTabContextChange();
  }, 400);

  document.addEventListener(
    'click',
    (event) => {
      const tab = event.target.closest?.('[role="tab"]');
      if (tab?.closest('[role="tablist"]')) {
        setTimeout(onSubnetTabContextChange, 0);
        setTimeout(onSubnetTabContextChange, 250);
      }
    },
    true
  );

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
