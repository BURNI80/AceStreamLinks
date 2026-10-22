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
api/channels.js       Funcion serverless (Vercel): GET /api/channels[?domain=...]
lib/dns-channels.js   Resolucion DNS TXT + recursion de categorias + cache
dns-resolver.js       Respaldo: el navegador resuelve lo mismo via DoH si la API falla
app.js                Frontend: pinta, filtra y cachea en el cliente
index.html            Frontend (markup + estilos)
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

Se prueban tres transportes **en paralelo** y gana el primero que devuelve datos validos:

1. **DNS crudo por TCP:53** contra los NS autoritativos de `elcano.top` (igual que el
   servidor de streaming). Requiere `dns-packet`.
2. **DNS-over-HTTPS** (`cloudflare-dns.com` / `dns.google`).
3. **Resolutor del sistema** (`dns.resolveTxt`).

Los transportes que fallan se descartan solos, asi que si el puerto 53 esta bloqueado
(firewall de un entorno serverless) no se pierde tiempo esperando timeouts. Una respuesta
vacia o corrupta tambien se descarta en vez de tumbar la peticion.

El resultado se cachea 5 minutos en memoria de la instancia y la respuesta lleva
`Cache-Control: s-maxage=300` para la CDN de Vercel.

## Respaldo en el navegador

Si `/api/channels` no responde (funcion no desplegada, 404, error de red, timeout...), el
frontend no se queda en blanco: `dns-resolver.js` resuelve el mismo arbol de canales
desde el navegador usando DNS-over-HTTPS. El estado de la pagina indica la origen:

```
389 canales - actualizado 13:54:51 (navegador)
```


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
