const fs = require('fs/promises');
const path = require('path');

const { safeZipName } = require('./utils');

function getDataDir() {
  return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
}

function getTokenDir() {
  return path.join(getDataDir(), 'tokens');
}

function getTokenPath() {
  return path.join(getTokenDir(), 'pinterest_token.json');
}

function getStatePath() {
  return path.join(getTokenDir(), 'oauth_state.json');
}

function getBatchesDir() {
  return path.join(getDataDir(), 'batches');
}

function getExportsDir() {
  return path.join(getDataDir(), 'exports');
}

async function ensureBaseDirs() {
  await fs.mkdir(getTokenDir(), { recursive: true });
  await fs.mkdir(getBatchesDir(), { recursive: true });
  await fs.mkdir(getExportsDir(), { recursive: true });
}

async function writeSecureJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await fs.chmod(filePath, 0o600);
  } catch (_error) {
    // chmod can be unavailable on some platforms. The file still lives under DATA_DIR.
  }
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveToken(token) {
  const now = Date.now();
  const expiresIn = Number(token.expires_in || 0);
  const normalized = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    scope: token.scope,
    expires_in: expiresIn,
    obtained_at: now,
    expires_at: expiresIn ? now + expiresIn * 1000 : null,
    refresh_token_expires_in: token.refresh_token_expires_in || null
  };
  await writeSecureJson(getTokenPath(), normalized);
  return normalized;
}

async function loadToken() {
  return readJsonIfExists(getTokenPath());
}

async function saveOauthState(state) {
  await writeSecureJson(getStatePath(), {
    state,
    created_at: Date.now(),
    expires_at: Date.now() + 10 * 60 * 1000
  });
}

async function consumeOauthState(state) {
  const saved = await readJsonIfExists(getStatePath());
  if (!saved || saved.state !== state || Date.now() > saved.expires_at) {
    return false;
  }
  await fs.rm(getStatePath(), { force: true });
  return true;
}

function getBatchPaths(batchName) {
  const root = path.join(getBatchesDir(), batchName);
  return {
    root,
    images: path.join(root, 'images'),
    referenceLinks: path.join(root, 'reference_links.csv'),
    manifest: path.join(root, 'original_manifest.csv'),
    searchLog: path.join(root, 'search_log.md')
  };
}

async function ensureBatchDirs(batchName) {
  const paths = getBatchPaths(batchName);
  await fs.mkdir(paths.images, { recursive: true });
  return paths;
}

async function listExports(baseUrl) {
  await fs.mkdir(getExportsDir(), { recursive: true });
  const entries = await fs.readdir(getExportsDir(), { withFileTypes: true });
  const zips = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
    const fullPath = path.join(getExportsDir(), entry.name);
    const stat = await fs.stat(fullPath);
    zips.push({
      file_name: entry.name,
      size_bytes: stat.size,
      modified_time: stat.mtime.toISOString(),
      download_url: `${baseUrl}/exports/${encodeURIComponent(entry.name)}`
    });
  }
  return zips.sort((a, b) => b.modified_time.localeCompare(a.modified_time));
}

function getExportPath(fileName) {
  return path.join(getExportsDir(), safeZipName(fileName));
}

module.exports = {
  consumeOauthState,
  ensureBaseDirs,
  ensureBatchDirs,
  getBatchPaths,
  getBatchesDir,
  getDataDir,
  getExportPath,
  getExportsDir,
  loadToken,
  listExports,
  saveOauthState,
  saveToken
};
