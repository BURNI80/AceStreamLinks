# AceStream Links

Listado de canales de AceStream **dinamico**: los enlaces no estan escritos en el HTML,
se resuelven en tiempo real leyendo los registros **DNS TXT** de AceStream.

## De donde salen los enlaces

Cada canal vive en un subdominio de `elcano.top` con un registro TXT que contiene un JSON
`{ name, url }` codificado en **base64 + gzip**. Un subdominio puede apuntar a otro con
`{ type: "category", ref: "<subdominio>" }`, lo que genera un arbol de categorias que se
resuelve recursivamente (profundidad maxima 5).

El dominio raiz `682cb7103451b27a40bc9aa2.elcano.top` ya incluye el arbol completo
(35 categorias, ~372 canales).

## Estructura

```
api/channels.js      Funcion serverless (Vercel): GET /api/channels[?domain=...]
lib/dns-channels.js  Resolucion DNS TXT + recursion de categorias + cache
app.js               Frontend: pinta, filtra y cachea en el cliente
index.html           Frontend (markup + estilos)
scripts/dev-server.js Servidor local que replica el entorno de Vercel
```

## API

| Endpoint | Metodo | Descripcion |
|----------|--------|-------------|
| `/api/channels` | GET | Canales del dominio raiz (el arbol completo) |
| `/api/channels?domain=<sub>` | GET | Canales de un subdominio concreto |

Respuesta:

```json
{
  "success": true,
  "domain": "682cb7103451b27a40bc9aa2.elcano.top",
  "zones": [{ "name": "ELCANO > DAZN", "subLinks": [{ "name": "DAZN 1 FHD", "url": "acestream://..." }] }],
  "count": 372,
  "fetchedAt": 1760000000000,
  "elapsedMs": 247
}
```

## Resolucion DNS

Se prueban tres transportes en orden y se usa el primero que responda:

1. **DNS crudo por TCP:53** contra los NS autoritativos de `elcano.top` (igual que el
   servidor de streaming). Requiere `dns-packet`.
2. **Resolutor del sistema** (`dns.resolveTxt`).
3. **DNS-over-HTTPS** (`cloudflare-dns.com` / `dns.google`).

El resultado se cachea 5 minutos en memoria de la instancia y la respuesta lleva
`Cache-Control: s-maxage=300` para la CDN de Vercel.

## Desarrollo local

```bash
npm install
npm run dev      # http://localhost:3000
```

El servidor local sirve el frontend y monta la misma funcion que usa Vercel, asi que no
hace falta la CLI de Vercel para probar los cambios.

## Despliegue en Vercel

El proyecto se despliega como Vercel (frontend estatico + funcion en `api/`). No hace
falta `vercel.json`: Vercel detecta `api/` automaticamente.
