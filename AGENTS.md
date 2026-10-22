# AGENTS.md — AceStream Links

Guía de trabajo para agentes y personas que toquen este repositorio. Describe la
arquitectura, el origen de los datos, las reglas de estilo y los fallos ya
diagnosticados para no repetirlos.

---

## 1. Qué es esta app

Directorio web de canales de AceStream. **Los enlaces no están escritos en el
código**: se resuelven en tiempo real leyendo los registros **DNS TXT** que
publica la red de AceStream. Por eso el listado se actualiza solo y por eso un
enlace puede desaparecer de un día para otro.

- **Frontend**: HTML/CSS/JS plano, sin build, sin framework, sin bundler.
- **Backend**: una función serverless de Vercel (Node.js, CommonJS) en `api/`.
- **Despliegue**: Vercel (frontend estático + función en `api/`), conectado al
  repo `BURNI80/AceStreamLinks` (rama `main`).

> **URL de producción**: `https://ace-stream-links.vercel.app`
> El campo *homepage* del repo apunta a `ac-stream-links.vercel.app` (**incorrecto**,
> ese dominio no existe → `DEPLOYMENT_NOT_FOUND`). Si tocas el dominio, corrígelo
> también en GitHub → Settings → Website → URL.

---

## 2. Estructura del repositorio

```
index.html             Frontend completo: markup + CSS inline. Sin build.
app.js                 Lógica del frontend: fetch, render, búsqueda, plegado.
dns-resolver.js        Respaldo: resuelve los canales desde el navegador (DoH).
api/channels.js        Función serverless: GET /api/channels
lib/dns-channels.js    Núcleo: resolución DNS TXT + recursión de categorías + caché.
scripts/dev-server.js  Servidor local que replica el entorno de Vercel.
package.json           Dependencias y scripts (npm run dev).
README.md              Documentación breve de usuario.
ads.txt                Publicador de AdSense: pub-7345993626465257
Links.txt              Links sueltos (herencia del sitio antiguo).
Canales.txt            Volcado estático de canales (herencia del sitio antiguo).
index-def.html         Versión anterior del HTML (no se usa, no tocar sin motivo).
```

**No borrar** `Links.txt`, `Canales.txt` ni `index-def.html` sin pedirlo: son
herencia del sitio original y no están relacionados con el listado dinámico.

---

## 3. De dónde salen los datos (lo importante)

Cada canal vive en un subdominio de `elcano.top`. El subdominio tiene un registro
`TXT` con un JSON `{ name, url }` por canal, codificado en **base64 + gzip**.

Un subdominio puede apuntar a otro subdominio:

```json
{ "type": "category", "ref": "692421ae3451b27a40bca964" }
```

Lo que genera un **árbol de categorías** que se resuelve recursivamente
(profundidad máxima `MAX_DEPTH = 5`).

- **Dominio raíz**: `682cb7103451b27a40bc9aa2.elcano.top` → el árbol completo
  (36 categorías, ~389 canales). Es el que usa la web por defecto.
- Los subdominios se obtienen **añadiendo `.elcano.top`** al `ref`.

### Formato de la respuesta interna

```js
zones: [
  { name: "ELCANO > DAZN", subLinks: [ { name: "DAZN 1 FHD", url: "acestream://..." } ] }
]
```

Reglas de nombres (heredadas del servidor de streaming, no inventadas aquí):
- Una categoría que apunta a otra genera `"PADRE > HIJO"`.
- Las categorías planas (sin hijos) usan el nombre de la categoría.
- El primer label del subdominio se usa como nombre de zona (`eventos`, `695d5309...`).
  **Esto produce nombres feos como `ELCANO > 695d5309d05ee80b5cd7efad`.** Es el
  dato de origen, no un bug: no lo "arregles" reescribiendo nombres en la UI
  salvo que el usuario lo pida explícitamente.

### Los 3 transportes DNS (y por qué)

En `lib/dns-channels.js` los transportes se lanzan **en paralelo** y gana el
primero que devuelve una lista parseable válida:

| # | Transporte | Notas |
|---|-----------|-------|
| 1 | DNS crudo **TCP:53** a los NS autoritativos de `elcano.top` | `dns-packet`. Es lo que hace el servidor de streaming. |
| 2 | **DNS-over-HTTPS** (`cloudflare-dns.com`, `dns.google`) | `Access-Control-Allow-Origin: *`, funciona desde el navegador. |
| 3 | **Resolutor del sistema** (`dns.resolveTxt`) | Último recurso. |

`transportState` recuerda qué transporte funcionó y descarta los que fallan, así
que no se repite el intento perdido en cada dominio.

---

## 4. Fallos ya diagnosticados — NO repetirlos

Estos tres bugs tumbaron la app en producción. Están arreglados; si reescribes
`lib/dns-channels.js` o `dns-resolver.js`, no los reintroduzcas.

### 4.1 Timeouts encadenados → la función moría

Con el puerto 53 bloqueado por firewall, el `connect` TCP se queda colgado hasta
el timeout. Con 6 NS × 4 s eran **24 s solo para el primer dominio**, y la
función serverless moría antes de responder.

**Regla**: los transportes van **en paralelo** (no en cascada) y el timeout de TCP
es de 2 s. Un transporte que falla se descarta, no se reintenta en serie.

### 4.2 Una respuesta degenerada tumbaba toda la petición

`parseTxtData('')` lanzaba `Unexpected end of JSON input` y mataba la petición
completa en vez de pasar al siguiente transporte.

**Regla**: **cada transporte valida su parseo** (`Array.isArray(data) &&
data.length > 0`) y se descarta si no devuelve una lista. El parseo va *dentro*
del `try` del transporte, nunca fuera.

### 4.3 `Promise.any` con funciones sin invocar

`Promise.any(attempts.map((t) => async () => {...}))` devuelve la propia función
(las promesas se resuelven al instante) y revienta con `data.every is not a
function`.

**Regla**: `Promise.any` recibe **promesas**, no funciones. Si usas `.map()` con
una arrow async, **invócala**: `.map((t) => (async () => {...})())`.

### 4.4 La app en blanco sin lista ni IDs

Si `/api/channels` no responde (404 de un despliegue estático, error de red,
timeout), la página se quedaba vacía. Por eso existe `dns-resolver.js`.

**Regla**: el frontend **nunca** depende en exclusiva de la API. Si falla, cae al
respaldo del navegador y lo indica en el estado (`(navegador)`).

---

## 5. API

### `GET /api/channels?domain=<subdominio.elcano.top>`

Sin `domain` usa el dominio raíz (árbol completo).

```json
{
  "success": true,
  "domain": "682cb7103451b27a40bc9aa2.elcano.top",
  "zones": [{ "name": "...", "subLinks": [{ "name": "...", "url": "acestream://..." }] }],
  "count": 389,
  "fetchedAt": 1760000000000,
  "elapsedMs": 1
}
```

| Código | Cuándo |
|--------|--------|
| 200 | OK |
| 400 | `domain` con formato inválido |
| 502 | No se pudo resolver el TXT (el mensaje incluye el detalle de cada transporte) |

Cabeceras: `Access-Control-Allow-Origin: *` y
`Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600`.

### Reglas de la función

- CommonJS: `module.exports = async function handler(req, res)`.
- Usa `res.status(...).json(...)` (API estilo Express que Vercel añade).
- `scripts/dev-server.js` emula esas ayudas (`res.status`, `res.json`) para poder
  probar en local. Si añades un helper nuevo, **añádelo también al dev server**.
- `req.query` (no `req.url`).
- **No uses `req.body`**: es GET.

---

## 6. Frontend

### Estados de la UI

| Elemento | ID | Rol |
|---|---|---|
| Buscador | `#search` | Filtra por nombre de canal |
| Expandir/contraer | `#toggle-all` | Su etiqueta dice siempre la **próxima** acción |
| Actualizar | `#refresh` | Fuerza refetch (`?t=timestamp`) |
| Estado | `#status-text` / `#status-dot` | `ok` / `err` / `loading` + origen del dato |
| Skeleton | `#skeleton` | Placeholder mientras carga |
| Error | `#state` | Mensaje + botón Reintentar |
| Sin resultados | `#empty` | Búsqueda sin coincidencias |
| Listado | `#channels` | Se inyecta desde JS |

### Reglas de renderizado

- **Nada de `document.write`.** Todo se construye con `createElement` + `innerHTML`
  de plantillas, y **todo texto de datos pasa por `escHtml()`** (los nombres
  vienen de DNS y pueden llevar `<`, `&`, emoji, etc.).
- Las **categorías arrancan condensadas**. Se guarda la lista de las **abiertas**
  (`localStorage`), no la de las plegadas. Si se cambia este criterio, hay que
  subir la versión de la clave.
- Con **búsqueda activa** las categorías se abren automáticamente para mostrar
  las coincidencias; al limpiar la búsqueda se vuelve al estado guardado.
- Las URLs `acestream://` muestran botón **"Ver"** (abre la app) + **copiar ID**.
  Las `http(s)` muestran **"Abrir"** en pestaña nueva y la URL bajo el nombre.
- El **ID/hash de 40 hex** se muestra siempre bajo el nombre del canal: es lo que
  la gente copia a mano.

### Claves de `localStorage`

| Clave | Contenido | TTL |
|---|---|---|
| `acestream_channels_v1` | `{ zones, count, fetchedAt }` | 5 min |
| `acestream_expanded_zones_v2` | array de nombres de categorías **abiertas** | sin TTL |

Al cambiar el formato de cualquiera, **sube el sufijo `_vN`**.

### Rutas de los scripts

```html
<script src="dns-resolver.js"></script>
<script src="app.js"></script>
```

**Relativas, nunca `/absolutas`**: así la web también funciona abriendo el
`index.html` desde el disco (`file://`), donde el respaldo por DoH es el único
que puede funcionar.

---

## 7. Estilo

- Español en toda la UI, en los comentarios y en los commits.
- Sin framework, sin build step, sin `npm` en el frontend.
- CSS con variables en `:root` (`--bg`, `--surface`, `--accent: #6200ea`,
  `--accent-soft: #af76ff`, `--text-dim`, `--border`).
- Sidebars con AdSense: `data-ad-client="ca-pub-7345993626465257"`, los
  `data-ad-slot` son **placeholders** (`YYYYYYYYYY`, `ZZZZZZZZZZ`) — hay que
  sustituirlos por los reales.
- Responsive con dos breakpoints: `900px` (sidebar arriba) y `768px` (móvil).
- `escHtml()` en todo dato externo. Sin excepciones.

---

## 8 Desarrollo local

```bash
npm install
npm run dev        # http://localhost:3000
```

`scripts/dev-server.js` sirve el frontend y monta la misma función que Vercel.
**No hace falta la CLI de Vercel para probar nada.**

### Simular la API caída (para probar el respaldo)

```bash
BROKEN_API=1 npm run dev          # bash / Git Bash
```

```powershell
$env:BROKEN_API=1; npm run dev    # PowerShell
```

`/api/channels` responde 404 y el frontend debe caer al resolutor del navegador.

### Comprobaciones manuales

```bash
# API
curl -s http://localhost:3000/api/channels | head -c 300

# Resolución directa
node -e "require('./lib/dns-channels').fetchChannelData('682cb7103451b27a40bc9aa2.elcano.top').then(z=>console.log(z.length,'zonas'))"
```

### Verificar en navegador real

Para comprobar el DOM de verdad (no solo el código), usar Chrome headless con
CDP; `curl` no ejecuta JS. Un esqueleto útil:

```bash
chrome.exe --headless=new --disable-gpu --user-data-dir=<perfil limpio> \
  --screenshot=out.png --virtual-time-budget=9000 http://localhost:3000/
```

**Ojo**: sin `--user-data-dir` limpio, el estado plegado de `localStorage` de
sesiones anteriores falsea la captura.

---

## 9. Despliegue

- Vercel, rama `main`, proyecto `ace-stream-links` (cuenta `burni80s-projects`).
- **No hace falta `vercel.json`**: Vercel detecta `api/` automáticamente.
- `package.json` con `dependencies` es obligatorio: `dns-packet` se instala en el
  build. Es una dependencia **opcional en tiempo de ejecución** (`require` dentro
  de `try/catch`): si no está, la app cae a DoH y sigue funcionando.
- Cada `git push` a `main` dispara un despliegue. El estado se ve en GitHub
  (commit → Checks → Vercel) o en `gh api repos/BURNI80/AceStreamLinks/commits/<sha>/status`.

---

## 10. Reglas para los agentes

1. **No hardcodear canales ni enlaces.** Si hace falta un canal nuevo, se
   resuelve en tiempo de ejecución desde el DNS.
2. **No tocar la lógica de resolución sin reasonar sobre los fallos de la §4.**
   Son cosas que ya costaron una caída en producción.
3. **Validar en el navegador**, no solo leer el código. Esta app falla de forma
   silenciosa (se queda en blanco) si el fetch no devuelve JSON válido.
4. **Mantener el respaldo del navegador.** Es lo que garantiza que la web
   funcione aunque la función serverless no esté desplegada.
5. **Un cambio, un commit**, mensaje en español explicando el *porqué*.
6. **No hacer push sin que lo pida** explícitamente: un push despliega a producción.
7. **No tocar Vercel** (ni la CLI, ni la configuración del proyecto) salvo
   petición expresa.
8. Al añadir dependencias del frontend, remember: **no hay build step**. Solo
   scripts planos o CDN con `script` tags.

---

## 11. Glosario

| Término | Significado |
|---|---|
| **contentId / hash** | Identificador de 40 hex del torrent en AceStream (`acestream://<hash>`) |
| **TXT** | Registro DNS que contiene el JSON de canales en base64+gzip |
| **NS autoritativo** | Servidor DNS que tiene la respuesta real de `elcano.top` |
| **DoH** | DNS-over-HTTPS: consultar DNS por HTTP en lugar de UDP/TCP |
| **zona** | Una categoría con su lista de `subLinks` (canales) |
| **ref** | Nombre del subdominio hijo al que apunta una categoría |
