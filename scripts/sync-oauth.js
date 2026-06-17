const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const manifestPath = path.join(root, 'manifest.json');

if (!fs.existsSync(envPath)) {
  console.error('Missing .env file at', envPath);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  console.error('Missing manifest.json at', manifestPath);
  process.exit(1);
}

const envText = fs.readFileSync(envPath, 'utf8');
let clientId = '';

for (const line of envText.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    continue;
  }

  const match = trimmed.match(/^GOOGLE_OAUTH_CLIENT_ID\s*=\s*(.+)$/);
  if (match) {
    clientId = match[1].trim().replace(/^['"]|['"]$/g, '');
    break;
  }
}

if (!clientId) {
  console.error('No GOOGLE_OAUTH_CLIENT_ID found in .env');
  process.exit(1);
}

if (clientId.includes('{0}') || /REPLACE/i.test(clientId)) {
  console.error('GOOGLE_OAUTH_CLIENT_ID is still a placeholder:', clientId);
  process.exit(1);
}

if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(clientId)) {
  console.error('GOOGLE_OAUTH_CLIENT_ID format looks invalid:', clientId);
  console.error('Expected format: 123456789-xxxx.apps.googleusercontent.com');
  process.exit(1);
}

if (/^[a-p]{32}$/.test(clientId.match(/^\d+-([a-z0-9]+)\.apps\.googleusercontent\.com$/i)?.[1] || '')) {
  console.warn(
    'Warning: GOOGLE_OAUTH_CLIENT_ID looks like a Chrome Extension ID.',
    'Use the Client ID from Google Cloud credentials — not the Application ID field.'
  );
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.oauth2 = manifest.oauth2 || {};
manifest.oauth2.client_id = clientId;
manifest.oauth2.scopes = manifest.oauth2.scopes || [
  'https://www.googleapis.com/auth/spreadsheets',
];

if (!Array.isArray(manifest.permissions)) {
  manifest.permissions = [];
}

if (!manifest.permissions.includes('identity')) {
  manifest.permissions.push('identity');
}

const hosts = new Set(manifest.host_permissions || []);
hosts.add('https://www.googleapis.com/*');
hosts.add('https://sheets.googleapis.com/*');
manifest.host_permissions = [...hosts];

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('Updated manifest.json oauth2.client_id');
