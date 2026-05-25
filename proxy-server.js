/**
 * receipts. — API Proxy Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight Node.js proxy that injects your Anthropic API key server-side
 * so the receipts. HTML files work for any browser visitor — no claude.ai
 * widget required.
 *
 * QUICK START (local dev):
 *   1. npm install          (installs express from package.json)
 *   2. export ANTHROPIC_API_KEY=sk-ant-...
 *   3. node proxy-server.js
 *   4. Open any HTML file — it auto-detects localhost and routes here.
 *
 * DEPLOY TO RENDER.COM (free tier, recommended):
 *   1. Push this repo to GitHub
 *   2. render.com → New Web Service → connect your repo
 *   3. Build command: npm install
 *      Start command: node proxy-server.js
 *   4. Environment variables to set in Render dashboard:
 *        ANTHROPIC_API_KEY   = sk-ant-...          (required)
 *        ALLOWED_ORIGINS     = https://receipts.aricciviclabs.org,https://aricciviclabs.org
 *        RATE_LIMIT_RPM      = 60                  (optional, default 60)
 *        MAX_TOKENS_HARD_CAP = 2000                (optional, default 2000)
 *   5. Copy the Render URL (e.g. https://receipts-proxy.onrender.com)
 *   6. Set PROXY_URL in each HTML file (see HTML_SETUP below)
 *
 * HTML_SETUP — in each HTML file, set the PROXY_URL constant:
 *   var PROXY_URL = 'https://receipts-proxy.onrender.com/api/messages';
 *   (The apiCall() helper already auto-routes to it when not in claude.ai)
 *
 * ENVIRONMENT VARIABLES:
 *   ANTHROPIC_API_KEY    Required. Your sk-ant-... key.
 *   PORT                 Optional. Defaults to 3000.
 *   ALLOWED_ORIGINS      Comma-separated allowed origins. Defaults to * (dev).
 *                        Production: https://receipts.aricciviclabs.org
 *   RATE_LIMIT_RPM       Requests per minute per IP. Default 60.
 *   MAX_TOKENS_HARD_CAP  Hard cap on max_tokens per request. Default 2000.
 *
 * SECURITY:
 *   - API key never leaves the server
 *   - Origin whitelist enforced in production
 *   - Per-IP rate limiting
 *   - Hard token cap prevents runaway costs
 *   - Web search beta header forwarded automatically when tools present
 *   - No logging of message content
 */

'use strict';

var express  = require('express');
var https    = require('https');

var app     = express();
var PORT    = parseInt(process.env.PORT) || 3000;
var API_KEY = process.env.ANTHROPIC_API_KEY || '';
var RPM     = parseInt(process.env.RATE_LIMIT_RPM) || 60;
var TOK_CAP = parseInt(process.env.MAX_TOKENS_HARD_CAP) || 2000;

var RAW_ORIGINS = process.env.ALLOWED_ORIGINS || '';
var ALLOWED_ORIGINS = RAW_ORIGINS
  ? RAW_ORIGINS.split(',').map(function(s) { return s.trim().replace(/\/$/, ''); })
  : [];   // empty = allow all (dev mode)

// ─── Validate API key at startup ─────────────────────────────────────────────
if (!API_KEY || API_KEY.indexOf('sk-ant-') !== 0) {
  console.error('\n⚠  ANTHROPIC_API_KEY missing or invalid.');
  console.error('   export ANTHROPIC_API_KEY=sk-ant-...\n');
  process.exit(1);
}

// Wildcard * means allow all origins
var allowAllOrigins = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.indexOf('*') !== -1;
var isProd = !allowAllOrigins;
console.log('\n' + (isProd ? '🔒 Production mode' : '🛠  Dev mode (all origins allowed)'));
if (isProd) console.log('   Allowed origins: ' + ALLOWED_ORIGINS.join(', '));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(function(req, res, next) {
  var origin = req.headers['origin'] || '';

  if (allowAllOrigins) {
    // Allow everything — send back the requesting origin (or * for non-browser requests)
    res.header('Access-Control-Allow-Origin', origin || '*');
  } else {
    // Enforce whitelist — only send header if origin is on the list
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    // Unknown origin: no ACAO header → browser blocks (correct behaviour)
  }

  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { return res.sendStatus(200); }
  next();
});

app.use(express.json({ limit: '1mb' }));

// ─── Per-IP rate limiter ──────────────────────────────────────────────────────
var ipHits = {};
setInterval(function() { ipHits = {}; }, 60000);

function rateLimit(req, res, next) {
  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
         || req.socket.remoteAddress
         || 'unknown';
  ipHits[ip] = (ipHits[ip] || 0) + 1;
  if (ipHits[ip] > RPM) {
    return res.status(429).json({
      error: { type: 'rate_limit_error', message: 'Too many requests — please wait a moment and try again.' }
    });
  }
  next();
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.json({ status: 'ok', service: 'receipts. API proxy', version: '2.0.0', mode: isProd ? 'production' : 'dev' });
});
app.get('/health', function(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Main proxy ───────────────────────────────────────────────────────────────
app.post('/api/messages', rateLimit, function(req, res) {
  var body = req.body;

  if (!body || !body.messages || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: { type: 'invalid_request', message: 'messages array required' } });
  }

  // Always use the correct model
  body.model = 'claude-sonnet-4-6';

  // Enforce token cap
  body.max_tokens = Math.min(body.max_tokens || 1000, TOK_CAP);

  var bodyStr = JSON.stringify(body);

  // Detect whether request uses web search tool — if so, add the beta header
  var hasWebSearch = (body.tools || []).some(function(t) {
    return t.type === 'web_search_20250305' || t.name === 'web_search';
  });

  var headers = {
    'Content-Type':       'application/json',
    'Content-Length':     Buffer.byteLength(bodyStr),
    'x-api-key':          API_KEY,
    'anthropic-version':  '2023-06-01'
  };
  if (hasWebSearch) {
    headers['anthropic-beta'] = 'web-search-2025-03-05';
  }

  var options = {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers:  headers
  };

  var proxyReq = https.request(options, function(proxyRes) {
    var chunks = [];
    proxyRes.on('data', function(c) { chunks.push(c); });
    proxyRes.on('end', function() {
      res.status(proxyRes.statusCode)
         .set('Content-Type', 'application/json')
         .send(Buffer.concat(chunks).toString());
    });
  });

  proxyReq.on('error', function(err) {
    console.error('[proxy error]', err.message);
    res.status(502).json({ error: { type: 'proxy_error', message: 'Upstream API unreachable — try again shortly.' } });
  });

  proxyReq.write(bodyStr);
  proxyReq.end();
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use(function(req, res) {
  res.status(404).json({ error: { type: 'not_found', message: 'Not found' } });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('  Endpoint: http://localhost:' + PORT + '/api/messages');
  console.log('  Health:   http://localhost:' + PORT + '/health');
  console.log('  RPM cap:  ' + RPM + ' per IP');
  console.log('  Token cap: ' + TOK_CAP + '\n');
});
