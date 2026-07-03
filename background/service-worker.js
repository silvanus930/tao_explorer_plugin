/* global decodeSubnetInfoValidated, decodeHyperparams, fetchSubnetMetrics, fetchAllSubnetRegFees, fetchSubnetFromTaoApp, normalizeTaoAppSubnet, fetchTaoUsdPrice, resolveTaoApiKey, buildRegFeeCachePatch, fetchAllSubnetsLatest, fetchTaostatsPriceInfo, resolveTaostatsApiKey, isValidTaostatsAuth, buildTaostatsV2CachePatch, getCache, getCacheMeta, updateCacheEntries, updateCacheEntriesV2, getCacheMetaV2, replaceCacheMap, getSettings, getSheetsSettings, pullCacheFromSheets, pullCacheFromPublicSheet, pushCacheToSheets, syncCacheWithSheets, createSpreadsheet, mergeCacheMaps, withGoogleToken, TAO_API_KEY, TAOSTATS_API_KEY, DEFAULT_SHEET_URL */

try {
  importScripts('../config/secrets.js');
} catch {
  // Optional local API key from config/secrets.js (see scripts/sync-env.js).
}

try {
  importScripts('../config/defaults.js');
} catch {
  // Optional default sheet URL from config/defaults.js
}

importScripts(
  '../api/scaleDecoder.js',
  '../api/rpcClient.js',
  '../api/taoClient.js',
  '../api/taostatsClient.js',
  '../api/sheetsSync.js',
  '../api/cacheFile.js',
  '../storage/cache.js'
);

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
  CACHE_EXPORT: 'CACHE_EXPORT',
  CACHE_IMPORT: 'CACHE_IMPORT',
  REFRESH_V2_METRICS: 'REFRESH_V2_METRICS',
};

let refreshPromise = null;
let refreshV2Promise = null;
let explorerRefreshTimer = null;
let trackingEnabled = false;
let trackingCursor = 0;
let syncAbort = false;
let syncPromise = null;
let sheetsAutoSyncTimer = null;
const TRACKING_ALARM = 'track-missing-subnet-metrics';
const SYNC_STATUS_KEY = 'subnetSyncStatus';
const TRACKING_NETUID_MAX = 128;
const SCRAPE_WAIT_MS = 8_000;
const SCRAPE_READY_TIMEOUT_MS = 30_000;
const SYNC_TAB_LOAD_MS = 12_000;
const SYNC_SCRAPE_READY_MS = 18_000;
const SYNC_SCRAPE_FALLBACK_MS = 2_000;
const SUBNET_SYNC_BUDGET_MS = 60_000;
const SCRAPE_WINDOW_IDLE_CLOSE_MS = 120_000;
const ABORT_POLL_MS = 200;
const SHEETS_PUSH_TIMEOUT_MS = 20_000;
const TAOSTATS_V2_REFRESH_TIMEOUT_MS = 75_000;

function subnetPageUrl(netuid, activeTab = 'metagraph') {
  const base = `https://www.tao.app/subnets/${netuid}`;
  if (!activeTab) {
    return base;
  }
  return `${base}?active_tab=${encodeURIComponent(activeTab)}`;
}

function subnetMetagraphUrl(netuid) {
  return subnetPageUrl(netuid, 'metagraph');
}

function subnetAboutUrl(netuid) {
  return subnetPageUrl(netuid, 'about');
}

function hrefMatchesScrapeTab(href, scrapeTab) {
  const normalized = String(href || '').toLowerCase();
  if (scrapeTab === 'metagraph') {
    return normalized.includes('active_tab=metagraph');
  }
  if (scrapeTab === 'about') {
    return normalized.includes('active_tab=about');
  }
  return true;
}

let scrapeWindowId = null;
let scrapeAboutTabId = null;
let scrapeMetagraphTabId = null;
let scrapeWindowCloseTimer = null;

function needsTopMinerEmissionsScrape(entry) {
  const count = Number(entry?.incentiveMinerCount);
  if (!Number.isInteger(count) || count <= 0) {
    return false;
  }

  const emissions = entry?.topMinerEmissions;
  return !Array.isArray(emissions) || emissions.length === 0;
}

function needsMetagraphScrape(entry) {
  if (needsIncentiveMinerCount(entry)) {
    return true;
  }

  if (needsTopMinerEmissionsScrape(entry)) {
    return true;
  }

  if (!entry || entry.ownerIncentive == null) {
    return true;
  }

  const raw = Number(entry.ownerIncentive);
  if (!Number.isFinite(raw)) {
    return true;
  }

  if (raw >= 0 && raw <= 1) {
    return false;
  }

  if (raw > 1 && raw <= 100) {
    return false;
  }

  return true;
}

function needsRegFeeScrape(entry) {
  return !entry || entry.burnTao == null;
}

function needsIncentiveMinerCount(entry) {
  const count = Number(entry?.incentiveMinerCount);
  return !Number.isInteger(count) || count < 0;
}

async function applyBulkRegFees(netuids, settings, ttl) {
  const unique = [...new Set((netuids || []).map(Number))].filter(
    (n) => Number.isInteger(n) && n >= 0
  );
  if (unique.length === 0) {
    return 0;
  }

  const apiKey = resolveTaoApiKey(settings);
  let taoUsd = null;

  if (apiKey) {
    try {
      taoUsd = await fetchTaoUsdPrice(apiKey);
    } catch {
      // USD conversion is optional; TAO burn still lands in cache.
    }
  }

  const burns = await fetchAllSubnetRegFees(unique);
  const updates = {};

  burns.forEach((metric, netuid) => {
    const patch = buildRegFeeCachePatch(metric, taoUsd);
    if (patch) {
      updates[String(netuid)] = patch;
    }
  });

  if (Object.keys(updates).length > 0) {
    await updateCacheEntries(updates, ttl);
    scheduleExplorerRefresh();
  }

  return Object.keys(updates).length;
}

async function refreshTaostatsV2Metrics(settings, ttl) {
  if (!settings?.enableV2) {
    return { ok: false, count: 0, error: 'enableV2 is off in settings' };
  }

  const auth = resolveTaostatsApiKey(settings);
  if (!auth) {
    return {
      ok: false,
      count: 0,
      error:
        'Missing taostats API key — add TAOSTATS_API_KEY in .env, run node scripts/sync-env.js, then reload the extension',
    };
  }

  if (!isValidTaostatsAuth(auth)) {
    return {
      ok: false,
      count: 0,
      error: 'Invalid taostats API key format — expected tao-<uuid>:<secret>',
    };
  }

  const result = await fetchAllSubnetsLatest(auth);
  if (!Array.isArray(result)) {
    const message =
      result?.message || result?.error || 'taostats fetch failed';
    console.warn('[TAO Subnet Analytics] taostats v2 fetch failed:', message, result?.response);
    return { ok: false, count: 0, error: message, detail: result?.response ?? result };
  }

  const updates = {};
  result.forEach((row) => {
    const patch = buildTaostatsV2CachePatch(row, null);
    if (patch) {
      updates[String(patch.netuid)] = patch;
    }
  });

  const count = Object.keys(updates).length;
  if (count === 0) {
    return { ok: false, count: 0, error: 'taostats returned no usable subnet rows' };
  }

  try {
    await updateCacheEntriesV2(updates, ttl);
  } catch (error) {
    console.warn('[TAO Subnet Analytics] v2 cache write failed:', error);
    return {
      ok: false,
      count: 0,
      error: error?.message || 'Failed to save taostats v2 cache',
    };
  }

  scheduleExplorerRefresh();

  void fetchTaostatsPriceInfo(auth)
    .then(async (priceInfo) => {
      const price = Number(priceInfo?.price_usd);
      if (!Number.isFinite(price) || price <= 0) {
        return;
      }

      const pricedUpdates = {};
      Object.values(updates).forEach((entry) => {
        if (entry?.burnTao == null) {
          return;
        }
        pricedUpdates[String(entry.netuid)] = {
          ...entry,
          taoUsd: price,
          burnUsd: Number(entry.burnTao) * price,
          updatedAt: Date.now(),
        };
      });

      if (Object.keys(pricedUpdates).length > 0) {
        await updateCacheEntriesV2(pricedUpdates, ttl);
        scheduleExplorerRefresh();
      }
    })
    .catch(() => {});

  console.info('[TAO Subnet Analytics] taostats v2 saved', count, 'subnets');
  return { ok: true, count };
}

async function runTaostatsV2Refresh(settings, ttl) {
  return withTimeout(
    refreshTaostatsV2Metrics(settings, ttl),
    TAOSTATS_V2_REFRESH_TIMEOUT_MS,
    'taostats v2 refresh'
  ).catch((error) => ({
    ok: false,
    count: 0,
    error: error?.message || 'taostats v2 refresh failed',
  }));
}

async function queueTaostatsV2Refresh(settings, ttl) {
  if (refreshV2Promise) {
    return refreshV2Promise;
  }

  refreshV2Promise = runTaostatsV2Refresh(settings, ttl).finally(() => {
    refreshV2Promise = null;
  });

  return refreshV2Promise;
}

async function ensureTaostatsV2Metrics(settings, ttl, { force = false } = {}) {
  if (!settings?.enableV2) {
    return 0;
  }

  const auth = resolveTaostatsApiKey(settings);
  if (!auth) {
    return 0;
  }

  const cacheMeta = await getCacheMetaV2();
  const isStale = !force && cacheMeta.timestamp && Date.now() - cacheMeta.timestamp > ttl;

  if (!isStale && cacheMeta.timestamp > 0) {
    return 0;
  }

  const result = await queueTaostatsV2Refresh(settings, ttl);
  return result?.count ?? 0;
}

async function setSyncStatus(status) {
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: status });
}

async function waitForTabComplete(tabId, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const abortPoll = setInterval(() => {
      if (syncAbort) {
        cleanup();
        resolve(false);
      }
    }, ABORT_POLL_MS);

    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        cleanup();
        resolve(true);
      }
    };

    function cleanup() {
      clearInterval(abortPoll);
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function waitDelayAbortable(ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (syncAbort) {
      return false;
    }
    await new Promise((r) => setTimeout(r, ABORT_POLL_MS));
  }
  return !syncAbort;
}

async function waitForUrlScrape(tabId, netuid, scrapeTab = null, timeoutMs = SCRAPE_READY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const abortPoll = setInterval(() => {
      if (syncAbort) {
        cleanup();
        resolve(false);
      }
    }, ABORT_POLL_MS);

    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    function listener(message, sender) {
      if (message?.type !== MESSAGE.SCRAPE_PAGE_READY) {
        return;
      }
      if (sender.tab?.id !== tabId) {
        return;
      }
      if (Number(message.netuid) !== Number(netuid)) {
        return;
      }
      if (scrapeTab && !hrefMatchesScrapeTab(message.href, scrapeTab)) {
        return;
      }

      cleanup();
      resolve(true);
    }

    function cleanup() {
      clearInterval(abortPoll);
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
    }

    chrome.runtime.onMessage.addListener(listener);
  });
}

async function getScrapeWindow() {
  if (scrapeWindowId != null) {
    try {
      await chrome.windows.get(scrapeWindowId);
      return scrapeWindowId;
    } catch {
      scrapeWindowId = null;
      scrapeAboutTabId = null;
      scrapeMetagraphTabId = null;
    }
  }

  const win = await chrome.windows.create({
    url: 'about:blank',
    state: 'minimized',
    focused: false,
  });

  scrapeWindowId = win.id ?? null;
  return scrapeWindowId;
}

async function ensureScrapeTab(getId, setId) {
  const windowId = await getScrapeWindow();
  if (windowId == null) {
    return null;
  }

  const cachedId = getId();
  if (cachedId != null) {
    try {
      const tab = await chrome.tabs.get(cachedId);
      if (tab.windowId === windowId) {
        return cachedId;
      }
    } catch {
      setId(null);
    }
  }

  const tab = await chrome.tabs.create({
    windowId,
    url: 'about:blank',
    active: false,
  });
  const id = tab.id ?? null;
  setId(id);
  return id;
}

async function ensureAboutScrapeTab() {
  return ensureScrapeTab(
    () => scrapeAboutTabId,
    (id) => {
      scrapeAboutTabId = id;
    }
  );
}

async function ensureMetagraphScrapeTab() {
  return ensureScrapeTab(
    () => scrapeMetagraphTabId,
    (id) => {
      scrapeMetagraphTabId = id;
    }
  );
}

async function closeScrapeWindow() {
  if (scrapeWindowCloseTimer) {
    clearTimeout(scrapeWindowCloseTimer);
    scrapeWindowCloseTimer = null;
  }

  if (scrapeWindowId == null) {
    scrapeMetagraphTabId = null;
    return;
  }

  try {
    await chrome.windows.remove(scrapeWindowId);
  } catch {
    // window may already be closed
  }

  scrapeWindowId = null;
  scrapeAboutTabId = null;
  scrapeMetagraphTabId = null;
}

function scheduleScrapeWindowClose(delayMs = SCRAPE_WINDOW_IDLE_CLOSE_MS) {
  if (scrapeWindowCloseTimer) {
    clearTimeout(scrapeWindowCloseTimer);
  }

  scrapeWindowCloseTimer = setTimeout(async () => {
    scrapeWindowCloseTimer = null;
    if (syncPromise) {
      scheduleScrapeWindowClose(delayMs);
      return;
    }
    await closeScrapeWindow();
  }, delayMs);
}

function cancelScrapeWindowClose() {
  if (scrapeWindowCloseTimer) {
    clearTimeout(scrapeWindowCloseTimer);
    scrapeWindowCloseTimer = null;
  }
}

async function notifyExplorerRefresh(payload = {}) {
  const tabs = await chrome.tabs.query({
    url: ['https://www.tao.app/explorer*', 'https://tao.app/explorer*'],
  });

  await Promise.all(
    tabs.map((tab) => {
      if (tab.id == null) {
        return Promise.resolve();
      }
      return chrome.tabs
        .sendMessage(tab.id, {
          type: MESSAGE.METRICS_REFRESH,
          ...payload,
        })
        .catch(() => {});
    })
  );
}

async function notifyExplorerMetricsUpdate(netuid, entry) {
  if (netuid == null || !entry || typeof entry !== 'object') {
    await notifyExplorerRefresh();
    return;
  }

  await notifyExplorerRefresh({
    netuid: Number(netuid),
    entry,
  });
}

function scheduleExplorerRefresh(payload = {}) {
  if (explorerRefreshTimer) {
    clearTimeout(explorerRefreshTimer);
  }

  if (payload.netuid != null && payload.entry) {
    notifyExplorerMetricsUpdate(payload.netuid, payload.entry).catch(() => {});
    return;
  }

  explorerRefreshTimer = setTimeout(() => {
    explorerRefreshTimer = null;
    notifyExplorerRefresh().catch(() => {});
  }, 0);
}

async function withTimeout(promise, timeoutMs, label = 'operation') {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runSheetsPushAfterSync() {
  try {
    await withTimeout(
      runSheetsPush({ interactive: false }),
      SHEETS_PUSH_TIMEOUT_MS,
      'Sheets push after sync'
    );
  } catch {
    // Sync results stay in local cache even if push fails or times out.
  }
}

async function scrapeUrlInTab(tabId, url, netuid, scrapeTab = null, timeouts = {}) {
  if (syncAbort || tabId == null) {
    return false;
  }

  const tabLoadMs = timeouts.tabLoadMs ?? 25_000;
  const scrapeReadyMs = timeouts.scrapeReadyMs ?? SCRAPE_READY_TIMEOUT_MS;
  const scrapeWaitMs = timeouts.scrapeWaitMs ?? SCRAPE_WAIT_MS;

  cancelScrapeWindowClose();

  try {
    await chrome.tabs.update(tabId, { url, active: true });
    await waitForTabComplete(tabId, tabLoadMs);
    if (syncAbort) {
      return false;
    }

    const ready = await waitForUrlScrape(tabId, netuid, scrapeTab, scrapeReadyMs);
    if (syncAbort) {
      return false;
    }

    if (!ready) {
      await waitDelayAbortable(scrapeWaitMs);
    }

    return true;
  } catch {
    return false;
  }
}

async function scrapeSubnetInHiddenTab(
  netuid,
  { about = true, metagraph = true } = {},
  budgetMs = SUBNET_SYNC_BUDGET_MS
) {
  const started = Date.now();
  const timeLeft = () => Math.max(0, budgetMs - (Date.now() - started));

  const buildTimeouts = () => ({
    tabLoadMs: Math.min(SYNC_TAB_LOAD_MS, Math.max(3_000, timeLeft())),
    scrapeReadyMs: Math.min(SYNC_SCRAPE_READY_MS, Math.max(3_000, timeLeft())),
    scrapeWaitMs: SYNC_SCRAPE_FALLBACK_MS,
  });

  const tasks = [];

  if (about && !syncAbort) {
    tasks.push(
      (async () => {
        const tabId = await ensureAboutScrapeTab();
        if (tabId == null || syncAbort) {
          return;
        }
        await scrapeUrlInTab(
          tabId,
          subnetAboutUrl(netuid),
          netuid,
          'about',
          buildTimeouts()
        );
      })()
    );
  }

  if (metagraph && !syncAbort) {
    tasks.push(
      (async () => {
        const tabId = await ensureMetagraphScrapeTab();
        if (tabId == null || syncAbort) {
          return;
        }
        await scrapeUrlInTab(
          tabId,
          subnetMetagraphUrl(netuid),
          netuid,
          'metagraph',
          buildTimeouts()
        );
      })()
    );
  }

  if (tasks.length === 0) {
    return;
  }

  try {
    await withTimeout(Promise.all(tasks), budgetMs, `sync subnet ${netuid}`);
  } catch {
    // Move on to the next subnet when this one exceeds the budget.
  } finally {
    scheduleExplorerRefresh();
  }
}

async function runSyncSingle(netuid) {
  const id = Number(netuid);
  if (!Number.isInteger(id) || id < 0) {
    return;
  }

  syncAbort = false;
  const settings = await getSettings();
  const ttl = Math.max(1, settings.refreshMinutes) * 60 * 1000;

  await setSyncStatus({
    running: true,
    total: 1,
    done: 0,
    currentNetuid: id,
    mode: 'single',
    startedAt: Date.now(),
  });

  await applyBulkRegFees([id], settings, ttl);
  if (!syncAbort) {
    await scrapeSubnetInHiddenTab(id, { about: true, metagraph: true });
  }
  scheduleScrapeWindowClose();
  await notifyExplorerRefresh();
  runSheetsPushAfterSync();

  await setSyncStatus({
    running: false,
    total: 1,
    done: 1,
    currentNetuid: null,
    mode: 'single',
    finishedAt: Date.now(),
  });
}

async function runSyncAll(netuids) {
  const unique = [...new Set((netuids || []).map(Number))].filter(
    (n) => Number.isInteger(n) && n >= 0
  );

  syncAbort = false;
  const settings = await getSettings();
  const ttl = Math.max(1, settings.refreshMinutes) * 60 * 1000;

  await setSyncStatus({
    running: true,
    total: unique.length,
    done: 0,
    currentNetuid: null,
    startedAt: Date.now(),
  });

  await applyBulkRegFees(unique, settings, ttl);

  let completed = 0;

  for (let i = 0; i < unique.length; i += 1) {
    if (syncAbort) {
      break;
    }

    const netuid = unique[i];
    await setSyncStatus({
      running: true,
      total: unique.length,
      done: i,
      currentNetuid: netuid,
      startedAt: Date.now(),
    });

    await scrapeSubnetInHiddenTab(netuid, { about: true, metagraph: true });
    completed = i + 1;

    await setSyncStatus({
      running: true,
      total: unique.length,
      done: completed,
      currentNetuid: netuid,
      startedAt: Date.now(),
    });
    scheduleExplorerRefresh();
  }

  await setSyncStatus({
    running: false,
    total: unique.length,
    done: completed,
    currentNetuid: null,
    cancelled: syncAbort,
    finishedAt: Date.now(),
  });

  scheduleScrapeWindowClose();
  await notifyExplorerRefresh();
  runSheetsPushAfterSync();
}

async function getCacheTtlMs() {
  const settings = await getSettings();
  return Math.max(1, settings.refreshMinutes) * 60 * 1000;
}

function scheduleSheetsAutoSync() {
  if (sheetsAutoSyncTimer) {
    clearTimeout(sheetsAutoSyncTimer);
  }

  sheetsAutoSyncTimer = setTimeout(() => {
    sheetsAutoSyncTimer = null;
    runSheetsPush({ interactive: false }).catch(() => {});
  }, 8_000);
}

async function maybeScheduleSheetsAutoSync() {
  const sheets = await getSheetsSettings();
  if (!sheets.enabled || !sheets.autoSync || !sheets.spreadsheetId) {
    return;
  }

  scheduleSheetsAutoSync();
}

async function runSheetsPull({ interactive = true } = {}) {
  const sheets = await getSheetsSettings();
  if (!sheets.spreadsheetId) {
    throw new Error('Add a Google Sheets URL or spreadsheet ID in extension settings');
  }

  const localMap = await getCache();
  const pulled = await pullCacheFromSheets(sheets.spreadsheetId, {
    interactive,
    preferPublic: sheets.publicPull,
  });
  const merged = mergeCacheMaps(localMap, pulled.remoteMap);
  await replaceCacheMap(merged, await getCacheTtlMs());
  await notifyExplorerRefresh();

  return {
    ok: true,
    spreadsheetId: pulled.spreadsheetId,
    rowCount: Object.keys(merged).length,
    remoteRows: pulled.rowCount,
    source: pulled.source || 'oauth',
  };
}

async function runSheetsPush({ interactive = true } = {}) {
  const sheets = await getSheetsSettings();
  if (!sheets.spreadsheetId) {
    throw new Error('Add a Google Sheets URL or spreadsheet ID in extension settings');
  }

  const localMap = await getCache();
  try {
    const pushed = await pushCacheToSheets(sheets.spreadsheetId, localMap, { interactive });
    await replaceCacheMap(pushed.mergedMap, await getCacheTtlMs());
    await notifyExplorerRefresh();

    return {
      ok: true,
      spreadsheetId: pushed.spreadsheetId,
      rowCount: pushed.rowCount,
      pushedAt: pushed.pushedAt,
    };
  } catch (error) {
    if (/bad client id|oauth/i.test(String(error?.message || ''))) {
      throw new Error(
        'Push needs Google OAuth and is for the maintainer PC only. On other machines use Pull (public link, no sign-in).'
      );
    }
    throw error;
  }
}

async function runSheetsSync({ interactive = true } = {}) {
  const sheets = await getSheetsSettings();
  if (!sheets.spreadsheetId) {
    throw new Error('Add a Google Sheets URL or spreadsheet ID in extension settings');
  }

  const localMap = await getCache();
  const synced = await syncCacheWithSheets(sheets.spreadsheetId, localMap, { interactive });
  await replaceCacheMap(synced.mergedMap, await getCacheTtlMs());
  await notifyExplorerRefresh();

  return {
    ok: true,
    spreadsheetId: synced.spreadsheetId,
    rowCount: synced.rowCount,
    syncedAt: synced.syncedAt,
  };
}

async function exportCacheToFile() {
  const cache = await getCache();
  const meta = await getCacheMeta();
  return buildCacheExportPayload(cache, meta, chrome.runtime.getManifest().version);
}

async function importCacheFromFile(payload, { replace = false } = {}) {
  const remoteMap = normalizeImportedCacheMap(payload);
  if (!remoteMap) {
    return { ok: false, error: 'Invalid cache file format' };
  }

  const settings = await getSettings();
  const ttl = Math.max(1, settings.refreshMinutes) * 60 * 1000;
  const localMap = await getCache();
  const merged = replace ? remoteMap : mergeCacheMaps(localMap, remoteMap);

  await replaceCacheMap(merged, ttl);
  await notifyExplorerRefresh();

  return {
    ok: true,
    subnetCount: Object.keys(merged).length,
    importedCount: Object.keys(remoteMap).length,
    mode: replace ? 'replace' : 'merge',
  };
}

async function runSheetsPullIfEnabled() {
  const sheets = await getSheetsSettings();
  if (!sheets.spreadsheetId || !sheets.pullOnLoad) {
    return { ok: false, skipped: true };
  }

  if (!sheets.enabled && !sheets.publicPull) {
    return { ok: false, skipped: true };
  }

  return runSheetsPull({ interactive: false });
}

async function trackNextMissingSubnet() {
  if (!trackingEnabled) return;

  const cache = await getCache();
  // Scan sequentially; one netuid per alarm tick.
  for (let i = 0; i <= TRACKING_NETUID_MAX; i += 1) {
    const netuid = trackingCursor;
    trackingCursor = (trackingCursor + 1) % (TRACKING_NETUID_MAX + 1);

    const entry = cache?.[String(netuid)] ?? null;
    const regFee = needsRegFeeScrape(entry);
    const metagraph = needsMetagraphScrape(entry);

    if (regFee) {
      const settings = await getSettings();
      const ttl = Math.max(1, settings.refreshMinutes) * 60 * 1000;
      await applyBulkRegFees([netuid], settings, ttl);
    }

    if (metagraph) {
      await scrapeSubnetInHiddenTab(netuid, { about: true, metagraph: true });
      return;
    }
  }
}

function serializeMetrics(map) {
  return Object.fromEntries(map.entries());
}

function deserializeMetrics(object) {
  if (!object) {
    return new Map();
  }

  return new Map(
    Object.entries(object).map(([key, value]) => [Number(key), value])
  );
}

function withCacheFlags(map, { isStale, cachedAt }) {
  if (!cachedAt) {
    return map;
  }

  map.forEach((value, key) => {
    map.set(key, { ...value, stale: Boolean(isStale), cachedAt });
  });

  return map;
}

async function refreshMetricsFor(netuids, { ttl, settings }) {
  const unique = [...new Set((netuids || []).map(Number))].filter((n) => Number.isInteger(n));
  if (unique.length === 0) {
    return new Map();
  }

  const fetched = await fetchAllSubnetRegFees(unique);
  const updates = {};

  let taoUsd = null;
  const apiKey = resolveTaoApiKey(settings);
  if (apiKey) {
    try {
      taoUsd = await fetchTaoUsdPrice(apiKey);
    } catch {
      // Optional USD conversion.
    }
  }

  fetched.forEach((metric, netuid) => {
    const patch = buildRegFeeCachePatch(metric, taoUsd);
    if (patch) {
      updates[String(netuid)] = patch;
    }
  });

  if (Object.keys(updates).length > 0) {
    await updateCacheEntries(updates, ttl);
    scheduleExplorerRefresh();
  }

  if (settings.enableV2) {
    void ensureTaostatsV2Metrics(settings, ttl, { force: false });
  }

  if (settings.useTaoApi && apiKey) {
    // Enrich only those we refreshed (best-effort).
    await Promise.all(
      unique.slice(0, 10).map(async (netuid) => {
        try {
          const payload = await fetchSubnetFromTaoApp(netuid, apiKey);
          const normalized = normalizeTaoAppSubnet(payload, netuid);
          if (normalized) {
            await updateCacheEntries(
              {
                [String(netuid)]: normalized,
              },
              ttl
            );
          }
        } catch {
          // Ignore enrichment failures.
        }
      })
    );
  }

  return fetched;
}

async function ensureMetrics(netuids = [], { force = false } = {}) {
  const settings = await getSettings();
  const ttl = Math.max(1, settings.refreshMinutes) * 60 * 1000;
  const cacheMeta = await getCacheMeta();
  const isStale = !force && cacheMeta.timestamp && Date.now() - cacheMeta.timestamp > ttl;

  // Force refresh (used by explicit refresh) blocks until complete.
  if (force) {
    const fetched = await refreshMetricsFor(netuids, { ttl, settings });
    if (settings.enableV2) {
      await queueTaostatsV2Refresh(settings, ttl);
    }
    return withCacheFlags(fetched, { isStale: false, cachedAt: Date.now() });
  }

  // Cached-first behavior for best UX.
  const cached = deserializeMetrics(await getCache());
  const requested = [...new Set((netuids || []).map(Number))].filter((n) => Number.isInteger(n));
  const missing = requested.filter((netuid) => !cached.has(netuid));

  const response = new Map();
  requested.forEach((netuid) => {
    const value = cached.get(netuid);
    if (value) {
      response.set(netuid, value);
    }
  });

  withCacheFlags(response, { isStale, cachedAt: cacheMeta.timestamp });

  const shouldRefresh = isStale || missing.length > 0;
  if (shouldRefresh && !refreshPromise) {
    // Fire-and-forget refresh; notify explorer when cache lands.
    refreshPromise = refreshMetricsFor(requested, { ttl, settings })
      .then(() => {
        scheduleExplorerRefresh();
      })
      .catch(() => {})
      .finally(() => {
        refreshPromise = null;
      });
  }

  if (settings.enableV2) {
    void ensureTaostatsV2Metrics(settings, ttl, { force: false });
  }

  return response;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case MESSAGE.GET_SUBNET_METRICS: {
        const metrics = await ensureMetrics(message.netuids || []);
        return serializeMetrics(metrics);
      }

      case MESSAGE.REFRESH_METRICS: {
        await chrome.storage.local.remove('subnetMetricsCache');
        const metrics = await ensureMetrics(message.netuids || [], { force: true });
        return serializeMetrics(metrics);
      }

      case MESSAGE.CAPTURE_TAO_API: {
        const captured = normalizeTaoAppSubnet(message.payload, message.netuid);
        if (!captured) {
          return { ok: false };
        }

        const settings = await getSettings();
        const ttl = Math.max(1, settings.refreshMinutes) * 60 * 1000;
        await updateCacheEntries(
          {
            [String(message.netuid)]: {
              ...captured,
              netuid: Number(message.netuid),
              source: 'tao.app',
            },
          },
          ttl
        );
        scheduleExplorerRefresh();
        return { ok: true };
      }

      case MESSAGE.UPSERT_METRIC: {
        const { netuid, patch } = message || {};
        if (netuid == null || !patch || typeof patch !== 'object') {
          return { ok: false };
        }

        const settings = await getSettings();
        const ttl = Math.max(1, settings.refreshMinutes) * 60 * 1000;
        const key = String(netuid);

        await updateCacheEntries(
          {
            [key]: {
              ...patch,
              netuid: Number(netuid),
            },
          },
          ttl
        );

        const cache = await getCache();
        const entry = cache[key] ?? null;
        await notifyExplorerMetricsUpdate(Number(netuid), entry);
        return { ok: true, entry };
      }

      case MESSAGE.START_BACKGROUND_TRACKING: {
        trackingEnabled = true;
        // Alarm minimum is ~1 minute in Chrome; this approximates "30s per subnet".
        chrome.alarms.create(TRACKING_ALARM, { periodInMinutes: 1 });
        return { ok: true };
      }

      case MESSAGE.STOP_BACKGROUND_TRACKING: {
        trackingEnabled = false;
        await chrome.alarms.clear(TRACKING_ALARM);
        return { ok: true };
      }

      case MESSAGE.SYNC_ALL_SUBNETS: {
        if (syncPromise) {
          return { ok: false, error: 'Sync already running' };
        }

        const netuids = message.netuids || [];
        syncPromise = runSyncAll(netuids)
          .catch(() => {})
          .finally(() => {
            syncPromise = null;
            syncAbort = false;
          });

        return { ok: true, total: netuids.length };
      }

      case MESSAGE.SYNC_SINGLE_SUBNET: {
        if (syncPromise) {
          return { ok: false, error: 'Sync already running' };
        }

        const netuid = Number(message.netuid);
        if (!Number.isInteger(netuid) || netuid < 0) {
          return { ok: false, error: 'Invalid netuid' };
        }

        syncPromise = runSyncSingle(netuid)
          .catch(() => {})
          .finally(() => {
            syncPromise = null;
            syncAbort = false;
          });

        await syncPromise;
        return { ok: true, netuid };
      }

      case MESSAGE.CANCEL_SYNC: {
        syncAbort = true;
        await closeScrapeWindow();

        const stored = await chrome.storage.local.get(SYNC_STATUS_KEY);
        const current = stored[SYNC_STATUS_KEY];
        if (current?.running) {
          await setSyncStatus({
            running: false,
            total: current.total ?? 0,
            done: current.done ?? 0,
            currentNetuid: null,
            cancelled: true,
            finishedAt: Date.now(),
          });
        }

        await notifyExplorerRefresh();
        return { ok: true };
      }

      case MESSAGE.GET_SYNC_STATUS: {
        const stored = await chrome.storage.local.get(SYNC_STATUS_KEY);
        return stored[SYNC_STATUS_KEY] ?? { running: false };
      }

      case MESSAGE.REQUEST_EXPLORER_REFRESH: {
        notifyExplorerRefresh().catch(() => {});
        return { ok: true };
      }

      case MESSAGE.SCRAPE_PAGE_READY: {
        return { ok: true };
      }

      case MESSAGE.SHEETS_PUSH: {
        const result = await runSheetsPush({ interactive: true });
        return result;
      }

      case MESSAGE.SHEETS_PULL: {
        const result = await runSheetsPull({ interactive: true });
        return result;
      }

      case MESSAGE.SHEETS_SYNC: {
        const result = await runSheetsSync({ interactive: true });
        return result;
      }

      case MESSAGE.SHEETS_CREATE: {
        const created = await withGoogleToken(
          async (token) => createSpreadsheet(token, message.title || 'TAO Subnet Analytics Cache'),
          { interactive: true }
        );

        await chrome.storage.sync.set({
          sheetsEnabled: true,
          sheetsSpreadsheetId: created.spreadsheetId,
        });

        return created;
      }

      case MESSAGE.SHEETS_PULL_IF_ENABLED: {
        return runSheetsPullIfEnabled();
      }

      case MESSAGE.REFRESH_V2_METRICS: {
        const settings = await getSettings();
        if (!settings.enableV2) {
          return { ok: false, error: 'enableV2 is off' };
        }

        const ttl = Math.max(1, settings.refreshMinutes) * 60 * 1000;
        return queueTaostatsV2Refresh(settings, ttl);
      }

      case MESSAGE.CACHE_EXPORT: {
        const payload = await exportCacheToFile();
        return { ok: true, payload };
      }

      case MESSAGE.CACHE_IMPORT: {
        return importCacheFromFile(message.payload, {
          replace: Boolean(message.replace),
        });
      }

      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ error: error.message || 'Unknown error' });
    });

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes?.subnetMetricsCache) {
    return;
  }

  maybeScheduleSheetsAutoSync().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh-subnet-metrics', {
    periodInMinutes: 10,
  });

  seedCommunitySheetDefaults().catch(() => {});
});

async function seedCommunitySheetDefaults() {
  const defaultSheet = typeof DEFAULT_SHEET_URL === 'string' ? DEFAULT_SHEET_URL.trim() : '';
  if (!defaultSheet) {
    return;
  }

  const stored = await chrome.storage.sync.get({
    sheetsSpreadsheetId: '',
    sheetsPublicPull: true,
    sheetsPullOnLoad: false,
    sheetsDefaultsSeeded: false,
  });

  const updates = {};
  if (!String(stored.sheetsSpreadsheetId || '').trim()) {
    updates.sheetsSpreadsheetId = defaultSheet;
  }
  if (!stored.sheetsDefaultsSeeded) {
    updates.sheetsPublicPull = true;
    updates.sheetsDefaultsSeeded = true;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TRACKING_ALARM) {
    trackNextMissingSubnet().catch(() => {});
  }
});
