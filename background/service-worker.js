/* global decodeSubnetInfoValidated, decodeHyperparams, fetchSubnetMetrics, fetchAllSubnetRegFees, fetchSubnetFromTaoApp, normalizeTaoAppSubnet, fetchTaoUsdPrice, resolveTaoApiKey, buildRegFeeCachePatch, getCache, getCacheMeta, updateCacheEntries, getSettings, getSheetsSettings, pullCacheFromSheets, pullCacheFromPublicSheet, pushCacheToSheets, syncCacheWithSheets, createSpreadsheet, mergeCacheMaps, withGoogleToken, TAO_API_KEY, DEFAULT_SHEET_URL */

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
  '../api/sheetsSync.js',
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
  SHEETS_PUSH: 'SHEETS_PUSH',
  SHEETS_PULL: 'SHEETS_PULL',
  SHEETS_SYNC: 'SHEETS_SYNC',
  SHEETS_CREATE: 'SHEETS_CREATE',
  SHEETS_PULL_IF_ENABLED: 'SHEETS_PULL_IF_ENABLED',
};

let refreshPromise = null;
let trackingEnabled = false;
let trackingCursor = 0;
let syncAbort = false;
let syncPromise = null;
let sheetsAutoSyncTimer = null;
const TRACKING_ALARM = 'track-missing-subnet-metrics';
const SYNC_STATUS_KEY = 'subnetSyncStatus';
const TRACKING_NETUID_MAX = 256;
const SCRAPE_WAIT_MS = 4_000;
const SCRAPE_READY_TIMEOUT_MS = 15_000;
const ABORT_POLL_MS = 200;

function subnetMetagraphUrl(netuid) {
  return `https://www.tao.app/subnets/${netuid}?active_tab=metagraph`;
}

function hrefMatchesScrapeTab(href, scrapeTab) {
  const normalized = String(href || '').toLowerCase();
  if (scrapeTab === 'metagraph') {
    return normalized.includes('active_tab=metagraph');
  }
  return true;
}

let scrapeWindowId = null;
let scrapeMetagraphTabId = null;

function needsMetagraphScrape(entry) {
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
      updates[netuid] = patch;
    }
  });

  if (Object.keys(updates).length > 0) {
    await updateCacheEntries(updates, ttl);
  }

  return Object.keys(updates).length;
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

async function ensureMetagraphScrapeTab() {
  const windowId = await getScrapeWindow();
  if (windowId == null) {
    return null;
  }

  if (scrapeMetagraphTabId != null) {
    try {
      await chrome.tabs.get(scrapeMetagraphTabId);
      return scrapeMetagraphTabId;
    } catch {
      scrapeMetagraphTabId = null;
    }
  }

  const tabs = await chrome.tabs.query({ windowId });
  const existing = tabs
    .filter((tab) => tab.id != null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];

  if (existing?.id != null) {
    scrapeMetagraphTabId = existing.id;
    return scrapeMetagraphTabId;
  }

  const tab = await chrome.tabs.create({
    windowId,
    url: 'about:blank',
    active: false,
  });
  scrapeMetagraphTabId = tab.id ?? null;
  return scrapeMetagraphTabId;
}

async function closeScrapeWindow() {
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
  scrapeMetagraphTabId = null;
}

async function notifyExplorerRefresh() {
  const tabs = await chrome.tabs.query({
    url: ['https://www.tao.app/explorer*', 'https://tao.app/explorer*'],
  });

  await Promise.all(
    tabs.map((tab) => {
      if (tab.id == null) {
        return Promise.resolve();
      }
      return chrome.tabs.sendMessage(tab.id, { type: MESSAGE.METRICS_REFRESH }).catch(() => {});
    })
  );
}

async function scrapeUrlInTab(tabId, url, netuid, scrapeTab = null) {
  if (syncAbort || tabId == null) {
    return false;
  }

  try {
    await chrome.tabs.update(tabId, { url, active: false });
    await waitForTabComplete(tabId, 25_000);
    if (syncAbort) {
      return false;
    }

    const ready = await waitForUrlScrape(tabId, netuid, scrapeTab);
    if (syncAbort) {
      return false;
    }

    if (!ready) {
      await waitDelayAbortable(SCRAPE_WAIT_MS);
    }

    return true;
  } catch {
    return false;
  }
}

async function scrapeSubnetInHiddenTab(netuid, { metagraph = false } = {}) {
  if (!metagraph) {
    return;
  }

  const metagraphTabId = await ensureMetagraphScrapeTab();
  if (metagraphTabId == null) {
    return;
  }

  try {
    await scrapeUrlInTab(
      metagraphTabId,
      subnetMetagraphUrl(netuid),
      netuid,
      'metagraph'
    );
  } catch {
    // Ignore scrape failures; we'll retry later.
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
    await scrapeSubnetInHiddenTab(id, { metagraph: true });
  }
  await closeScrapeWindow();
  await notifyExplorerRefresh();
  await runSheetsPush({ interactive: false }).catch(() => {});

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

    await scrapeSubnetInHiddenTab(netuid, { metagraph: true });
    completed = i + 1;
  }

  await setSyncStatus({
    running: false,
    total: unique.length,
    done: completed,
    currentNetuid: null,
    cancelled: syncAbort,
    finishedAt: Date.now(),
  });

  await closeScrapeWindow();
  await notifyExplorerRefresh();
  await runSheetsPush({ interactive: false }).catch(() => {});
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
  await updateCacheEntries(merged, await getCacheTtlMs());
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
    await updateCacheEntries(pushed.mergedMap, await getCacheTtlMs());
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
  await updateCacheEntries(synced.mergedMap, await getCacheTtlMs());
  await notifyExplorerRefresh();

  return {
    ok: true,
    spreadsheetId: synced.spreadsheetId,
    rowCount: synced.rowCount,
    syncedAt: synced.syncedAt,
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
      await scrapeSubnetInHiddenTab(netuid, { metagraph: true });
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
      updates[netuid] = patch;
    }
  });

  if (Object.keys(updates).length > 0) {
    await updateCacheEntries(updates, ttl);
  }

  if (settings.useTaoApi && apiKey) {
    // Enrich only those we refreshed (best-effort).
    await Promise.all(
      unique.slice(0, 10).map(async (netuid) => {
        try {
          const payload = await fetchSubnetFromTaoApp(netuid, apiKey);
          const normalized = normalizeTaoAppSubnet(payload, netuid);
          if (normalized) {
            const patch = { [netuid]: normalized };
            await updateCacheEntries(patch, ttl);
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
    // Fire-and-forget refresh; next request will pick up new cache.
    refreshPromise = refreshMetricsFor(requested, { ttl, settings })
      .catch(() => {})
      .finally(() => {
        refreshPromise = null;
      });
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

        const cached = deserializeMetrics(await getCache());
        const current = cached.get(message.netuid) || { netuid: message.netuid };
        cached.set(message.netuid, { ...current, ...captured, source: 'tao.app' });
        await updateCacheEntries(serializeMetrics(cached));
        return { ok: true };
      }

      case MESSAGE.UPSERT_METRIC: {
        const { netuid, patch } = message || {};
        if (netuid == null || !patch || typeof patch !== 'object') {
          return { ok: false };
        }

        const cached = deserializeMetrics(await getCache());
        const current = cached.get(netuid) || { netuid };
        cached.set(netuid, { ...current, ...patch, source: patch.source ?? current.source ?? 'dom' });
        await updateCacheEntries(serializeMetrics(cached));
        return { ok: true };
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
    sheetsPullOnLoad: true,
    sheetsDefaultsSeeded: false,
  });

  const updates = {};
  if (!String(stored.sheetsSpreadsheetId || '').trim()) {
    updates.sheetsSpreadsheetId = defaultSheet;
  }
  if (!stored.sheetsDefaultsSeeded) {
    updates.sheetsPublicPull = true;
    updates.sheetsPullOnLoad = true;
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
