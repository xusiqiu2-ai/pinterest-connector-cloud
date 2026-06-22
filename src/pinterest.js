const {
  normalizeBoard,
  normalizePin,
  requireEnv
} = require('./utils');
const { loadToken, saveToken } = require('./storage');

const API_BASE = 'https://api.pinterest.com/v5';
const AUTH_URL = 'https://www.pinterest.com/oauth/';
const TOKEN_URL = `${API_BASE}/oauth/token`;

function getScopes() {
  return process.env.PINTEREST_SCOPES || 'boards:read,pins:read,user_accounts:read';
}

function getClientAuthHeader() {
  const clientId = requireEnv('PINTEREST_CLIENT_ID');
  const clientSecret = requireEnv('PINTEREST_CLIENT_SECRET');
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function buildAuthUrl(redirectUri, state) {
  const clientId = requireEnv('PINTEREST_CLIENT_ID');
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', getScopes());
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(params) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: getClientAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_error) {
    payload = { message: text };
  }

  if (!response.ok) {
    const message = payload.message || payload.error_description || payload.error || response.statusText;
    const error = new Error(`Pinterest token request failed: ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function exchangeCodeForToken(code, redirectUri) {
  const token = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  });
  return saveToken(token);
}

async function refreshAccessToken(refreshToken) {
  const token = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  if (!token.refresh_token) {
    token.refresh_token = refreshToken;
  }

  return saveToken(token);
}

async function getValidToken() {
  const token = await loadToken();
  if (!token || !token.access_token) {
    const error = new Error('Pinterest is not authorized yet. Visit /auth/pinterest/start first.');
    error.status = 401;
    throw error;
  }

  const expiresAt = token.expires_at || 0;
  const shouldRefresh = token.refresh_token && expiresAt && Date.now() > expiresAt - 60 * 1000;
  if (shouldRefresh) {
    return refreshAccessToken(token.refresh_token);
  }

  return token;
}

async function pinterestFetch(path, options = {}, retry = true) {
  const token = await getValidToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });

  if (response.status === 401 && retry && token.refresh_token) {
    await refreshAccessToken(token.refresh_token);
    return pinterestFetch(path, options, false);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_error) {
    payload = { message: text };
  }

  if (!response.ok) {
    const message = payload.message || payload.error_description || payload.error || response.statusText;
    const error = new Error(`Pinterest API request failed: ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function paginate(path, params = {}) {
  const items = [];
  let bookmark = null;
  let pages = 0;
  const maxPages = Number(process.env.PINTEREST_MAX_PAGES || 100);

  do {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    }
    if (bookmark) url.searchParams.set('bookmark', bookmark);

    const payload = await pinterestFetch(`${url.pathname}${url.search}`);
    items.push(...(payload.items || []));
    bookmark = payload.bookmark || null;
    pages += 1;
  } while (bookmark && pages < maxPages);

  return items;
}

async function getBoards() {
  const boards = await paginate('/boards', { page_size: 100 });
  return boards.map(normalizeBoard);
}

async function getBoard(boardId) {
  try {
    const board = await pinterestFetch(`/boards/${encodeURIComponent(boardId)}`);
    return normalizeBoard(board);
  } catch (_error) {
    const boards = await getBoards();
    return boards.find((board) => board.id === boardId) || {
      id: boardId,
      name: boardId,
      description: '',
      privacy: '',
      created_at: '',
      pin_count: ''
    };
  }
}

async function getBoardPins(boardId) {
  const pins = await paginate(`/boards/${encodeURIComponent(boardId)}/pins`, { page_size: 100 });
  return pins.map((pin) => normalizePin(pin, boardId));
}

module.exports = {
  buildAuthUrl,
  exchangeCodeForToken,
  getBoard,
  getBoardPins,
  getBoards,
  refreshAccessToken
};
