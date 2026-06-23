require('dotenv').config();

const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const { writeCsv, referenceLinkFields, manifestFields } = require('./csv');
const { createBatchZip } = require('./exportZip');
const {
  buildAuthUrl,
  exchangeCodeForToken,
  getBoard,
  getBoardPins,
  getBoards
} = require('./pinterest');
const {
  consumeOauthState,
  ensureBaseDirs,
  ensureBatchDirs,
  getExportPath,
  listExports,
  saveOauthState
} = require('./storage');
const {
  extensionFromContentType,
  extensionFromUrl,
  getBaseUrl,
  getRedirectUri,
  nowIso,
  padId,
  randomState,
  sanitizeBatchName,
  sha256Buffer
} = require('./utils');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/pinterest/start',
  '/auth/pinterest/callback'
]);

app.use(express.json({ limit: '1mb' }));

function requireAdmin(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'ADMIN_TOKEN is not configured' });
  }

  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function downloadImage(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS || 30000));

  try {
    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': 'pinterest-connector-cloud/1.0' },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
      throw new Error(`Unexpected content type: ${contentType}`);
    }

    const length = Number(response.headers.get('content-length') || 0);
    const maxBytes = Number(process.env.MAX_IMAGE_BYTES || 25 * 1024 * 1024);
    if (length > maxBytes) {
      throw new Error(`Image is larger than MAX_IMAGE_BYTES (${length})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      throw new Error('Downloaded image is empty');
    }

    return {
      buffer,
      contentType,
      extension: extensionFromContentType(contentType) || extensionFromUrl(imageUrl) || '.jpg'
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isLowQuality(pin) {
  const minEdge = Number(process.env.MIN_IMAGE_EDGE || 320);
  const width = Number(pin.width || 0);
  const height = Number(pin.height || 0);

  if (!width || !height) return false;
  return width < minEdge || height < minEdge;
}

function buildSearchLog({
  syncTime,
  board,
  totalPins,
  downloadedValidCount,
  metadataOnlyCount,
  skippedCount,
  rateLimitNotes
}) {
  return [
    '# Pinterest Board Sync Log',
    '',
    `sync_time: ${syncTime}`,
    `board_id: ${board.id}`,
    `board_name: ${board.name || board.id}`,
    `total_pins: ${totalPins}`,
    `downloaded_valid_count: ${downloadedValidCount}`,
    `metadata_only_count: ${metadataOnlyCount}`,
    `skipped_count: ${skippedCount}`,
    `rate_limit_notes: ${rateLimitNotes}`,
    'source_policy: Pinterest API Board sync only, no scraping, no search-page screenshot.',
    ''
  ].join('\n');
}

app.use(requireAdmin);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/auth/pinterest/start', asyncRoute(async (req, res) => {
  const state = randomState();
  await saveOauthState(state);
  const redirectUri = getRedirectUri(req);
  const authUrl = buildAuthUrl(redirectUri, state);
  res.redirect(authUrl);
}));

app.get('/auth/pinterest/callback', asyncRoute(async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.status(400).send(`Pinterest authorization failed: ${errorDescription || error}`);
  }

  if (!code || !state) {
    return res.status(400).send('Missing Pinterest OAuth code or state.');
  }

  const stateIsValid = await consumeOauthState(String(state));
  if (!stateIsValid) {
    return res.status(400).send('Invalid or expired OAuth state.');
  }

  await exchangeCodeForToken(String(code), getRedirectUri(req));
  return res
    .status(200)
    .type('html')
    .send('<!doctype html><html><body><h1>Pinterest authorization complete</h1><p>You can close this tab and call the protected API endpoints with your ADMIN_TOKEN.</p></body></html>');
}));

app.get('/pinterest/boards', asyncRoute(async (_req, res) => {
  const boards = await getBoards();
  res.json({ boards });
}));

app.get('/pinterest/boards/:boardId/pins', asyncRoute(async (req, res) => {
  const pins = await getBoardPins(req.params.boardId);
  res.json({ pins });
}));

app.post('/sync/board', asyncRoute(async (req, res) => {
  const boardId = req.body && req.body.board_id;
  const requestedBatchName = req.body && req.body.batch_name;
  const mainCategory = (req.body && req.body.main_category) || '其他 / 待判断';
  const secondaryCategory = (req.body && req.body.secondary_category) || '';

  if (!boardId) {
    return res.status(400).json({ error: 'board_id is required' });
  }
  if (!requestedBatchName) {
    return res.status(400).json({ error: 'batch_name is required' });
  }

  const batchName = sanitizeBatchName(requestedBatchName);
  const syncTime = nowIso();
  const board = await getBoard(String(boardId));
  const pins = await getBoardPins(String(boardId));
  const batchPaths = await ensureBatchDirs(batchName);

  const referenceRows = [];
  const manifestRows = [];
  let downloadedValidCount = 0;
  let metadataOnlyCount = 0;
  let skippedCount = 0;

  for (let index = 0; index < pins.length; index += 1) {
    const pin = pins[index];
    const id = padId(index);
    const baseRow = {
      id,
      file_name: '',
      main_category: mainCategory,
      secondary_category: secondaryCategory,
      platform: 'Pinterest',
      source_url: pin.pin_url,
      image_url: pin.image_url,
      source_title: pin.title || pin.description || '',
      source_project_or_board: board.name || board.id,
      dedupe_note: 'not_checked',
      pin_id: pin.pin_id,
      board_id: pin.board_id || board.id,
      width: pin.width,
      height: pin.height,
      formal_status: 'metadata_only'
    };

    if (!pin.image_url) {
      metadataOnlyCount += 1;
      referenceRows.push(baseRow);
      continue;
    }

    if (isLowQuality(pin)) {
      skippedCount += 1;
      referenceRows.push({ ...baseRow, formal_status: 'skipped_low_quality' });
      continue;
    }

    try {
      const image = await downloadImage(pin.image_url);
      const safePinId = String(pin.pin_id || id).replace(/[^a-zA-Z0-9_-]/g, '');
      const fileName = `${id}_${safePinId || 'pin'}${image.extension}`;
      const absolutePath = path.join(batchPaths.images, fileName);
      await fs.writeFile(absolutePath, image.buffer);

      const stat = await fs.stat(absolutePath);
      const sha256 = sha256Buffer(image.buffer);

      if (stat.size <= 0 || !sha256) {
        skippedCount += 1;
        referenceRows.push({ ...baseRow, file_name: fileName, formal_status: 'skipped_broken_image' });
        continue;
      }

      downloadedValidCount += 1;
      referenceRows.push({
        ...baseRow,
        file_name: fileName,
        formal_status: 'downloaded_valid'
      });
      manifestRows.push({
        id,
        file_name: fileName,
        relative_path: `images/${fileName}`,
        absolute_path: absolutePath,
        size_bytes: stat.size,
        modified_time: stat.mtime.toISOString(),
        sha256,
        main_category: mainCategory,
        secondary_category: secondaryCategory,
        platform: 'Pinterest',
        source_url: pin.pin_url
      });
    } catch (error) {
      skippedCount += 1;
      referenceRows.push({
        ...baseRow,
        dedupe_note: `download_failed: ${error.message}`,
        formal_status: 'skipped_broken_image'
      });
    }
  }

  await writeCsv(batchPaths.referenceLinks, referenceRows, referenceLinkFields);
  await writeCsv(batchPaths.manifest, manifestRows, manifestFields);
  await fs.writeFile(batchPaths.searchLog, buildSearchLog({
    syncTime,
    board,
    totalPins: pins.length,
    downloadedValidCount,
    metadataOnlyCount,
    skippedCount,
    rateLimitNotes: 'Pinterest API pagination only; no scraping. If Pinterest returns 429, retry after the API reset window.'
  }), 'utf8');

  const zip = await createBatchZip(batchName, batchPaths.root);
  res.json({
    ok: true,
    batch_name: batchName,
    board_id: board.id,
    board_name: board.name || board.id,
    total_pins: pins.length,
    downloaded_valid_count: downloadedValidCount,
    metadata_only_count: metadataOnlyCount,
    skipped_count: skippedCount,
    reference_links_csv: batchPaths.referenceLinks,
    original_manifest_csv: batchPaths.manifest,
    search_log: batchPaths.searchLog,
    zip_path: zip.zipPath,
    export_download_url: `${getBaseUrl(req)}/exports/${encodeURIComponent(`${batchName}.zip`)}`
  });
}));

app.get('/exports', asyncRoute(async (req, res) => {
  const exports = await listExports(getBaseUrl(req));
  res.json({ exports });
}));

app.get('/exports/:fileName', asyncRoute(async (req, res) => {
  const exportPath = getExportPath(req.params.fileName);
  await fs.access(exportPath);
  res.download(exportPath);
}));

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  const payload = {
    error: error.message || 'Internal Server Error'
  };
  if (process.env.NODE_ENV !== 'production' && error.payload) {
    payload.details = error.payload;
  }
  res.status(status).json(payload);
});

if (require.main === module) {
  ensureBaseDirs()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Pinterest connector listening on port ${PORT}`);
      });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = app;
