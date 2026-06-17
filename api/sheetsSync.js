const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_TAB = 'TAO_Subnet_Cache';
const SHEET_HEADERS = ['netuid', 'payload', 'updated_at'];
const OAUTH_CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

function parseSpreadsheetId(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return null;
  }

  const urlMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) {
    return raw;
  }

  return null;
}

function entryTimestamp(entry) {
  const value = Number(entry?.updatedAt ?? entry?.cachedAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function mergeCacheMaps(localMap = {}, remoteMap = {}) {
  const merged = { ...localMap };
  const now = Date.now();

  Object.entries(remoteMap).forEach(([key, remoteEntry]) => {
    if (!remoteEntry || typeof remoteEntry !== 'object') {
      return;
    }

    const localEntry = merged[key];
    const remoteTime = entryTimestamp(remoteEntry);
    const localTime = entryTimestamp(localEntry);

    if (!localEntry || remoteTime > localTime) {
      merged[key] = { ...remoteEntry, updatedAt: remoteTime || now };
      return;
    }

    if (remoteTime === localTime) {
      merged[key] = { ...remoteEntry, ...localEntry, updatedAt: localTime || now };
      return;
    }

    merged[key] = { ...localEntry, updatedAt: localTime || now };
  });

  return merged;
}

function cacheMapToRows(cacheMap = {}) {
  return Object.entries(cacheMap)
    .map(([key, entry]) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const netuid = Number(entry.netuid ?? key);
      if (!Number.isInteger(netuid)) {
        return null;
      }

      const updatedAt = entryTimestamp(entry) || Date.now();
      const payload = JSON.stringify({ ...entry, netuid, updatedAt });

      return [String(netuid), payload, String(updatedAt)];
    })
    .filter(Boolean)
    .sort((a, b) => Number(a[0]) - Number(b[0]));
}

function rowsToCacheMap(rows = []) {
  const map = {};

  rows.forEach((row) => {
    if (!Array.isArray(row) || row.length < 2) {
      return;
    }

    const netuid = Number(row[0]);
    if (!Number.isInteger(netuid)) {
      return;
    }

    let entry = null;
    try {
      entry = JSON.parse(String(row[1] ?? ''));
    } catch {
      return;
    }

    if (!entry || typeof entry !== 'object') {
      return;
    }

    const rowUpdatedAt = Number(row[2]);
    const payloadUpdatedAt = entryTimestamp(entry);
    const updatedAt = Number.isFinite(rowUpdatedAt)
      ? Math.max(rowUpdatedAt, payloadUpdatedAt)
      : payloadUpdatedAt;

    map[String(netuid)] = {
      ...entry,
      netuid,
      updatedAt: updatedAt || Date.now(),
    };
  });

  return map;
}

function getManifestOAuthClientId() {
  try {
    return chrome.runtime.getManifest()?.oauth2?.client_id ?? '';
  } catch {
    return '';
  }
}

function extractOAuthClientHash(clientId) {
  return clientId.match(/^\d+-([a-z0-9]+)\.apps\.googleusercontent\.com$/i)?.[1] ?? null;
}

function looksLikeExtensionId(value) {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

function validateOAuthSetup(clientId = getManifestOAuthClientId(), extensionId = chrome.runtime?.id) {
  const id = String(clientId || '').trim();

  if (!id || id.includes('{0}') || /REPLACE/i.test(id)) {
    return {
      ok: false,
      message:
        'OAuth Client ID is missing or still a placeholder. Set GOOGLE_OAUTH_CLIENT_ID in .env, run node scripts/sync-oauth.js, then reload the extension.',
    };
  }

  if (!OAUTH_CLIENT_ID_RE.test(id)) {
    return {
      ok: false,
      message:
        'OAuth Client ID format is invalid. Copy the full Client ID from Google Cloud (ends with .apps.googleusercontent.com).',
    };
  }

  const hash = extractOAuthClientHash(id);
  if (hash && extensionId && hash === extensionId) {
    return {
      ok: false,
      message:
        'Your manifest Client ID equals your Extension ID. Those are different values: Extension ID goes in Google Cloud → Application ID. Client ID goes in .env / manifest.',
    };
  }

  if (hash && looksLikeExtensionId(hash)) {
    return {
      ok: false,
      message:
        'Your Client ID looks like an Extension ID. In Google Cloud create OAuth client type Chrome extension, paste Extension ID into Application ID, then copy the generated Client ID into .env.',
    };
  }

  return { ok: true, clientId: id };
}

function formatGoogleAuthError(error, clientId = getManifestOAuthClientId()) {
  const message = String(error?.message || error || 'Google sign-in failed');
  if (!/bad client id/i.test(message)) {
    return message;
  }

  const setup = validateOAuthSetup(clientId);
  if (!setup.ok) {
    return setup.message;
  }

  return [
    'Google rejected the OAuth Client ID for this extension.',
    'In Google Cloud, create OAuth client type Chrome extension.',
    `Set Application ID to your Extension ID (${chrome.runtime?.id || 'see settings'}).`,
    'Copy that client’s Client ID into .env, run node scripts/sync-oauth.js, reload extension.',
  ].join(' ');
}

function assertOAuthReady() {
  const setup = validateOAuthSetup();
  if (!setup.ok) {
    throw new Error(setup.message);
  }
}

function getGoogleAuthToken(interactive = true) {
  assertOAuthReady();

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(formatGoogleAuthError(chrome.runtime.lastError)));
        return;
      }

      if (!token) {
        reject(new Error('Google sign-in did not return an access token'));
        return;
      }

      resolve(token);
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    if (!token) {
      resolve();
      return;
    }

    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function sheetsRequest(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${SHEETS_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.error?.status ||
      `Google Sheets API HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

async function withGoogleToken(fn, { interactive = true } = {}) {
  let token = await getGoogleAuthToken(interactive);

  try {
    return await fn(token);
  } catch (error) {
    if (/401|invalid authentication|invalid credentials/i.test(error.message || '')) {
      await removeCachedAuthToken(token);
      token = await getGoogleAuthToken(true);
      return fn(token);
    }

    throw error;
  }
}

async function getSpreadsheet(token, spreadsheetId) {
  return sheetsRequest(`/${spreadsheetId}`, { token });
}

async function ensureSheetTab(token, spreadsheetId) {
  const spreadsheet = await getSpreadsheet(token, spreadsheetId);
  const sheets = spreadsheet?.sheets || [];
  const existing = sheets.find((sheet) => sheet?.properties?.title === SHEET_TAB);

  if (existing) {
    return spreadsheet;
  }

  await sheetsRequest(`/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    token,
    body: {
      requests: [
        {
          addSheet: {
            properties: { title: SHEET_TAB },
          },
        },
      ],
    },
  });

  return getSpreadsheet(token, spreadsheetId);
}

async function readRemoteCacheMap(token, spreadsheetId) {
  await ensureSheetTab(token, spreadsheetId);

  const range = `${SHEET_TAB}!A2:C`;
  const payload = await sheetsRequest(
    `/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { token }
  );

  return rowsToCacheMap(payload?.values || []);
}

async function writeRemoteCacheMap(token, spreadsheetId, cacheMap) {
  await ensureSheetTab(token, spreadsheetId);

  const values = [SHEET_HEADERS, ...cacheMapToRows(cacheMap)];
  const range = `${SHEET_TAB}!A1:C`;

  await sheetsRequest(`/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT',
    token,
    body: { values },
  });
}

async function createSpreadsheet(token, title = 'TAO Subnet Analytics Cache') {
  const created = await sheetsRequest('', {
    method: 'POST',
    token,
    body: {
      properties: { title },
      sheets: [{ properties: { title: SHEET_TAB } }],
    },
  });

  const spreadsheetId = created?.spreadsheetId;
  if (!spreadsheetId) {
    throw new Error('Google Sheets did not return a spreadsheet ID');
  }

  await writeRemoteCacheMap(token, spreadsheetId, {});
  return {
    spreadsheetId,
    spreadsheetUrl: created?.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

async function readPublicCacheMap(spreadsheetId) {
  const sheet = encodeURIComponent(SHEET_TAB);
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&sheet=${sheet}&headers=1`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Public sheet read failed (HTTP ${response.status}). Share as "Anyone with the link can view".`
    );
  }

  const text = await response.text();
  let payload = null;

  try {
    const jsonText = text.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
    payload = JSON.parse(jsonText);
  } catch {
    throw new Error('Could not parse the public sheet. Check the tab name TAO_Subnet_Cache exists.');
  }

  const rawRows = (payload?.table?.rows || []).map((row) => {
    const cells = row.c || [];
    return cells.map((cell) => {
      if (!cell) {
        return '';
      }
      if (cell.v != null) {
        return String(cell.v);
      }
      return String(cell.f || '');
    });
  });

  const dataRows = rawRows.filter((row, index) => {
    if (index === 0 && String(row[0]).toLowerCase() === 'netuid') {
      return false;
    }
    return row.some((value) => value !== '' && value != null);
  });

  return rowsToCacheMap(dataRows);
}

async function pullCacheFromPublicSheet(spreadsheetId) {
  const id = parseSpreadsheetId(spreadsheetId);
  if (!id) {
    throw new Error('Enter a valid Google Sheets URL or spreadsheet ID');
  }

  const remoteMap = await readPublicCacheMap(id);
  return {
    spreadsheetId: id,
    remoteMap,
    rowCount: Object.keys(remoteMap).length,
    source: 'public',
  };
}

async function pullCacheFromSheets(spreadsheetId, { interactive = true, preferPublic = false } = {}) {
  const id = parseSpreadsheetId(spreadsheetId);
  if (!id) {
    throw new Error('Enter a valid Google Sheets URL or spreadsheet ID');
  }

  if (preferPublic) {
    try {
      return await pullCacheFromPublicSheet(spreadsheetId);
    } catch (publicError) {
      const hint =
        ' Pull uses the public view link only (no Google sign-in). Ask the maintainer to share the sheet as "Anyone with the link → Viewer".';
      throw new Error(`${publicError.message}${hint}`);
    }
  }

  return withGoogleToken(async (token) => {
    const remoteMap = await readRemoteCacheMap(token, id);
    return {
      spreadsheetId: id,
      remoteMap,
      rowCount: Object.keys(remoteMap).length,
      source: 'oauth',
    };
  }, { interactive });
}

async function pushCacheToSheets(spreadsheetId, localMap = {}, { interactive = true } = {}) {
  const id = parseSpreadsheetId(spreadsheetId);
  if (!id) {
    throw new Error('Enter a valid Google Sheets URL or spreadsheet ID');
  }

  return withGoogleToken(async (token) => {
    const remoteMap = await readRemoteCacheMap(token, id);
    const merged = mergeCacheMaps(localMap, remoteMap);
    await writeRemoteCacheMap(token, id, merged);

    return {
      spreadsheetId: id,
      mergedMap: merged,
      rowCount: Object.keys(merged).length,
      pushedAt: Date.now(),
    };
  }, { interactive });
}

async function syncCacheWithSheets(spreadsheetId, localMap = {}, { interactive = true } = {}) {
  const id = parseSpreadsheetId(spreadsheetId);
  if (!id) {
    throw new Error('Enter a valid Google Sheets URL or spreadsheet ID');
  }

  return withGoogleToken(async (token) => {
    const remoteMap = await readRemoteCacheMap(token, id);
    const merged = mergeCacheMaps(localMap, remoteMap);
    await writeRemoteCacheMap(token, id, merged);

    return {
      spreadsheetId: id,
      mergedMap: merged,
      rowCount: Object.keys(merged).length,
      syncedAt: Date.now(),
    };
  }, { interactive });
}
