/* AceStream Links - listado dinamico de canales
 *
 * Los canales no estan hardcodeados: se resuelven en el servidor (/api/channels)
 * a partir de los registros DNS TXT de AceStream, igual que hace el servidor de
 * streaming. Aqui solo se pinta el resultado, se filtra y se cachea en el cliente.
 */

const API_URL = '/api/channels';
const CACHE_KEY = 'acestream_channels_v1';
const CACHE_TTL = 5 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);

const searchInput = $('#search');
const chipsEl = $('#chips');
const channelsEl = $('#channels');
const skeletonEl = $('#skeleton');
const stateEl = $('#state');
const emptyEl = $('#empty');
const refreshBtn = $('#refresh');
const toggleAllBtn = $('#toggle-all');
const statusDot = $('#status-dot');
const statusText = $('#status-text');

let zones = [];
let activeZone = null;
let query = '';
let loading = false;

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

function isAce(url) {
    return typeof url === 'string' && url.startsWith('acestream://');
}

function contentId(url) {
    return url.replace(/^acestream:\/\//, '');
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setStatus(kind, text) {
    statusDot.className = 'status-dot ' + kind;
    statusText.textContent = text;
}

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.zones)) return null;
        if (Date.now() - data.fetchedAt > CACHE_TTL) return null;
        return data;
    } catch (_) {
        return null;
    }
}

function writeCache(data) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (_) {
        /* quota / modo privado */
    }
}

/* ------------------------------------------------------------------ *
 * Datos
 * ------------------------------------------------------------------ */

async function loadChannels(force) {
    if (loading) return;
    loading = true;
    refreshBtn.disabled = true;

    const cached = force ? null : readCache();
    if (cached) {
        zones = cached.zones;
        render();
        setStatus('ok', `${cached.count} canales - cache local (${formatTime(cached.fetchedAt)})`);
    } else {
        skeletonEl.classList.remove('hidden');
        setStatus('loading', 'Consultando DNS...');
    }

    try {
        const res = await fetch(API_URL + (force ? `?t=${Date.now()}` : ''), { cache: 'no-store' });
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        zones = data.zones || [];
        writeCache({ zones, count: data.count, fetchedAt: data.fetchedAt || Date.now() });
        render();
        setStatus('ok', `${data.count} canales - actualizado ${formatTime(data.fetchedAt || Date.now())}`);
    } catch (err) {
        if (zones.length) {
            setStatus('err', `Sin conexion con el servidor (${err.message}) - mostrando cache`);
        } else {
            skeletonEl.classList.add('hidden');
            stateEl.className = 'state error';
            stateEl.innerHTML = `No se pudieron cargar los canales.<br><br>
                <button class="btn" id="retry">Reintentar</button>`;
            stateEl.classList.remove('hidden');
            const retry = $('#retry');
            if (retry) retry.onclick = () => loadChannels(true);
        }
    } finally {
        loading = false;
        refreshBtn.disabled = false;
        skeletonEl.classList.add('hidden');
    }
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function zoneLinks(zone) {
    return (zone.subLinks || []).filter((l) => l && l.url);
}

function matches(name) {
    if (!query) return true;
    return String(name || '').toLowerCase().includes(query);
}

function render() {
    const total = zones.reduce((acc, z) => acc + zoneLinks(z).length, 0);
    renderChips(total);

    let visibleZones = 0;
    let visibleLinks = 0;

    channelsEl.innerHTML = '';

    for (const zone of zones) {
        if (activeZone !== null && zone.name !== activeZone) continue;

        const links = zoneLinks(zone).filter((l) => matches(l.name));
        if (query && links.length === 0) continue;

        visibleZones++;
        visibleLinks += links.length;

        const collapsed = query ? false : isCollapsed(zone.name);
        const section = document.createElement('section');
        section.className = 'zone' + (collapsed ? ' collapsed' : '');
        section.dataset.zone = zone.name;

        const head = document.createElement('div');
        head.className = 'zone-head';
        head.innerHTML = `
            <span class="zone-arrow">&#9654;</span>
            <span class="zone-title">${escHtml(zone.name)}</span>
            <span class="zone-count">${links.length}</span>
        `;
        head.onclick = () => {
            const nowCollapsed = section.classList.toggle('collapsed');
            toggleZoneState(zone.name, nowCollapsed);
        };

        const body = document.createElement('div');
        body.className = 'zone-body';

        const table = document.createElement('table');
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Canal</th>
                    <th style="text-align:right">Link</th>
                </tr>
            </thead>
            <tbody>${links.map(rowHtml).join('')}</tbody>
        `;

        body.appendChild(table);
        section.appendChild(head);
        section.appendChild(body);
        channelsEl.appendChild(section);
    }

    stateEl.classList.add('hidden');
    emptyEl.classList.toggle('hidden', !(visibleLinks === 0 && zones.length > 0));

    const allCollapsed = zones.length > 0 && zones.every((z) => isCollapsed(z.name));
    toggleAllBtn.textContent = allCollapsed ? 'Expandir todo' : 'Contraer todo';

    bindRowActions();
}

function rowHtml(link) {
    const ace = isAce(link.url);
    const badge = ace
        ? '<span class="badge ace">ACE</span>'
        : '<span class="badge web">WEB</span>';

    const main = ace
        ? `<a class="btn-link" href="${escHtml(link.url)}" title="Abrir en AceStream">Ver</a>`
        : `<a class="btn-link" href="${escHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="Abrir en el navegador">Abrir</a>`;

    const copy = ace
        ? `<button class="btn-copy" data-copy="${escHtml(contentId(link.url))}" title="Copiar ID del canal">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
            </button>`
        : '';

    return `
        <tr>
            <td class="name">${escHtml(link.name)}${badge}</td>
            <td class="actions">
                <span class="row-actions">${main}${copy}</span>
            </td>
        </tr>
    `;
}

function renderChips(total) {
    const counts = new Map();
    let matched = 0;
    for (const zone of zones) {
        const n = zoneLinks(zone).filter((l) => matches(l.name)).length;
        counts.set(zone.name, n);
        matched += n;
    }

    const chips = [];
    chips.push(`<button class="chip${activeZone === null ? ' active' : ''}" data-zone="">
        Todos<span class="count">${query ? matched : total}</span></button>`);

    for (const zone of zones) {
        const n = counts.get(zone.name);
        if (query && n === 0) continue;
        const active = activeZone === zone.name;
        chips.push(`<button class="chip${active ? ' active' : ''}" data-zone="${escHtml(zone.name)}">
            ${escHtml(zone.name)}<span class="count">${n}</span></button>`);
    }

    chipsEl.innerHTML = chips.join('');

    for (const chip of chipsEl.querySelectorAll('.chip')) {
        chip.onclick = () => {
            const zone = chip.dataset.zone;
            activeZone = zone ? zone : null;
            render();
        };
    }
}

function bindRowActions() {
    for (const btn of channelsEl.querySelectorAll('.btn-copy')) {
        btn.onclick = async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const id = btn.dataset.copy;
            try {
                await navigator.clipboard.writeText('acestream://' + id);
                btn.classList.add('copied');
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
                }, 1600);
            } catch (_) {
                /* sin permisos de portapapeles */
            }
        };
    }
}

/* ------------------------------------------------------------------ *
 * Estado de plegado (persistido)
 * ------------------------------------------------------------------ */

const COLLAPSE_KEY = 'acestream_collapsed_zones_v1';
let collapsedZones = new Set();

try {
    collapsedZones = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
} catch (_) {
    collapsedZones = new Set();
}

function isCollapsed(name) {
    return collapsedZones.has(name);
}

function toggleZoneState(name, collapsed) {
    if (collapsed) collapsedZones.add(name);
    else collapsedZones.delete(name);
    try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedZones]));
    } catch (_) {
        /* ignore */
    }
}

/* ------------------------------------------------------------------ *
 * Eventos
 * ------------------------------------------------------------------ */

let searchTimer = null;
searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        query = e.target.value.trim().toLowerCase();
        render();
    }, 120);
});

refreshBtn.addEventListener('click', () => loadChannels(true));

toggleAllBtn.addEventListener('click', () => {
    const allExpanded = zones.length > 0 && zones.every((z) => !isCollapsed(z.name));
    collapsedZones = new Set();
    if (allExpanded) {
        for (const z of zones) collapsedZones.add(z.name);
    }
    try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedZones]));
    } catch (_) {
        /* ignore */
    }
    toggleAllBtn.textContent = allExpanded ? 'Expandir todo' : 'Contraer todo';
    render();
});

loadChannels(false);
