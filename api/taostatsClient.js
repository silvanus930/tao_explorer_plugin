const TAOSTATS_API_BASE = 'https://api.taostats.io';
const TAOSTATS_FETCH_TIMEOUT_MS = 45_000;
const TAOSTATS_PAGE_SIZE = 64;
const TAOSTATS_MAX_RETRIES = 3;

function apiBase() {
  const override =
    typeof TAOSTATS_API_BASE_OVERRIDE === 'string' ? TAOSTATS_API_BASE_OVERRIDE.trim() : '';
  return (override || TAOSTATS_API_BASE).replace(/\/$/, '');
}

function resolveTaostatsApiKey(settings = {}) {
  const fromSettings = String(settings.taostatsApiKey ?? '').trim();
  if (fromSettings) {
    return fromSettings;
  }

  if (typeof TAOSTATS_API_KEY === 'string' && TAOSTATS_API_KEY.trim()) {
    return TAOSTATS_API_KEY.trim();
  }

  return '';
}

function isValidTaostatsAuth(auth) {
  return typeof auth === 'string' && /^tao-[0-9a-f-]+:[0-9a-f]+$/i.test(auth.trim());
}

function requestHeaders(auth) {
  return {
    Authorization: auth.trim(),
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

function isRateLimited(payload) {
  return payload?.status_code === 429 || String(payload?.message ?? '').includes('Rate Limited');
}

function classifyTaostatsError(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.error === 'request_timeout') {
    return 'request_timeout';
  }

  const code = Number(payload.status_code ?? payload.http_status);
  if (code === 401) {
    return 'unauthorized';
  }
  if (code === 403) {
    return 'forbidden';
  }
  if (code === 429) {
    return 'rate_limited';
  }

  return null;
}

function formatTaostatsError(kind, payload) {
  if (kind === 'unauthorized') {
    return 'Taostats auth failed (401) — set Authorization header to your full tao-uuid:secret key';
  }
  if (kind === 'forbidden') {
    return 'Taostats blocked the request (403) — check API key or try again later';
  }
  if (kind === 'request_timeout') {
    return payload?.message || 'Taostats request timed out';
  }
  if (kind === 'rate_limited') {
    return 'Taostats rate limited — wait a minute and try Refresh v2 again';
  }
  if (payload?.message) {
    return String(payload.message);
  }
  return null;
}

async function httpGetJson(path, params, auth, timeoutMs = TAOSTATS_FETCH_TIMEOUT_MS) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== '') {
      search.set(key, String(value));
    }
  });

  const url = `${apiBase()}${path}${search.toString() ? `?${search}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: requestHeaders(auth),
      signal: controller.signal,
    });
    const body = await response.text();

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { parse_error: 'invalid_json', raw: body.slice(0, 500) };
    }

    if (!response.ok) {
      return {
        ...payload,
        http_status: response.status,
        status_code: payload?.status_code ?? response.status,
      };
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { error: 'request_timeout', message: `Timed out after ${timeoutMs}ms` };
    }

    return {
      error: error?.message || 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function withRetries(path, params, auth, maxRetries = TAOSTATS_MAX_RETRIES) {
  let delayMs = 1500;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const payload = await httpGetJson(path, params, auth);
    const hardError = classifyTaostatsError(payload);
    if (hardError && hardError !== 'rate_limited') {
      return payload;
    }
    if (!isRateLimited(payload)) {
      return payload;
    }

    if (attempt === maxRetries - 1) {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 1.8, 15_000);
  }

  return { status_code: 429, message: 'Rate Limited' };
}

function raoToTao(rao) {
  try {
    const n = Number(rao ?? 0);
    if (!Number.isFinite(n)) {
      return null;
    }
    return n / RAO_PER_TAO;
  } catch {
    return null;
  }
}

async function fetchTaostatsPriceInfo(auth) {
  const payload = await withRetries(
    '/api/price/latest/v1',
    { asset: 'tao', limit: 1 },
    auth,
    2
  );
  const rows = payload?.data || [];
  const row = rows[0];
  if (!row || row.price == null) {
    return null;
  }

  const info = {};
  const price = Number(row.price);
  info.price_usd = Number.isFinite(price) ? price : null;

  for (const [key, field] of [
    ['change_24h', 'percent_change_24h'],
    ['change_7d', 'percent_change_7d'],
  ]) {
    const val = row[field];
    if (val != null) {
      const num = Number(val);
      info[key] = Number.isFinite(num) ? num : val;
    }
  }

  return info;
}

async function fetchAllSubnetsLatest(auth) {
  const rows = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const payload = await withRetries('/api/subnet/latest/v1', {
      limit: TAOSTATS_PAGE_SIZE,
      order: 'netuid_asc',
      page,
    }, auth);

    const errorKind = classifyTaostatsError(payload);
    if (errorKind) {
      return {
        error: errorKind,
        message: formatTaostatsError(errorKind, payload),
        response: payload,
      };
    }

    const pageRows = Array.isArray(payload?.data) ? payload.data : [];
    if (!pageRows.length && page === 1) {
      return {
        error: 'no_subnet_rows',
        message: 'Taostats returned no subnet rows',
        response: payload,
      };
    }

    rows.push(...pageRows);

    const pagination = payload?.pagination;
    totalPages = Number(pagination?.total_pages) || 1;
    const nextPage = pagination?.next_page;
    if (nextPage == null) {
      break;
    }
    page = Number(nextPage) || page + 1;
  }

  return rows;
}

function normalizeTaostatsSubnetRow(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const netuid = Number(row.netuid);
  if (!Number.isInteger(netuid) || netuid < 0) {
    return null;
  }

  const ownerIncentive =
    row.incentive_burn != null && row.incentive_burn !== ''
      ? Number(row.incentive_burn)
      : null;
  const burnTao = raoToTao(row.neuron_registration_cost);
  const burnRao =
    row.neuron_registration_cost != null ? Number(row.neuron_registration_cost) : null;
  const activeMiners =
    row.active_miners != null ? Number.parseInt(String(row.active_miners), 10) : null;

  return {
    netuid,
    ownerIncentive: Number.isFinite(ownerIncentive) ? ownerIncentive : null,
    burnTao: burnTao != null && Number.isFinite(burnTao) ? burnTao : null,
    burnRao: Number.isFinite(burnRao) ? burnRao : null,
    incentiveMinerCount:
      Number.isInteger(activeMiners) && activeMiners >= 0 ? activeMiners : null,
    blockNumber: row.block_number ?? null,
    taostatsTimestamp: row.timestamp ?? null,
  };
}

function buildTaostatsV2CachePatch(row, taoUsd) {
  const normalized = normalizeTaostatsSubnetRow(row);
  if (!normalized) {
    return null;
  }

  const capturedAt = Date.now();
  const price = taoUsd != null ? Number(taoUsd) : null;

  return {
    ...normalized,
    burnUsd:
      normalized.burnTao != null && price != null && Number.isFinite(price)
        ? normalized.burnTao * price
        : null,
    taoUsd: price != null && Number.isFinite(price) ? price : null,
    source: 'taostats',
    v2CapturedAt: capturedAt,
    updatedAt: capturedAt,
  };
}
