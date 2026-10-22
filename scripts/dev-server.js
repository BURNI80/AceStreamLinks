'use strict';

/**
 * Servidor local de desarrollo: sirve el frontend estatico y monta la misma
 * funcion que usa Vercel (/api/channels). No hace falta Vercel CLI para probar.
 *
 *   npm run dev   ->  http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const channels = require('../api/channels');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/channels') {
    // Vercel expone res.status()/res.json() en sus funciones; aqui se iguala.
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (data) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
      return res;
    };
    try {
      await channels({ method: req.method, query: Object.fromEntries(url.searchParams) }, res);
    } catch (err) {
      console.error('[dev]', err);
      if (!res.headersSent) res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname === '/' || url.pathname === '') filePath = path.join(ROOT, 'index.html');
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' }).end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[dev] http://localhost:${PORT}`);
});
