/**
 * Minimal SCALE decoder for Bittensor SubnetInfo RPC responses.
 * Decodes burn (RAO) and difficulty from subnetInfo_getSubnetInfo.
 */
const RAO_PER_TAO = 1_000_000_000;

class ScaleReader {
  constructor(bytes) {
    this.data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.pos = 0;
  }

  readByte() {
    if (this.pos >= this.data.length) {
      throw new Error('SCALE decode overflow');
    }
    return this.data[this.pos++];
  }

  readBytes(length) {
    const out = this.data.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  readCompact() {
    const first = this.readByte();
    const mode = first & 0b11;

    if (mode === 0) {
      return first >> 2;
    }

    if (mode === 1) {
      const second = this.readByte();
      return (first >> 2) | (second << 6);
    }

    if (mode === 2) {
      const rest = this.readBytes(3);
      return (first >> 2) | (rest[0] << 6) | (rest[1] << 14) | (rest[2] << 22);
    }

    const rest = this.readBytes(4);
    const head = new Uint8Array([first >> 2, ...rest]);
    let value = 0n;
    for (let i = 0; i < head.length; i++) {
      value |= BigInt(head[i]) << BigInt(8 * i);
    }
    const num = Number(value);
    if (!Number.isSafeInteger(num)) {
      return value;
    }
    return num;
  }

  readU16() {
    const low = this.readByte();
    const high = this.readByte();
    return low | (high << 8);
  }

  readOption(readInner) {
    const tag = this.readByte();
    if (tag === 0) {
      return null;
    }
    return readInner();
  }

  readSubnetInfo() {
    const fields = {};
    const compactFields = [
      'netuid',
      'rho',
      'kappa',
      'difficulty',
      'immunity_period',
      'max_allowed_validators',
      'min_allowed_weights',
      'max_weights_limit',
      'scaling_law_power',
      'subnetwork_n',
      'max_allowed_uids',
      'blocks_since_last_step',
      'tempo',
      'network_modality',
    ];

    for (const key of compactFields) {
      fields[key] = this.readCompact();
    }

    const connectLen = this.readCompact();
    this.pos += connectLen * 4;

    fields.emission_values = this.readCompact();
    fields.burn = this.readCompact();
    this.readBytes(32);

    return fields;
  }
}

function toNumber(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
}

function toSubnetMetrics(info) {
  const netuid = toNumber(info.netuid);
  const burnRao = toNumber(info.burn);
  const difficulty = toNumber(info.difficulty);

  return {
    netuid,
    burnRao,
    burnTao: burnRao / RAO_PER_TAO,
    difficulty,
  };
}

function decodeSubnetInfo(bytes) {
  const reader = new ScaleReader(bytes);
  const info = reader.readOption(() => reader.readSubnetInfo());
  if (!info) {
    return null;
  }
  return toSubnetMetrics(info);
}

const SELECTIVE_METAGRAPH_OPTIONS_BEFORE_BURN = 31;

function decodeSelectiveMetagraphBurn(bytes) {
  const reader = new ScaleReader(bytes);
  if (reader.readByte() === 0) {
    return null;
  }

  reader.readCompact();

  for (let i = 0; i < SELECTIVE_METAGRAPH_OPTIONS_BEFORE_BURN; i++) {
    if (reader.readByte() !== 0) {
      return null;
    }
  }

  const burnRao = reader.readOption(() => reader.readCompact());
  if (burnRao == null) {
    return null;
  }

  const burn = toNumber(burnRao);
  if (!Number.isFinite(burn) || burn < 0 || burn > 10_000 * RAO_PER_TAO) {
    return null;
  }

  return {
    netuid: null,
    burnRao: burn,
    burnTao: burn / RAO_PER_TAO,
    difficulty: null,
    source: 'selective_metagraph',
  };
}

function decodeSubnetMetric(bytes, netuid) {
  if (!bytes) {
    return null;
  }

  const selective = decodeSelectiveMetagraphBurn(bytes);
  if (selective) {
    return { ...selective, netuid };
  }

  const strict = decodeSubnetInfoValidated(bytes, netuid);
  if (strict) {
    return strict;
  }

  try {
    const loose = decodeSubnetInfo(bytes);
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
    // Fall through to hyperparams in rpcClient.
  }

  return null;
}

function decodeSubnetInfoValidated(bytes, netuid) {
  const reader = new ScaleReader(bytes);
  const startPos = reader.pos;

  let metric = null;
  try {
    const info = reader.readOption(() => reader.readSubnetInfo());
    if (info) {
      metric = toSubnetMetrics(info);
    }
  } catch {
    return null;
  }

  if (reader.pos - startPos !== bytes.length) {
    return null;
  }

  if (!metric || metric.netuid !== netuid) {
    return null;
  }

  if (!Number.isFinite(metric.burnTao) || metric.burnTao < 0 || metric.burnTao > 10_000) {
    return null;
  }

  if (!Number.isFinite(metric.difficulty) || metric.difficulty < 0 || metric.difficulty > 1e18) {
    return null;
  }

  return metric;
}

function decodeHyperparams(bytes) {
  const reader = new ScaleReader(bytes);
  const hyperparams = reader.readOption(() => {
    const fields = {};
    const leading = [
      'rho',
      'kappa',
      'immunity_period',
      'min_allowed_weights',
      'max_weights_limit',
      'tempo',
      'min_difficulty',
      'max_difficulty',
      'weights_version',
      'weights_rate_limit',
      'adjustment_interval',
      'activity_cutoff',
    ];

    for (const key of leading) {
      fields[key] = reader.readCompact();
    }

    reader.readByte();
    for (const key of [
      'target_regs_per_interval',
      'min_burn',
      'max_burn',
      'bonds_moving_avg',
      'max_regs_per_block',
      'serving_rate_limit',
      'max_validators',
      'adjustment_alpha',
      'difficulty',
      'commit_reveal_period',
    ]) {
      fields[key] = reader.readCompact();
    }

    reader.readByte();
    fields.alpha_high = reader.readCompact();
    fields.alpha_low = reader.readCompact();
    reader.readByte();

    return fields;
  });

  if (!hyperparams) {
    return null;
  }

  const burnRao = toNumber(hyperparams.min_burn);
  const difficulty = toNumber(hyperparams.difficulty);

  return {
    netuid: null,
    burnRao,
    burnTao: burnRao / RAO_PER_TAO,
    difficulty,
    source: 'hyperparams',
  };
}

function formatTao(rao) {
  const tao = toNumber(rao) / RAO_PER_TAO;
  if (tao === 0) {
    return '0';
  }
  if (tao >= 100) {
    return tao.toFixed(2);
  }
  if (tao >= 1) {
    return tao.toFixed(3);
  }
  if (tao >= 0.01) {
    return tao.toFixed(4);
  }
  return tao.toFixed(6);
}

function formatDifficulty(value) {
  const num = toNumber(value);
  if (!Number.isFinite(num) || num <= 0) {
    return '—';
  }
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return String(num);
}
