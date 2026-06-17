const form = document.getElementById('settings-form');
const sheetsForm = document.getElementById('sheets-form');
const status = document.getElementById('status');
const sheetsStatus = document.getElementById('sheets-status');
const refreshMinutes = document.getElementById('refreshMinutes');
const useTaoApi = document.getElementById('useTaoApi');
const taoApiKey = document.getElementById('taoApiKey');
const sheetsEnabled = document.getElementById('sheetsEnabled');
const sheetsSpreadsheetId = document.getElementById('sheetsSpreadsheetId');
const sheetsAutoSync = document.getElementById('sheetsAutoSync');
const sheetsPullOnLoad = document.getElementById('sheetsPullOnLoad');
const sheetsPublicPull = document.getElementById('sheetsPublicPull');
const createSheetBtn = document.getElementById('create-sheet-btn');
const pullSheetBtn = document.getElementById('pull-sheet-btn');
const pushSheetBtn = document.getElementById('push-sheet-btn');
const syncSheetBtn = document.getElementById('sync-sheet-btn');
const extensionIdEl = document.getElementById('extension-id');
const oauthClientIdEl = document.getElementById('oauth-client-id');
const oauthSetupWarningEl = document.getElementById('oauth-setup-warning');
const sheetDefaultHintEl = document.getElementById('sheet-default-hint');
const ownSheetEntry = document.getElementById('own-sheet-entry');
const sheetsOwnSection = document.getElementById('sheets-own-section');
const getOwnSheetBtn = document.getElementById('get-own-sheet-btn');
const hideOwnSheetBtn = document.getElementById('hide-own-sheet-btn');

let ownSheetControlsVisible = false;

function getBuiltInSheetUrl() {
  return typeof DEFAULT_SHEET_URL === 'string' ? DEFAULT_SHEET_URL.trim() : '';
}

function looksLikeExtensionId(value) {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

function extractOAuthClientHash(clientId) {
  return clientId.match(/^\d+-([a-z0-9]+)\.apps\.googleusercontent\.com$/i)?.[1] ?? null;
}

function inspectOAuthSetup() {
  const extensionId = chrome.runtime?.id || '';
  const clientId = chrome.runtime.getManifest()?.oauth2?.client_id || '';

  if (extensionIdEl) {
    extensionIdEl.textContent = extensionId || '(unknown)';
  }

  if (oauthClientIdEl) {
    oauthClientIdEl.textContent = clientId || '(missing — run node scripts/sync-oauth.js)';
  }

  if (!oauthSetupWarningEl) {
    return;
  }

  if (!ownSheetControlsVisible) {
    oauthSetupWarningEl.textContent = '';
    oauthSetupWarningEl.classList.add('hidden');
    return;
  }

  let warning = '';

  if (!clientId || clientId.includes('{0}') || /REPLACE/i.test(clientId)) {
    warning =
      'OAuth Client ID is missing or still a placeholder. Add GOOGLE_OAUTH_CLIENT_ID to .env and run node scripts/sync-oauth.js.';
  } else {
    const hash = extractOAuthClientHash(clientId);
    if (hash && extensionId && hash === extensionId) {
      warning =
        'Client ID matches Extension ID — that is wrong. Application ID = Extension ID. Client ID = separate value from Google Cloud credentials page.';
    } else if (hash && looksLikeExtensionId(hash)) {
      warning =
        'Client ID looks like an Extension ID. Copy the Client ID from the OAuth credentials row in Google Cloud, not the Application ID field.';
    }
  }

  if (warning) {
    oauthSetupWarningEl.textContent = warning;
    oauthSetupWarningEl.classList.remove('hidden');
  } else {
    oauthSetupWarningEl.textContent = '';
    oauthSetupWarningEl.classList.add('hidden');
  }
}

inspectOAuthSetup();

function setOwnSheetControlsVisible(show, { persist = true } = {}) {
  ownSheetControlsVisible = Boolean(show);

  sheetsOwnSection?.classList.toggle('hidden', !ownSheetControlsVisible);
  ownSheetEntry?.classList.toggle('hidden', ownSheetControlsVisible);
  inspectOAuthSetup();

  if (persist) {
    chrome.storage.sync.set({ sheetsShowOwnControls: ownSheetControlsVisible }).catch(() => {});
  }
}

getOwnSheetBtn?.addEventListener('click', () => {
  setOwnSheetControlsVisible(true);
});

hideOwnSheetBtn?.addEventListener('click', async () => {
  sheetsEnabled.checked = false;
  sheetsAutoSync.checked = false;
  setOwnSheetControlsVisible(false);
  try {
    await saveSheetsSettings();
    setSheetsStatus('Using community sheet only. Pull still works without sign-in.');
  } catch (error) {
    setSheetsStatus(error.message || 'Failed to save Sheets settings.', true);
  }
});

const versionBadge = document.getElementById('version-badge');
if (versionBadge) {
  const version = chrome.runtime.getManifest()?.version;
  if (version) {
    versionBadge.textContent = `v${version}`;
  }
}

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const targetId = btn.getAttribute('data-copy-target');
    const el = targetId ? document.getElementById(targetId) : null;
    const text = el?.textContent?.trim();
    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.textContent = original;
      }, 1200);
    } catch {
      btn.textContent = 'Failed';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1200);
    }
  });
});

function setSheetsStatus(message, isError = false) {
  sheetsStatus.textContent = message;
  sheetsStatus.classList.toggle('error', isError);
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get({
    taoApiKey: '',
    refreshMinutes: 10,
    useTaoApi: false,
    sheetsEnabled: false,
    sheetsSpreadsheetId: '',
    sheetsAutoSync: true,
    sheetsPullOnLoad: true,
    sheetsPublicPull: true,
    sheetsShowOwnControls: false,
  });

  refreshMinutes.value = stored.refreshMinutes;
  useTaoApi.checked = stored.useTaoApi;
  taoApiKey.value = stored.taoApiKey;
  sheetsEnabled.checked = stored.sheetsEnabled;
  sheetsSpreadsheetId.value = stored.sheetsSpreadsheetId || getBuiltInSheetUrl();
  sheetsAutoSync.checked = stored.sheetsAutoSync !== false;
  sheetsPullOnLoad.checked = stored.sheetsPullOnLoad !== false;
  sheetsPublicPull.checked = stored.sheetsPublicPull !== false;

  const showOwnControls = stored.sheetsShowOwnControls === true || stored.sheetsEnabled === true;
  setOwnSheetControlsVisible(showOwnControls, { persist: false });

  const builtIn = getBuiltInSheetUrl();
  if (sheetDefaultHintEl && builtIn) {
    const usingBuiltIn = !String(stored.sheetsSpreadsheetId || '').trim();
    sheetDefaultHintEl.textContent = usingBuiltIn
      ? 'Using built-in community sheet. Clear the field only if you want your own sheet.'
      : 'Built-in community sheet is available if you clear this field.';
  }
}

function readSheetsSettings() {
  return {
    sheetsEnabled: sheetsEnabled.checked,
    sheetsSpreadsheetId: sheetsSpreadsheetId.value.trim(),
    sheetsAutoSync: sheetsAutoSync.checked,
    sheetsPullOnLoad: sheetsPullOnLoad.checked,
    sheetsPublicPull: sheetsPublicPull.checked,
  };
}

async function saveSheetsSettings() {
  await chrome.storage.sync.set(readSheetsSettings());
}

async function sendSheetsMessage(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const settings = {
    refreshMinutes: Math.max(1, Math.min(120, Number(refreshMinutes.value) || 10)),
    useTaoApi: useTaoApi.checked,
    taoApiKey: taoApiKey.value.trim(),
  };

  await chrome.storage.sync.set(settings);
  await chrome.alarms.create('refresh-subnet-metrics', {
    periodInMinutes: settings.refreshMinutes,
  });

  setStatus('Settings saved.');
  setTimeout(() => {
    setStatus('');
  }, 2000);
});

sheetsForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await saveSheetsSettings();
    setSheetsStatus('Sheets settings saved.');
  } catch (error) {
    setSheetsStatus(error.message || 'Failed to save Sheets settings.', true);
  }
});

createSheetBtn.addEventListener('click', async () => {
  setSheetsStatus('Creating spreadsheet… sign in if prompted.');

  try {
    const response = await sendSheetsMessage('SHEETS_CREATE');
    if (response?.error) {
      throw new Error(response.error);
    }

    sheetsEnabled.checked = true;
    sheetsSpreadsheetId.value = response.spreadsheetUrl || response.spreadsheetId || '';
    setOwnSheetControlsVisible(true);
    await saveSheetsSettings();

    setSheetsStatus(
      response.spreadsheetUrl
        ? `Created: ${response.spreadsheetUrl}`
        : `Created spreadsheet ${response.spreadsheetId}`
    );
  } catch (error) {
    setSheetsStatus(error.message || 'Failed to create spreadsheet.', true);
  }
});

pullSheetBtn.addEventListener('click', async () => {
  setSheetsStatus('Pulling from Google Sheets…');

  try {
    await saveSheetsSettings();
    const response = await sendSheetsMessage('SHEETS_PULL');
    if (response?.error) {
      throw new Error(response.error);
    }

    setSheetsStatus(
      `Pulled ${response.rowCount ?? 0} rows${response.source === 'public' ? ' (public link, no sign-in)' : ''}.`
    );
  } catch (error) {
    setSheetsStatus(error.message || 'Pull failed.', true);
  }
});

pushSheetBtn.addEventListener('click', async () => {
  setSheetsStatus('Pushing to Google Sheets…');

  try {
    await saveSheetsSettings();
    const response = await sendSheetsMessage('SHEETS_PUSH');
    if (response?.error) {
      throw new Error(response.error);
    }

    setSheetsStatus(`Pushed ${response.rowCount ?? 0} subnet rows.`);
  } catch (error) {
    setSheetsStatus(error.message || 'Push failed.', true);
  }
});

syncSheetBtn.addEventListener('click', async () => {
  setSheetsStatus('Syncing with Google Sheets…');

  try {
    await saveSheetsSettings();
    const response = await sendSheetsMessage('SHEETS_SYNC');
    if (response?.error) {
      throw new Error(response.error);
    }

    setSheetsStatus(`Synced ${response.rowCount ?? 0} subnet rows.`);
  } catch (error) {
    setSheetsStatus(error.message || 'Sync failed.', true);
  }
});

loadSettings().catch(() => {
  setStatus('Failed to load settings.', true);
});
