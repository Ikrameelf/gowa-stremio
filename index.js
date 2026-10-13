'use strict';

/**
 * Addon Stremio qui embarque les providers de gowaru-nuvio-providers.
 *
 * Aucune dépendance npm : les providers compilés (dossier ./providers) sont
 * autonomes. Il suffit de Node 18+ (fetch intégré).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Configuration (variables d'environnement) ─────────────────────────────
const PORT = Number(process.env.PORT) || 7000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';          // clé v3
const TMDB_TOKEN = process.env.TMDB_TOKEN || '';              // ou jeton v4 (Bearer)
const TMDB_BASE_URL = (process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/$/, '');
// Délai max AVANT de répondre à Stremio. Passé ce délai, on renvoie ce qui est
// déjà trouvé ; les providers lents continuent en arrière-plan et leurs
// résultats sont servis dès la requête suivante (rouvrir l'épisode).
const RESPONSE_DEADLINE_MS = Number(process.env.RESPONSE_DEADLINE_MS) || 15000;
// Délai max réel d'un provider (arrière-plan compris).
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 60000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const EMPTY_RETRY_MS = 60 * 1000; // un résultat vide est retenté après 1 min
const ADDON_NAME = process.env.ADDON_NAME || 'Gowaru FR';

// Réglages transmis aux providers (équivalent des réglages de l'app Nuvio).
// Exemple : SCRAPER_SETTINGS='{"language":"vf","skipSlowHosts":true}'
try {
  globalThis.SCRAPER_SETTINGS = process.env.SCRAPER_SETTINGS
    ? JSON.parse(process.env.SCRAPER_SETTINGS)
    : {};
} catch (e) {
  console.warn('SCRAPER_SETTINGS invalide (JSON attendu) :', e.message);
  globalThis.SCRAPER_SETTINGS = {};
}

// ─── Chargement des providers ───────────────────────────────────────────────
const PROVIDERS_DIR = path.join(__dirname, 'providers');

function discoverProviderIds() {
  if (process.env.PROVIDERS) {
    return process.env.PROVIDERS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!fs.existsSync(PROVIDERS_DIR)) return [];
  return fs.readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .sort();
}

const providers = [];
for (const id of discoverProviderIds()) {
  try {
    const mod = require(path.join(PROVIDERS_DIR, `${id}.js`));
    if (typeof mod.getStreams !== 'function') throw new Error('getStreams introuvable');
    providers.push({ id, getStreams: mod.getStreams });
    console.log(`[addon] provider chargé : ${id}`);
  } catch (e) {
    console.error(`[addon] provider ignoré (${id}) : ${e.message}`);
  }
}
if (!providers.length) {
  console.error('[addon] Aucun provider chargé. Lance d\'abord : npm run sync');
}

// ─── Manifest Stremio ───────────────────────────────────────────────────────
const manifest = {
  id: 'community.gowaru.fr.providers',
  version: '1.0.0',
  name: ADDON_NAME,
  description: 'Sources françaises (VF / VOSTFR) basées sur gowaru-nuvio-providers.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ─── IMDb → TMDB ────────────────────────────────────────────────────────────
const tmdbCache = new Map();

async function imdbToTmdb(imdbId, type) {
  const key = `${type}:${imdbId}`;
  if (tmdbCache.has(key)) return tmdbCache.get(key);

  if (!TMDB_API_KEY && !TMDB_TOKEN) {
    throw new Error('TMDB_API_KEY (ou TMDB_TOKEN) manquant');
  }
  const url = new URL(`${TMDB_BASE_URL}/find/${encodeURIComponent(imdbId)}`);
  url.searchParams.set('external_source', 'imdb_id');
  if (TMDB_API_KEY) url.searchParams.set('api_key', TMDB_API_KEY);

  const res = await fetch(url, {
    headers: TMDB_TOKEN ? { Authorization: `Bearer ${TMDB_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  const data = await res.json();

  const list = type === 'movie' ? data.movie_results : data.tv_results;
  const tmdbId = list && list[0] ? String(list[0].id) : null;
  if (tmdbId) tmdbCache.set(key, tmdbId);
  return tmdbId;
}

// ─── Appel des providers ────────────────────────────────────────────────────
function withProviderTimeout(provider, tmdbId, type, season, episode) {
  const controller = new AbortController();
  const mediaType = type === 'movie' ? 'movie' : 'tv';
  let timer;

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      console.warn(`[addon] ${provider.id} : timeout ${PROVIDER_TIMEOUT_MS}ms`);
      resolve([]);
    }, PROVIDER_TIMEOUT_MS);
  });

  const run = Promise.resolve()
    .then(() => provider.getStreams(tmdbId, mediaType, season, episode, { signal: controller.signal }))
    .then((list) => (Array.isArray(list) ? list : []))
    .catch((e) => {
      console.error(`[addon] ${provider.id} : ${e && e.message ? e.message : e}`);
      return [];
    });

  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

// ─── Conversion flux Nuvio → flux Stremio ───────────────────────────────────
function qualityScore(q) {
  const m = String(q || '').match(/(\d{3,4})\s*p?/i);
  if (m) return Number(m[1]);
  if (/4k|uhd/i.test(q || '')) return 2160;
  return 0;
}

function cleanHeaders(headers) {
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
  }
  return out;
}

function toStremioStream(providerId, s, index) {
  if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) return null;

  const quality = s.quality ? String(s.quality) : '';
  const label = s.name ? String(s.name) : providerId;
  const lines = [s.title ? String(s.title) : label];
  if (s.language) lines.push(`🌐 ${String(s.language).toUpperCase()}`);
  if (s.size) lines.push(`💾 ${s.size}`);
  const description = lines.join('\n');

  const stream = {
    name: [ADDON_NAME, label, quality].filter(Boolean).join('\n'),
    title: description,
    description,
    url: s.url,
    behaviorHints: {
      bingeGroup: `gowaru-${providerId}-${quality || 'x'}`,
    },
  };

  const headers = cleanHeaders(s.headers);
  if (Object.keys(headers).length) {
    stream.behaviorHints.notWebReady = true;
    stream.behaviorHints.proxyHeaders = { request: headers };
  }

  if (Array.isArray(s.subtitles) && s.subtitles.length) {
    const subs = s.subtitles
      .filter((x) => x && typeof x.url === 'string')
      .map((x, i) => ({
        id: `${providerId}-${index}-${i}`,
        url: x.url,
        lang: x.lang || x.language || x.label || 'fra',
      }));
    if (subs.length) stream.subtitles = subs;
  }

  stream._score = qualityScore(quality);
  return stream;
}

// ─── Résolution d'une requête /stream ───────────────────────────────────────
// Chaque requête (film ou épisode) devient une « tâche » qui lance tous les
// providers en parallèle. On répond à Stremio au bout de RESPONSE_DEADLINE_MS
// au plus, avec ce qui est déjà trouvé. Les providers lents continuent en
// arrière-plan : leurs flux sont ajoutés à la tâche et servis à la requête suivante.
const jobs = new Map(); // key -> job

function startJob(type, rawId) {
  const job = {
    createdAt: Date.now(),
    finishedAt: null,
    error: null,
    results: new Map(), // providerId -> flux Stremio[]
    done: 0,
    total: providers.length,
    tmdbId: null,
    allDone: null,
  };

  job.allDone = (async () => {
    const [imdbId, seasonStr, episodeStr] = rawId.split(':');
    const season = type === 'series' ? Number(seasonStr) : null;
    const episode = type === 'series' ? Number(episodeStr) : null;
    if (type === 'series' && (!season || !episode)) return;

    job.tmdbId = await imdbToTmdb(imdbId, type === 'movie' ? 'movie' : 'series');
    if (!job.tmdbId) return;

    await Promise.all(
      providers.map(async (p) => {
        const list = await withProviderTimeout(p, job.tmdbId, type, season, episode);
        job.results.set(p.id, list.map((s, i) => toStremioStream(p.id, s, i)).filter(Boolean));
        job.done++;
      })
    );
  })()
    .catch((e) => {
      job.error = e;
      console.error(`[addon] ${type}/${rawId} : ${e.message}`);
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  return job;
}

function collectStreams(job) {
  const seen = new Set();
  const all = [];
  for (const list of job.results.values()) {
    for (const s of list) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      all.push(s);
    }
  }
  all.sort((a, b) => b._score - a._score);
  return all.map(({ _score, ...stream }) => stream); // eslint-disable-line no-unused-vars
}

function jobExpired(job) {
  const now = Date.now();
  if (!job.finishedAt) return now - job.createdAt > PROVIDER_TIMEOUT_MS + 30000;
  const hasStreams = [...job.results.values()].some((l) => l.length);
  const ttl = hasStreams && !job.error ? CACHE_TTL_MS : EMPTY_RETRY_MS;
  return now - job.finishedAt > ttl;
}

function sweepJobs() {
  for (const [key, job] of jobs) if (jobExpired(job)) jobs.delete(key);
}

async function getStreamsForRequest(type, id) {
  const key = `${type}:${id}`;
  let job = jobs.get(key);
  if (job && jobExpired(job)) {
    jobs.delete(key);
    job = null;
  }
  if (!job) {
    sweepJobs();
    job = startJob(type, id);
    jobs.set(key, job);
  }

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, RESPONSE_DEADLINE_MS);
  });
  await Promise.race([job.allDone, deadline]);
  clearTimeout(timer);

  const streams = collectStreams(job);
  const complete = Boolean(job.finishedAt);
  console.log(
    `[addon] ${key} → TMDB ${job.tmdbId || '?'} : ${streams.length} flux, ` +
    `${job.done}/${job.total} providers terminés${complete ? '' : ' (les autres continuent en arrière-plan)'}`
  );
  return { streams, complete };
}

// ─── Serveur HTTP ───────────────────────────────────────────────────────────
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/manifest.json') return send(res, 200, manifest);

  if (pathname === '/health') {
    return send(res, 200, { ok: true, providers: providers.map((p) => p.id) });
  }

  if (pathname === '/') {
    const host = req.headers.host || `localhost:${PORT}`;
    const html = `<!doctype html><meta charset="utf-8"><title>${ADDON_NAME}</title>
<body style="font-family:sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem">
<h1>${ADDON_NAME}</h1>
<p>Providers actifs : ${providers.map((p) => p.id).join(', ') || 'aucun'}</p>
<p><a href="stremio://${host}/manifest.json">Installer dans Stremio</a></p>
<p>Manifest : <code>http://${host}/manifest.json</code></p></body>`;
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  // Stremio peut ajouter des paramètres après l'ID (ex. /stream/series/ID/videoHash=...json) :
  // on ne garde que l'ID.
  const m = pathname.match(/^\/stream\/(movie|series)\/([^/]+?)(?:\.json)?(?:\/[^/]*)?$/);
  if (m) {
    const [, type, id] = m;
    console.log(`[addon] ← requête Stremio : ${req.url}  (UA: ${(req.headers['user-agent'] || '?').slice(0, 60)})`);
    try {
      const { streams, complete } = await getStreamsForRequest(type, id);
      // Résultat incomplet ou vide : Stremio ne doit pas le garder en cache,
      // pour qu'une nouvelle ouverture récupère les flux arrivés entre-temps.
      const cacheMaxAge = complete && streams.length ? 300 : 0;
      return send(res, 200, { streams, cacheMaxAge });
    } catch (e) {
      console.error(`[addon] /stream ${type}/${id} : ${e.message}`);
      return send(res, 200, { streams: [] });
    }
  }

  return send(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nAddon "${ADDON_NAME}" prêt sur http://localhost:${PORT}/manifest.json`);
  console.log(`Providers : ${providers.map((p) => p.id).join(', ') || '(aucun)'}\n`);
});
