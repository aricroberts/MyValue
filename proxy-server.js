/**
 * ROI Engine — API Proxy Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight Node.js proxy that injects your Anthropic API key on the server
 * side so the ROI Engine HTML files work for anyone with a browser — no
 * claude.ai widget required.
 *
 * SETUP (one time):
 *   1. Install Node.js 18+ (https://nodejs.org)
 *   2. npm install express cors
 *   3. Set your API key: export ANTHROPIC_API_KEY=sk-ant-...
 *   4. node proxy-server.js
 *
 * DEPLOY FREE on Render.com or Railway.app:
 *   - Push this file + package.json to a GitHub repo
 *   - Connect repo to Render/Railway as a Node.js web service
 *   - Set ANTHROPIC_API_KEY as an environment variable in their dashboard
 *   - Set ALLOWED_ORIGINS to your domain (or * for dev)
 *   - Deploy — takes ~2 minutes
 *
 * ENVIRONMENT VARIABLES:
 *   ANTHROPIC_API_KEY   Required. Your sk-ant-... key.
 *   PORT                Optional. Defaults to 3000.
 *   ALLOWED_ORIGINS     Optional. Comma-separated allowed origins.
 *                       Defaults to * (all) for local dev.
 *                       Example: https://yourdomain.com,https://www.yourdomain.com
 *   RATE_LIMIT_RPM      Optional. Requests per minute per IP. Defaults to 20.
 *   MAX_TOKENS_HARD_CAP Optional. Hard cap on max_tokens. Defaults to 2000.
 *
 * HOW IT WORKS:
 *   The HTML files call https://api.anthropic.com/v1/messages directly.
 *   To use this proxy instead, find-and-replace in each HTML file:
 *     FROM: https://api.anthropic.com/v1/messages
 *     TO:   http://localhost:3000/api/messages   (local)
 *       or  https://your-proxy.onrender.com/api/messages  (deployed)
 *
 * SECURITY:
 *   - API key never leaves the server
 *   - Rate limiting per IP
 *   - Hard cap on token usage
 *   - Origin whitelist in production
 *   - No logging of message content
 */

'use strict';

var express = require('express');
var cors = require('cors');
var https = require('https');

var app = express();
var PORT = process.env.PORT || 3000;
var API_KEY = process.env.ANTHROPIC_API_KEY || '';
var RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM) || 20;
var MAX_TOKENS_CAP = parseInt(process.env.MAX_TOKENS_HARD_CAP) || 2000;
var ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(function(s) { return s.trim(); })
  : ['*'];

// ─── Validate API key at startup ────────────────────────────────────────────
if (!API_KEY || API_KEY.indexOf('sk-ant-') !== 0) {
  console.error('\n⚠  No valid ANTHROPIC_API_KEY found.');
  console.error('   Set it with: export ANTHROPIC_API_KEY=sk-ant-...\n');
  process.exit(1);
}

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    if (ALLOWED_ORIGINS[0] === '*') return callback(null, true);
    if (!origin) return callback(null, true); // allow non-browser tools
    var allowed = ALLOWED_ORIGINS.some(function(o) {
      return origin === o || origin.endsWith(o.replace(/^https?:\/\//, ''));
    });
    if (allowed) return callback(null, true);
    callback(new Error('Origin not allowed: ' + origin));
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'anthropic-version', 'anthropic-dangerous-direct-browser-access', 'x-api-key']
}));

app.use(express.json({ limit: '1mb' }));

// ─── Explicit OPTIONS preflight ──────────────────────────────────────────────
app.options('*', cors());

// ─── Simple in-memory rate limiter ───────────────────────────────────────────
var ipHits = {};
setInterval(function() { ipHits = {}; }, 60000); // reset every minute

function rateLimit(req, res, next) {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  ipHits[ip] = (ipHits[ip] || 0) + 1;
  if (ipHits[ip] > RATE_LIMIT_RPM) {
    return res.status(429).json({ error: { type: 'rate_limit', message: 'Too many requests. Please wait a moment.' } });
  }
  next();
}

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.json({
    status: 'ok',
    service: 'ROI Engine API Proxy',
    version: '1.1.0',
    endpoints: { messages: 'POST /api/messages' }
  });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Main proxy endpoint ──────────────────────────────────────────────────────
app.post('/api/messages', rateLimit, function(req, res) {
  var body = req.body;

  // Validate minimum required fields
  if (!body || !body.messages || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: { type: 'invalid_request', message: 'messages array required' } });
  }

  // Enforce model — always use Sonnet 4
  body.model = 'claude-sonnet-4-20250514';

  // Enforce token cap
  if (!body.max_tokens || body.max_tokens > MAX_TOKENS_CAP) {
    body.max_tokens = Math.min(body.max_tokens || 1000, MAX_TOKENS_CAP);
  }

  var bodyStr = JSON.stringify(body);

  var options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  var proxyReq = https.request(options, function(proxyRes) {
    var chunks = [];
    proxyRes.on('data', function(chunk) { chunks.push(chunk); });
    proxyRes.on('end', function() {
      var raw = Buffer.concat(chunks).toString();
      res.status(proxyRes.statusCode);
      res.set('Content-Type', 'application/json');
      res.send(raw);
    });
  });

  proxyReq.on('error', function(err) {
    console.error('Proxy request error:', err.message);
    res.status(502).json({ error: { type: 'proxy_error', message: 'Upstream API unreachable' } });
  });

  proxyReq.write(bodyStr);
  proxyReq.end();
});

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use(function(req, res) {
  res.status(404).json({ error: { type: 'not_found', message: 'Endpoint not found' } });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('\n✓ ROI Engine API Proxy running');
  console.log('  Local:    http://localhost:' + PORT);
  console.log('  Health:   http://localhost:' + PORT + '/health');
  console.log('  Endpoint: http://localhost:' + PORT + '/api/messages');
  console.log('\n  To use: replace https://api.anthropic.com/v1/messages');
  console.log('          with    http://localhost:' + PORT + '/api/messages');
  console.log('          in each HTML file.\n');
});
