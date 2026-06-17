const FINNEY_RPC = 'https://entrypoint-finney.opentensor.ai:443';
const RPC_TIMEOUT_MS = 30_000;
const RPC_RETRY_DELAY_MS = 400;
const RPC_BATCH_SIZE = 32;
const SELECTIVE_METAGRAPH_BURN_INDEX = 32;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcCall(method, params = [], attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const response = await fetch(FINNEY_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: 1,
      }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new Error('RPC rate limited');
    }

    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error.message || 'RPC error');
    }

    return payload.result;
  } catch (error) {
    if (attempt < 2) {
      await sleep(RPC_RETRY_DELAY_MS * (attempt + 1));
      return rpcCall(method, params, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcBatch(requests, attempt = 0) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS * 2);

  try {
    const body = requests.map((request, index) => ({
      jsonrpc: '2.0',
      method: request.method,
      params: request.params ?? [],
      id: index + 1,
    }));

    const response = await fetch(FINNEY_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error('RPC batch response was not an array');
    }

    return payload
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((entry) => entry.result ?? null);
  } catch (error) {
    if (attempt < 1) {
      await sleep(RPC_RETRY_DELAY_MS * 2);
      return rpcBatch(requests, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSubnetMetricFromHyperparams(netuid) {
  const result = await rpcCall('subnetInfo_getSubnetHyperparams', [netuid, null]);
  const metric = decodeHyperparams(result);
  if (!metric) {
    return null;
  }

  return {
    ...metric,
    netuid,
  };
}

async function fetchSubnetRegFeeFallback(netuid) {
  const result = await rpcCall('subnetInfo_getSubnetInfo', [netuid]);
  if (result) {
    const metric = decodeSubnetInfoValidated(result, netuid);
    if (metric) {
      return metric;
    }

    try {
      const loose = decodeSubnetInfo(result);
      if (
        loose &&
        loose.netuid === netuid &&
        Number.isFinite(loose.burnTao) &&
        loose.burnTao >= 0 &&
        loose.burnTao <= 10_000
      ) {
        return { ...loose, source: 'subnet_info_loose' };
      }
    } catch {
      // Fall through to hyperparams.
    }
  }

  return fetchSubnetMetricFromHyperparams(netuid);
}

async function fetchSubnetMetric(netuid) {
  const selective = await rpcCall('subnetInfo_getSelectiveMetagraph', [
    netuid,
    [SELECTIVE_METAGRAPH_BURN_INDEX],
  ]);
  const selectiveMetric = selective ? decodeSelectiveMetagraphBurn(selective) : null;
  if (selectiveMetric) {
    return { ...selectiveMetric, netuid };
  }

  return fetchSubnetRegFeeFallback(netuid);
}

async function fetchAllSubnetRegFees(netuids = []) {
  const unique = [...new Set(netuids.map(Number).filter((id) => Number.isInteger(id) && id >= 0))];
  if (unique.length === 0) {
    return new Map();
  }

  const metrics = new Map();

  for (let offset = 0; offset < unique.length; offset += RPC_BATCH_SIZE) {
    const chunk = unique.slice(offset, offset + RPC_BATCH_SIZE);
    const requests = chunk.map((netuid) => ({
      method: 'subnetInfo_getSelectiveMetagraph',
      params: [netuid, [SELECTIVE_METAGRAPH_BURN_INDEX]],
    }));

    let results = [];
    try {
      results = await rpcBatch(requests);
    } catch {
      results = await Promise.all(
        chunk.map((netuid) =>
          rpcCall('subnetInfo_getSelectiveMetagraph', [netuid, [SELECTIVE_METAGRAPH_BURN_INDEX]]).catch(
            () => null
          )
        )
      );
    }

    const fallbackNetuids = [];

    chunk.forEach((netuid, index) => {
      const raw = results[index];
      const metric = raw ? decodeSelectiveMetagraphBurn(raw) : null;
      if (metric) {
        metrics.set(netuid, { ...metric, netuid });
        return;
      }
      fallbackNetuids.push(netuid);
    });

    if (fallbackNetuids.length > 0) {
      await Promise.all(
        fallbackNetuids.map(async (netuid) => {
          try {
            const metric = await fetchSubnetRegFeeFallback(netuid);
            if (metric) {
              metrics.set(netuid, metric);
            }
          } catch {
            // Skip failed lookups.
          }
        })
      );
    }

    if (offset + RPC_BATCH_SIZE < unique.length) {
      await sleep(80);
    }
  }

  return metrics;
}

async function fetchSubnetMetrics(netuids) {
  const unique = [...new Set(netuids.map(Number).filter((id) => Number.isInteger(id) && id >= 0))];
  if (unique.length === 0) {
    return new Map();
  }

  if (unique.length >= 8) {
    return fetchAllSubnetRegFees(unique);
  }

  const metrics = new Map();

  for (const netuid of unique) {
    try {
      const metric = await fetchSubnetMetric(netuid);
      if (metric) {
        metrics.set(netuid, metric);
      }
    } catch {
      // Skip failed lookups; content script will retry on next pass.
    }

    await sleep(120);
  }

  return metrics;
}
