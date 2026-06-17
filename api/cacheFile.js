const CACHE_FILE_FORMAT = 'tao-subnet-analytics-cache';
const CACHE_FILE_VERSION = 1;

function sanitizeCacheMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return null;
  }

  const out = {};
  let count = 0;

  Object.entries(map).forEach(([key, entry]) => {
    const netuid = Number(entry?.netuid ?? key);
    if (!Number.isInteger(netuid) || netuid < 0 || !entry || typeof entry !== 'object') {
      return;
    }

    out[String(netuid)] = { ...entry, netuid };
    count += 1;
  });

  return count > 0 ? out : null;
}

function normalizeImportedCacheMap(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  if (payload.format === CACHE_FILE_FORMAT) {
    return sanitizeCacheMap(payload.value);
  }

  if (payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value)) {
    const fromValue = sanitizeCacheMap(payload.value);
    if (fromValue) {
      return fromValue;
    }
  }

  if (payload.timestamp != null && payload.value && typeof payload.value === 'object') {
    return sanitizeCacheMap(payload.value);
  }

  return sanitizeCacheMap(payload);
}

function buildCacheExportPayload(cacheMap, meta = {}, extensionVersion = '') {
  const value = cacheMap && typeof cacheMap === 'object' ? cacheMap : {};

  return {
    format: CACHE_FILE_FORMAT,
    formatVersion: CACHE_FILE_VERSION,
    exportedAt: Date.now(),
    extensionVersion: extensionVersion || undefined,
    timestamp: meta.timestamp ?? 0,
    ttl: meta.ttl ?? 600000,
    subnetCount: Object.keys(value).length,
    value,
  };
}
