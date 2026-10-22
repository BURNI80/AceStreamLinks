/* AceStream DNS - resolucion en el navegador (respaldo)
 *
 * Si /api/channels no esta disponible (funcion no desplegada, 404, error de red...)
 * el frontend usa este modulo para resolver los canales directamente desde el
 * navegador usando DNS-over-HTTPS, que es el mismo dato que lee el servidor.
 *
 * Es la version browser de lib/dns-channels.js: mismos TXT, misma recursion.
 */
(function (global) {
    'use strict';

    const CACHE_TTL = 5 * 60 * 1000;
    const MAX_DEPTH = 5;
    const MAX_PARALLEL = 8;
    const TIMEOUT = 8000;

    const RESOLVERS = [
        'https://cloudflare-dns.com/dns-query',
        'https://dns.google/resolve',
    ];

    const DEFAULT_DOMAIN = '682cb7103451b27a40bc9aa2.elcano.top';

    const cache = new Map();

    /* ---------------------------------------------------------------- *
     * Utilidades
     * ---------------------------------------------------------------- */

    function mapLimit(items, limit, fn) {
        const results = new Array(items.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            for (;;) {
                const i = cursor++;
                if (i >= items.length) break;
                results[i] = await fn(items[i], i);
            }
        });
        return Promise.all(workers).then(() => results);
    }

    function mergeName(prefix, name) {
        if (prefix && name) return name.startsWith(prefix) ? name : prefix + ' > ' + name;
        return prefix || name;
    }

    async function fetchWithTimeout(url, options, ms) {
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, ms);
        try {
            return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
        } finally {
            clearTimeout(timer);
        }
    }

    /* ---------------------------------------------------------------- *
     * DNS-over-HTTPS
     * ---------------------------------------------------------------- */

    async function queryTXT(domain) {
        let lastError;
        for (const resolver of RESOLVERS) {
            try {
                const url = resolver + '?name=' + encodeURIComponent(domain) + '&type=TXT';
                const res = await fetchWithTimeout(url, { headers: { accept: 'application/dns-json' } }, TIMEOUT);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const json = await res.json();
                const txt = (json.Answer || []).find(function (a) { return a.type === 16; });
                if (!txt) throw new Error('sin registro TXT');
                // Presentacion estandar DNS: "chunk1" "chunk2" ...
                return String(txt.data).replace(/"([^"]*)"/g, '$1').replace(/\s+/g, '');
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error('DoH fallo');
    }

    // base64 -> (gzip) -> texto
    async function decodePayload(b64) {
        let s = String(b64).replace(/\s+/g, '');
        const pad = s.length % 4;
        if (pad) s += new Array(5 - pad).join('=');

        const bin = atob(s);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            return await gunzip(bytes);
        }
        return new TextDecoder().decode(bytes);
    }

    // gzip -> texto. DecompressionStream no existe en navegadores viejos
    // (Safari < 16.4), para esos se carga pako como respaldo.
    async function gunzip(bytes) {
        if (typeof DecompressionStream !== 'undefined') {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            return await new Response(stream).text();
        }
        if (!global.pako) await loadPako();
        if (!global.pako) throw new Error('Este navegador no soporta descompresion gzip');
        return global.pako.inflate(bytes, { to: 'string' });
    }

    let pakoPromise = null;
    function loadPako() {
        if (pakoPromise) return pakoPromise;
        pakoPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/pako@2/dist/pako.min.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('no se pudo cargar pako'));
            document.head.appendChild(script);
        });
        return pakoPromise;
    }

    async function fetchRawData(domain) {
        const raw = await queryTXT(domain);
        const data = JSON.parse(await decodePayload(raw));
        if (!Array.isArray(data) || data.length === 0) throw new Error('respuesta vacia');
        return data;
    }

    /* ---------------------------------------------------------------- *
     * Arbol de categorias
     * ---------------------------------------------------------------- */

    async function safeSubZones(ref, depth) {
        try {
            return await fetchChannelData(ref + '.elcano.top', depth);
        } catch (_) {
            return [];
        }
    }

    async function resolveDomain(domain, depth) {
        const data = await fetchRawData(domain);
        const first = data[0] || {};

        if (first.subLinks) return data;

        const allRefs = data.every(function (i) { return i && i.type === 'category' && i.ref; });
        if (allRefs) {
            const groups = await mapLimit(data, MAX_PARALLEL, async function (item) {
                return { prefix: item.name || '', subZones: await safeSubZones(item.ref, depth + 1) };
            });
            const zones = [];
            for (const g of groups) {
                for (const sz of g.subZones) {
                    zones.push({ name: mergeName(g.prefix, sz.name), subLinks: sz.subLinks || [] });
                }
            }
            return zones;
        }

        if (first.url !== undefined || first.type) {
            const links = [];
            const categories = [];
            for (const item of data) {
                if (item && item.type === 'category' && item.ref) categories.push(item);
                else if (item && item.url && item.url !== '') links.push({ name: item.name, url: item.url });
            }

            const groups = await mapLimit(categories, MAX_PARALLEL, async function (item) {
                return { prefix: item.name || '', subZones: await safeSubZones(item.ref, depth + 1) };
            });

            const zones = [];
            for (const g of groups) {
                for (const sz of g.subZones) {
                    zones.push({ name: mergeName(g.prefix, sz.name), subLinks: sz.subLinks || [] });
                }
            }

            if (links.length > 0) zones.unshift({ name: domain.split('.')[0], subLinks: links });
            return zones;
        }

        return [];
    }

    async function fetchChannelData(domain, depth) {
        depth = depth || 0;
        if (depth > MAX_DEPTH) return [];

        const cached = cache.get(domain);
        if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

        const zones = await resolveDomain(domain, depth);
        cache.set(domain, { data: zones, ts: Date.now() });
        return zones;
    }

    global.AceDns = {
        fetchChannelData: fetchChannelData,
        fetchRawData: fetchRawData,
        DEFAULT_DOMAIN: DEFAULT_DOMAIN,
    };
})(window);
