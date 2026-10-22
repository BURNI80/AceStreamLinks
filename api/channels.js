'use strict';

/**
 * GET /api/channels?domain=<subdominio.elcano.top>
 *
 * Devuelve el arbol de canales resuelto desde los registros DNS TXT.
 * Sin parametros usa el dominio raiz, que ya incluye todas las categorias.
 *
 * Cache: 5 min en memoria de la instancia (Vercel) + CDN (s-maxage).
 */

const { fetchChannelData, DEFAULT_DOMAIN } = require('../lib/dns-channels');

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const raw = (req.query.domain || DEFAULT_DOMAIN).toString().trim().toLowerCase();
  if (!DOMAIN_RE.test(raw)) {
    return res.status(400).json({ success: false, error: 'Dominio no valido' });
  }

  const started = Date.now();
  try {
    const zones = await fetchChannelData(raw);
    const count = zones.reduce((acc, z) => acc + (z.subLinks || []).filter((l) => l.url).length, 0);

    return res.status(200).json({
      success: true,
      domain: raw,
      zones,
      count,
      fetchedAt: Date.now(),
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    console.error(`[channels] error resolviendo ${raw}:`, err);
    return res.status(500).json({ success: false, error: err.message || 'Error resolviendo canales' });
  }
};
