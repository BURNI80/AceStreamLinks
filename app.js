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
const channelsEl = $('#channels');
const skeletonEl = $('#skeleton');
const stateEl = $('#state');
const emptyEl = $('#empty');
const refreshBtn = $('#refresh');
const toggleAllBtn = $('#toggle-all');
const statusDot = $('#status-dot');
const statusText = $('#status-text');

let zones = [];
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

    let data = null;
    let error = null;

    try {
        const res = await fetch(API_URL + (force ? `?t=${Date.now()}` : ''), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'error del servidor');
        data = json;
        data.source = 'servidor';
    } catch (err) {
        error = err;
        // La API no responde (funcion no desplegada, 404, sin red, timeout...).
        // Se resuelve el mismo dato desde el navegador via DNS-over-HTTPS.
        if (globalThis.AceDns) {
            setStatus('loading', 'API no disponible, resolviendo desde el navegador...');
            try {
                const browserZones = await AceDns.fetchChannelData(AceDns.DEFAULT_DOMAIN);
                data = {
                    zones: browserZones,
                    count: countLinks(browserZones),
                    fetchedAt: Date.now(),
                    source: 'navegador',
                };
                error = null;
            } catch (err2) {
                error = err2;
            }
        }
    }

    if (data) {
        zones = data.zones || [];
        writeCache({ zones, count: data.count, fetchedAt: data.fetchedAt || Date.now() });
        render();
        const source = data.source === 'navegador' ? ' (navegador)' : '';
        setStatus('ok', `${data.count} canales - actualizado ${formatTime(data.fetchedAt || Date.now())}${source}`);
    } else {
        if (zones.length) {
            setStatus('err', `Sin conexion (${error.message}) - mostrando la ultima lista`);
        } else {
            setStatus('err', 'Sin conexion con el servidor');
            skeletonEl.classList.add('hidden');
            stateEl.className = 'state error';
            stateEl.innerHTML = `No se pudieron cargar los canales.<br>
                <small>${error ? error.message : ''}</small><br><br>
                <button class="btn" id="retry">Reintentar</button>`;
            stateEl.classList.remove('hidden');
            const retry = $('#retry');
            if (retry) retry.onclick = () => loadChannels(true);
        }
    }

    loading = false;
    refreshBtn.disabled = false;
    skeletonEl.classList.add('hidden');
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function zoneLinks(zone) {
    return (zone.subLinks || []).filter((l) => l && l.url);
}

function countLinks(list) {
    return list.reduce((acc, z) => acc + zoneLinks(z).length, 0);
}

function matches(name) {
    if (!query) return true;
    return String(name || '').toLowerCase().includes(query);
}

function render() {
    let visibleZones = 0;
    let visibleLinks = 0;

    channelsEl.innerHTML = '';

    for (const zone of zones) {
        const links = zoneLinks(zone).filter((l) => matches(l.name));
        if (query && links.length === 0) continue;

        visibleZones++;
        visibleLinks += links.length;

        // Con busqueda las categorias se abren para poder ver las coincidencias.
        const expanded = query ? true : isExpanded(zone.name);
        const section = document.createElement('section');
        section.className = 'zone' + (expanded ? '' : ' collapsed');
        section.dataset.zone = zone.name;

        const head = document.createElement('div');
        head.className = 'zone-head';
        head.innerHTML = `
            <span class="zone-arrow">&#9654;</span>
            <span class="zone-title">${escHtml(zone.name)}</span>
            <span class="zone-count">${links.length}</span>
        `;
        head.onclick = () => {
            const willExpand = section.classList.contains('collapsed');
            section.classList.toggle('collapsed', !willExpand);
            setExpanded(zone.name, willExpand);
            updateToggleLabel();
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
    updateToggleLabel();

    bindRowActions();
}

function rowHtml(link) {
    const ace = isAce(link.url);
    const badge = ace
        ? '<span class="badge ace">ACE</span>'
        : '<span class="badge web">WEB</span>';

    // El ID del canal se muestra siempre: es el hash que usa AceStream.
    const id = ace ? contentId(link.url) : (link.url || '');
    const idHtml = id
        ? `<div class="ch-id" title="ID del canal">${escHtml(id)}</div>`
        : '';

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
            <td class="name">${escHtml(link.name)}${badge}${idHtml}</td>
            <td class="actions">
                <span class="row-actions">${main}${copy}</span>
            </td>
        </tr>
    `;
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
 *
 * Se guarda la lista de categorias ABIERTAS. Por defecto todas estan
 * condensadas: solo se despliega la que el usuario abre.
 * ------------------------------------------------------------------ */

const EXPANDED_KEY = 'acestream_expanded_zones_v2';
let expandedZones = new Set();

try {
    const stored = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]');
    expandedZones = new Set(Array.isArray(stored) ? stored : []);
} catch (_) {
    expandedZones = new Set();
}

function isExpanded(name) {
    return expandedZones.has(name);
}

function setExpanded(name, expanded) {
    if (expanded) expandedZones.add(name);
    else expandedZones.delete(name);
    try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedZones]));
    } catch (_) {
        /* ignore */
    }
}

function saveExpanded() {
    try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedZones]));
    } catch (_) {
        /* ignore */
    }
}

// El boton dice siempre la proxima accion: si todo esta contraido, "Expandir todo".
function updateToggleLabel() {
    const anyExpanded = zones.some((z) => isExpanded(z.name));
    toggleAllBtn.textContent = anyExpanded ? 'Contraer todo' : 'Expandir todo';
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
    const anyExpanded = zones.some((z) => isExpanded(z.name));
    expandedZones = new Set();
    if (!anyExpanded) {
        for (const z of zones) expandedZones.add(z.name);
    }
    saveExpanded();
    render();
});

loadChannels(false);
