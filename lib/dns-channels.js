'use strict';

/**
 * dns-channels.js
 *
 * Resolucion de canales AceStream a partir de registros DNS TXT.
 *
 * El dato de origen NO esta hardcodeado en ningun sitio: vive en subdominios
 * de `elcano.top`. Cada subdominio tiene un registro TXT que contiene un JSON
 * { name, url } por canal, codificado en base64 + gzip.
 *
 * Un subdominio puede apuntar a otro subdominio mediante
 * { type: "category", ref: "<subdominio>" }, lo que genera un arbol de categorias
 * que se resuelve recursivamente (profundidad maxima MAX_DEPTH).
 *
 * transported: se intenta en este orden
 *   1. DNS crudo por TCP:53 contra los NS autoritativos (igual que el servidor de streaming)
 *   2. Resolutor del sistema (dns.resolveTxt)
 *   3. DNS-over-HTTPS (cloudflare-dns.com / dns.google)
 */

const net = require('net');
const zlib = require('zlib');
const dnsPromises = require('dns').promises;

// dns-packet es opcional: si no esta instalado se cae al resolutor del sistema.
let dnsPacket = null;
try {
  dnsPacket = require('dns-packet');
} catch (_) {
  dnsPacket = null;
}

const DNS_PORT = 53;
const TCP_TIMEOUT = 4000;
const CACHE_TTL = 5 * 60 * 1000;
const MAX_DEPTH = 5;
const MAX_PARALLEL = 8;

const KNOWN_NS = {
  'elcano.top': [
    '173.245.59.229', '108.162.193.229', '172.64.33.229',
    '173.245.58.211', '108.162.192.211', '172.64.32.211',
  ],
};

const DOH_RESOLVERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

// Dominio raiz por defecto: resuelve el arbol completo de canales.
const DEFAULT_DOMAIN = '682cb7103451b27a40bc9aa2.elcano.top';

const cache = new Map();
const nsCache = new Map();

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

function parentDomain(domain) {
  return domain.split('.').slice(-2).join('.');
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function mergeName(prefix, name) {
  if (prefix && name) return name.startsWith(prefix) ? name : `${prefix} > ${name}`;
  return prefix || name;
}

/* ------------------------------------------------------------------ *
 * Transporte DNS
 * ------------------------------------------------------------------ */

// Query DNS en crudo sobre TCP:53 (mismo metodo que el servidor de streaming).
function queryTCP(domain, recordType, server) {
  return new Promise((resolve, reject) => {
    let query;
    try {
      query = dnsPacket.encode({
        type: 'query',
        id: Math.floor(Math.random() * 65535),
        recursionDesired: true,
        questions: [{ type: recordType, class: 'IN', name: domain }],
      });
    } catch (err) {
      return reject(err);
    }

    const client = net.createConnection({ host: server, port: DNS_PORT }, () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(query.length, 0);
      client.write(Buffer.concat([len, query]));
    });

    let data = Buffer.alloc(0);
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      client.destroy();
      err ? reject(err) : resolve(value);
    };

    client.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 2) {
        const expected = data.readUInt16BE(0) + 2;
        if (data.length >= expected) {
          try {
            finish(null, dnsPacket.decode(data.slice(2)));
          } catch (err) {
            finish(err);
          }
        }
      }
    });

    client.on('error', (err) => finish(err));
    setTimeout(() => finish(new Error('TCP timeout')), TCP_TIMEOUT);
  });
}

// Devuelve las IPs de los NS autoritativos de un dominio.
async function resolveNsIps(domain) {
  const parent = parentDomain(domain);
  if (KNOWN_NS[parent]) return KNOWN_NS[parent];
  if (nsCache.has(parent)) return nsCache.get(parent);

  const ips = [];
  try {
    const nameservers = await dnsPromises.resolveNs(parent);
    const records = await Promise.all(nameservers.map((ns) => dnsPromises.resolve4(ns).catch(() => [])));
    for (const list of records) for (const ip of list) if (!ips.includes(ip)) ips.push(ip);
  } catch (_) {
    /* sin NS conocidos */
  }

  nsCache.set(parent, ips);
  return ips;
}

function txtBufferToString(data) {
  if (typeof data === 'string') return data;
  const items = Array.isArray(data) ? data : [data];
  let result = '';
  for (const item of items) {
    if (Buffer.isBuffer(item)) result += item.toString('utf8');
    else if (item && item.type === 'Buffer' && Array.isArray(item.data)) result += Buffer.from(item.data).toString('utf8');
    else result += String(item);
  }
  return result;
}

async function queryViaSystemResolver(domain) {
  const chunks = await dnsPromises.resolveTxt(domain);
  return chunks.map((chunk) => chunk.join('')).join('');
}

async function queryViaDoh(domain) {
  let lastError;
  for (const resolver of DOH_RESOLVERS) {
    try {
      const url = `${resolver}?name=${encodeURIComponent(domain)}&type=TXT`;
      const res = await fetch(url, { headers: { accept: 'application/dns-json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.Answer) throw new Error('sin respuesta');
      const txt = json.Answer.find((a) => a.type === 16);
      if (!txt) throw new Error('sin TXT');
      // Presentacion estandar DNS: "chunk1" "chunk2" ...
      return String(txt.data).replace(/"([^"]*)"/g, '$1').replace(/\s+/g, '');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('DoH fallo');
}

// Devuelve el TXT en base64 (sin decodificar) usando el primer transporte que funcione.
async function fetchRawTxt(domain) {
  const nsIps = await resolveNsIps(domain);

  if (dnsPacket && nsIps.length) {
    for (const nsIP of nsIps) {
      try {
        const res = await queryTCP(domain, 'TXT', nsIP);
        if (res.answers && res.answers.length > 0) {
          return txtBufferToString(res.answers[0].data);
        }
      } catch (_) {
        /* siguiente NS */
      }
    }
  }

  try {
    return await queryViaSystemResolver(domain);
  } catch (_) {
    /* siguiente transporte */
  }

  return queryViaDoh(domain);
}

function parseTxtData(b64) {
  const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  }
  return JSON.parse(buf.toString('utf8'));
}

/* ------------------------------------------------------------------ *
 * Arbol de canales
 * ------------------------------------------------------------------ */

async function fetchRawData(domain) {
  const raw = await fetchRawTxt(domain);
  return parseTxtData(raw);
}

// Resuelve las subzonas de una categoria sin propagar errores.
async function safeSubZones(ref, depth) {
  try {
    return await fetchChannelData(`${ref}.elcano.top`, depth);
  } catch (_) {
    return [];
  }
}

async function resolveDomain(domain, depth) {
  const data = await fetchRawData(domain);
  if (!Array.isArray(data) || data.length === 0) return [];

  const first = data[0] || {};

  // Formato ya resuelto: [{ name, subLinks: [...] }]
  if (first.subLinks) return data;

  const allRefs = data.every((i) => i && i.type === 'category' && i.ref);
  if (allRefs) {
    const groups = await mapLimit(data, MAX_PARALLEL, async (item) => ({
      prefix: item.name || '',
      subZones: await safeSubZones(item.ref, depth + 1),
    }));
    const zones = [];
    for (const { prefix, subZones } of groups) {
      for (const sz of subZones) {
        zones.push({ name: mergeName(prefix, sz.name), subLinks: sz.subLinks || [] });
      }
    }
    return zones;
  }

  // Lista plana de links, mezclada con categorias.
  if (first.url !== undefined || first.type) {
    const links = [];
    const categories = [];
    for (const item of data) {
      if (item && item.type === 'category' && item.ref) categories.push(item);
      else if (item && item.url && item.url !== '') links.push({ name: item.name, url: item.url });
    }

    const groups = await mapLimit(categories, MAX_PARALLEL, async (item) => ({
      prefix: item.name || '',
      subZones: await safeSubZones(item.ref, depth + 1),
    }));

    const zones = [];
    for (const { prefix, subZones } of groups) {
      for (const sz of subZones) {
        zones.push({ name: mergeName(prefix, sz.name), subLinks: sz.subLinks || [] });
      }
    }

    if (links.length > 0) zones.unshift({ name: domain.split('.')[0], subLinks: links });
    return zones;
  }

  return [];
}

async function fetchChannelData(domain, depth = 0) {
  if (depth > MAX_DEPTH) return [];

  const cached = cache.get(domain);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const zones = await resolveDomain(domain, depth);

  cache.set(domain, { data: zones, ts: Date.now() });
  return zones;
}

module.exports = {
  fetchChannelData,
  fetchRawData,
  DEFAULT_DOMAIN,
  CACHE_TTL,
  MAX_DEPTH,
};
