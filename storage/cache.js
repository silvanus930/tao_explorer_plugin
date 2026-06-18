const CACHE_KEY = 'subnetMetricsCache';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function normalizeCacheKey(key, entry) {
  const netuid = Number(entry?.netuid ?? key);
  if (!Number.isInteger(netuid) || netuid < 0) {
    return null;
  }
  return String(netuid);
}

function entryFreshness(entry) {
  if (!entry || typeof entry !== 'object') {
    return 0;
  }

  const stamps = [
    entry.updatedAt,
    entry.cachedAt,
    entry.domCapturedAt,
    entry.rpcCapturedAt,
    entry.ownerIncentiveCapturedAt,
    entry.incentiveMinerCountCapturedAt,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  return stamps.length > 0 ? Math.max(...stamps) : 0;
}

function normalizeCacheMap(map = {}) {
  const out = {};
  Object.entries(map || {}).forEach(([key, entry]) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }

    const cacheKey = normalizeCacheKey(key, entry);
    if (!cacheKey) {
      return;
    }

    const netuid = Number(entry.netuid ?? cacheKey);
    const updatedAt = entryFreshness(entry) || Date.now();
    out[cacheKey] = {
      ...entry,
      netuid,
      updatedAt,
    };
  });

  return out;
}

function mergeCacheEntry(existing, incoming) {
  const base =
    existing && typeof existing === 'object'
      ? existing
      : { netuid: Number(incoming?.netuid ?? 0) };
  const patch = incoming && typeof incoming === 'object' ? incoming : {};
  const netuid = Number(patch.netuid ?? base.netuid ?? 0);
  const updatedAt = Math.max(entryFreshness(base), entryFreshness(patch)) || Date.now();

  return {
    ...base,
    ...patch,
    netuid,
    updatedAt,
  };
}

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
      value: normalizeCacheMap(value),
    },
  });
}

async function replaceCacheMap(map, ttl = DEFAULT_TTL_MS) {
  await setCache(normalizeCacheMap(map), ttl);
}

async function updateCacheEntries(updates, ttl = DEFAULT_TTL_MS) {
  const current = normalizeCacheMap(await getCacheMap());
  const merged = { ...current };
  const now = Date.now();

  Object.entries(updates || {}).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') {
      return;
    }

    const cacheKey = normalizeCacheKey(key, value);
    if (!cacheKey) {
      return;
    }

    merged[cacheKey] = mergeCacheEntry(merged[cacheKey], {
      ...value,
      updatedAt: entryFreshness(value) || now,
    });
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
    sheetsPullOnLoad: false,
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
    pullOnLoad: settings.sheetsPullOnLoad === true,
    publicPull: settings.sheetsPublicPull !== false,
    usingDefaultSheet: !userSheet && Boolean(defaultSheet),
  };
}
