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
 * Transportes (se prueban en paralelo y gana el primero que devuelve datos validos):
 *   1. DNS crudo por TCP:53 contra los NS autoritativos  (igual que el servidor de streaming)
 *   2. DNS-over-HTTPS (cloudflare-dns.com / dns.google)
 *   3. Resolutor del sistema (dns.resolveTxt)
 *
 * Los transportes que fallan se descartan solos: si el puerto 53 esta bloqueado
 * (firewall de un entorno serverless) se pasa al siguiente sin esperar 6 timeouts.
 */

const net = require('net');
const zlib = require('zlib');
const dnsPromises = require('dns').promises;

// dns-packet es opcional: si no esta instalado se cae al DoH / resolutor del sistema.
let dnsPacket = null;
try {
    dnsPacket = require('dns-packet');
} catch (_) {
    dnsPacket = null;
}

const DNS_PORT = 53;
const TCP_TIMEOUT = 2000;
const HTTP_TIMEOUT = 5000;
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

// Estado adaptativo por transporte: null = desconocido, true = funciona, false = descartado.
const transportState = { tcp: null, doh: null, system: null };

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

function parseTxtData(b64) {
    const buf = Buffer.from(String(b64).replace(/\s+/g, ''), 'base64');
    let text;
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        text = zlib.gunzipSync(buf).toString('utf8');
    } else {
        text = buf.toString('utf8');
    }
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) throw new Error('JSON vacio o no es una lista');
    return data;
}

/* ------------------------------------------------------------------ *
 * Transporte 1: DNS crudo por TCP:53
 * ------------------------------------------------------------------ */

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
        setTimeout(() => finish(new Error('TCP timeout')), TCP_TIMEOUT).unref?.();
    });
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

// IPs de los NS autoritativos del dominio.
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

// Todos los NS se consultan a la vez: gana el primero que conteste.
async function queryViaRawTcp(domain) {
    if (!dnsPacket) throw new Error('dns-packet no disponible');
    const nsIps = await resolveNsIps(domain);
    if (!nsIps.length) throw new Error('sin NS conocidos');

    const res = await Promise.any(nsIps.map((nsIP) => queryTCP(domain, 'TXT', nsIP)));
    if (!res.answers || res.answers.length === 0) throw new Error('sin respuestas TXT');
    return txtBufferToString(res.answers[0].data);
}

/* ------------------------------------------------------------------ *
 * Transporte 2: DNS-over-HTTPS
 * ------------------------------------------------------------------ */

async function queryViaDoh(domain) {
    let lastError;
    for (const resolver of DOH_RESOLVERS) {
        try {
            const url = `${resolver}?name=${encodeURIComponent(domain)}&type=TXT`;
            const res = await fetch(url, {
                headers: { accept: 'application/dns-json' },
                signal: AbortSignal.timeout(HTTP_TIMEOUT),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const txt = (json.Answer || []).find((a) => a.type === 16);
            if (!txt) throw new Error('sin registro TXT');
            // Presentacion estandar DNS: "chunk1" "chunk2" ...
            return String(txt.data).replace(/"([^"]*)"/g, '$1').replace(/\s+/g, '');
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('DoH fallo');
}

/* ------------------------------------------------------------------ *
 * Transporte 3: resolutor del sistema
 * ------------------------------------------------------------------ */

async function queryViaSystem(domain) {
    const chunks = await dnsPromises.resolveTxt(domain);
    if (!chunks || chunks.length === 0) throw new Error('sin registros TXT');
    const txt = chunks.map((chunk) => chunk.join('')).join('');
    if (!txt) throw new Error('TXT vacio');
    return txt;
}

/* ------------------------------------------------------------------ *
 * Resolucion con descartes automaticos
 * ------------------------------------------------------------------ */

const TRANSPORTS = [
    { name: 'tcp', run: queryViaRawTcp },
    { name: 'doh', run: queryViaDoh },
    { name: 'system', run: queryViaSystem },
];

// Devuelve la lista de datos ya parseada del TXT de `domain`.
async function fetchRawData(domain) {
    const working = TRANSPORTS.filter((t) => transportState[t.name] === true);
    const candidates = working.length ? working : TRANSPORTS;

    const attempts = candidates.map((t) => (async () => {
        try {
            const raw = await t.run(domain);
            const data = parseTxtData(raw);
            transportState[t.name] = true;
            return data;
        } catch (err) {
            // Solo se descarta si no ha funcionado nunca; un fallo puntual no lo tira.
            if (transportState[t.name] !== true) transportState[t.name] = false;
            throw err;
        }
    })());

    try {
        return await Promise.any(attempts);
    } catch (err) {
        const detail = err && err.errors ? err.errors.map((e) => e.message).join(' | ') : (err.message || 'sin detalle');
        throw new Error(`No se pudo resolver el TXT de ${domain}: ${detail}`);
    }
}

/* ------------------------------------------------------------------ *
 * Arbol de canales
 * ------------------------------------------------------------------ */

async function safeSubZones(ref, depth) {
    try {
        return await fetchChannelData(`${ref}.elcano.top`, depth);
    } catch (_) {
        return [];
    }
}

async function resolveDomain(domain, depth) {
    const data = await fetchRawData(domain);
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
    transportState,
};
