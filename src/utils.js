const crypto = require('crypto');
const path = require('path');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function randomState() {
  return crypto.randomBytes(24).toString('hex');
}

function sanitizeBatchName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/\.+$/g, '');

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('Invalid batch_name');
  }

  return cleaned.slice(0, 160);
}

function safeZipName(fileName) {
  const base = path.basename(String(fileName || ''));
  if (!base.endsWith('.zip') || base.includes('..')) {
    throw new Error('Invalid export file name');
  }
  return base;
}

function padId(index) {
  return String(index + 1).padStart(3, '0');
}

function extensionFromContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  return map[type] || '';
}

function extensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch (_error) {
    return '';
  }
  return '';
}

function getBaseUrl(req) {
  const host = req.get('x-forwarded-host') || req.get('host');
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = process.env.NODE_ENV === 'production'
    ? (forwardedProto || 'https').split(',')[0].trim()
    : (forwardedProto || req.protocol || 'http').split(',')[0].trim();

  return `${proto}://${host}`;
}

function getRedirectUri(req) {
  return `${getBaseUrl(req)}/auth/pinterest/callback`;
}

function pickImage(pin) {
  const images = pin && pin.media && pin.media.images ? pin.media.images : {};
  const preferredKeys = [
    '1200x',
    '1200x1200',
    '736x',
    '600x',
    '564x',
    '400x300',
    'orig'
  ];

  for (const key of preferredKeys) {
    if (images[key] && images[key].url) return images[key];
  }

  const first = Object.values(images).find((image) => image && image.url);
  return first || null;
}

function normalizePin(pin, boardId) {
  const image = pickImage(pin);
  const pinId = pin.id || pin.pin_id || '';
  return {
    pin_id: pinId,
    title: pin.title || '',
    description: pin.description || '',
    link: pin.link || '',
    board_id: pin.board_id || boardId || '',
    pin_url: pin.url || (pinId ? `https://www.pinterest.com/pin/${pinId}/` : ''),
    image_url: image ? image.url : '',
    width: image && image.width ? image.width : '',
    height: image && image.height ? image.height : ''
  };
}

function normalizeBoard(board) {
  return {
    id: board.id || '',
    name: board.name || '',
    description: board.description || '',
    privacy: board.privacy || '',
    created_at: board.created_at || '',
    pin_count: board.pin_count ?? board.counts?.pins ?? ''
  };
}

module.exports = {
  extensionFromContentType,
  extensionFromUrl,
  getBaseUrl,
  getRedirectUri,
  normalizeBoard,
  normalizePin,
  nowIso,
  padId,
  randomState,
  requireEnv,
  safeZipName,
  sanitizeBatchName,
  sha256Buffer
};
