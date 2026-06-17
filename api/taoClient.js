const TAO_API_BASE = 'https://api.tao.app/api/beta';
const TAO_SUBNET_INFO_BASE = `${TAO_API_BASE}/analytics/subnets/info`;

function resolveTaoApiKey(settings = {}) {
  const fromSettings = String(settings.taoApiKey ?? '').trim();
  if (fromSettings) {
    return fromSettings;
  }

  if (typeof TAO_API_KEY === 'string' && TAO_API_KEY.trim()) {
    return TAO_API_KEY.trim();
  }

  return '';
}

async function taoApiFetch(path, apiKey) {
  const headers = {
    Accept: 'application/json',
  };

  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const response = await fetch(`${TAO_API_BASE}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`TAO.app API HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchTaoUsdPrice(apiKey) {
  const payload = await taoApiFetch('/current', apiKey);
  const price = Number(payload?.price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function fetchSubnetFromTaoApp(netuid, apiKey) {
  const headers = {
    Accept: 'application/json',
  };

  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const response = await fetch(`${TAO_SUBNET_INFO_BASE}/${netuid}`, { headers });
  if (!response.ok) {
    throw new Error(`TAO.app API HTTP ${response.status}`);
  }

  return response.json();
}

function normalizeTaoAppSubnet(data, netuid) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const burnRao = data.burn ?? data.registration_burn ?? data.burn_cost ?? data.registration_cost;
  const difficulty = data.difficulty ?? data.registration_difficulty;

  if (burnRao == null && difficulty == null) {
    return null;
  }

  const burnNumber = Number(burnRao);
  const burnTao = Number.isFinite(burnNumber)
    ? (burnNumber > 1_000_000 ? burnNumber / 1_000_000_000 : burnNumber)
    : null;

  return {
    netuid,
    burnRao: burnTao != null ? Math.round(burnTao * 1_000_000_000) : null,
    burnTao,
    difficulty: difficulty != null ? Number(difficulty) : null,
    source: 'tao.app',
  };
}

function buildRegFeeCachePatch(metric, taoUsd) {
  if (!metric || metric.burnTao == null) {
    return null;
  }

  const burnTao = Number(metric.burnTao);
  if (!Number.isFinite(burnTao)) {
    return null;
  }

  const burnRao =
    metric.burnRao != null
      ? Number(metric.burnRao)
      : Math.round(burnTao * 1_000_000_000);

  return {
    netuid: metric.netuid,
    burnTao,
    burnRao: Number.isFinite(burnRao) ? burnRao : null,
    burnUsd: taoUsd != null ? burnTao * taoUsd : null,
    taoUsd,
    difficulty: metric.difficulty != null ? Number(metric.difficulty) : null,
    source: 'rpc',
    rpcCapturedAt: Date.now(),
  };
}
