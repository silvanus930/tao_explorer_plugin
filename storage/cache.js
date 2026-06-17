const CACHE_KEY = 'subnetMetricsCache';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

async function getRawCacheEntry() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return stored[CACHE_KEY] ?? null;
}

async function getCacheMap() {
  const entry = await getRawCacheEntry();
  if (!entry || !entry.value) {
    return {};
  }

  return entry.value;
}

async function getCache() {
  return getCacheMap();
}

async function getCacheMeta() {
  const entry = await getRawCacheEntry();
  if (!entry) {
    return { timestamp: 0, ttl: DEFAULT_TTL_MS };
  }

  return {
    timestamp: entry.timestamp ?? 0,
    ttl: entry.ttl ?? DEFAULT_TTL_MS,
  };
}

async function setCache(value, ttl = DEFAULT_TTL_MS) {
  await chrome.storage.local.set({
    [CACHE_KEY]: {
      timestamp: Date.now(),
      ttl,
      value,
    },
  });
}

async function updateCacheEntries(updates, ttl = DEFAULT_TTL_MS) {
  const current = await getCacheMap();
  // IMPORTANT: merge per-netuid so scraping patches (burnUsd, taoUsd, etc)
  // are not lost when RPC refresh writes burnTao/difficulty later.
  const merged = { ...current };

  const now = Date.now();

  Object.entries(updates || {}).forEach(([key, value]) => {
    const existing = merged[key];
    if (existing && typeof existing === 'object' && value && typeof value === 'object') {
      merged[key] = { ...existing, ...value, updatedAt: now };
    } else if (value && typeof value === 'object') {
      merged[key] = { ...value, updatedAt: now };
    } else {
      merged[key] = value;
    }
  });

  await setCache(merged, ttl);
}

async function clearCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}

async function getSettings() {
  const stored = await chrome.storage.sync.get({
    taoApiKey: '',
    refreshMinutes: 10,
    useTaoApi: false,
    sheetsEnabled: false,
    sheetsSpreadsheetId: '',
    sheetsAutoSync: true,
    sheetsPullOnLoad: true,
    sheetsPublicPull: true,
  });
  return stored;
}

function getDefaultSheetUrl() {
  return typeof DEFAULT_SHEET_URL === 'string' ? DEFAULT_SHEET_URL.trim() : '';
}

async function getSheetsSettings() {
  const settings = await getSettings();
  const userSheet = String(settings.sheetsSpreadsheetId || '').trim();
  const defaultSheet =
    typeof DEFAULT_SHEET_URL === 'string' && DEFAULT_SHEET_URL.trim()
      ? DEFAULT_SHEET_URL.trim()
      : '';

  return {
    enabled: Boolean(settings.sheetsEnabled),
    spreadsheetId: userSheet || defaultSheet,
    autoSync: settings.sheetsAutoSync !== false,
    pullOnLoad: settings.sheetsPullOnLoad !== false,
    publicPull: settings.sheetsPublicPull !== false,
    usingDefaultSheet: !userSheet && Boolean(defaultSheet),
  };
}
