# TAKURO v2 — en vivo para compartir

Versión funcional para dar el link a otras personas:
- **Front** en Vercel (estático, HTTPS). El GPS funciona en el móvil.
- **Relay** en Render (WebSocket efímero, memoria).
- **E2E** en los privados: ECDH P-256 + AES-256-GCM (WebCrypto, sin dependencias). El relay solo ve paquetes opacos.
- Las 3 salas generales (Muros que Oyen, La Casa del Té, El Mercado) son públicas y efímeras (TTL), igual que en la demo.
- Sin relay configurado, la app cae sola a modo simulación (bots).

## Despliegue (sin git local, todo desde el navegador)

### 1. Sube el código a GitHub
1. Crea un repo (github.com → New repository, marca **Private**; da igual).
2. Sube estos archivos con el botón **Add file → Upload files**:
   - `relay.py`
   - `Dockerfile`
   - `render.yaml`
   - Página: también puedes subir la carpeta `public` completa en una segunda subida para que el front y el relay vivan en el mismo repo. Si prefieres, el front puede ser un repo aparte.

### 2. Relay en Render (WebSocket)
1. https://render.com → "Sign in with GitHub".
2. **New → Blueprint** y pega el URL de tu repo (usa el archivo `render.yaml`).
3. Al crearse, Render te da una URL: **`https://takuro-relay.onrender.com`** (puede tardar 1-2 min en el 1er arranque).
4. Anota el **WebSocket**: `wss://takuro-relay.onrender.com/ws`.

> Nota honesta: en el plan free Render duerme el servicio tras ~15 min de inactividad; el 1er toque tarda unos segundos en despertar. Los mensajes también se pierden al reiniciar (en memoria, por diseño: "nada se guarda").

### 3. Conecta el front
En `public/js/config.js` edita:
```js
relay: "wss://takuro-relay.onrender.com/ws",
```

### 4. Front en Vercel (estático)
- Opción A (recomendada si el front está en GitHub): vercel.com → Add New → Import GitHub repo que contiene `public` → cambiar **Root Directory** a `public` → Deploy.
- Opción B (sin GitHub): https://vercel.com → *Add New → Project* o la zona de **Drag & Drop** con la carpeta `public` (Vercel detecta estático).
- Obtienes: **`https://takuro-v2.vercel.app`** → ese es el link que compartes.

### 5. Prueba final
- Abre el link en 2 teléfonos/en la PC. GPS obligatorio al entrar.
- Comparte salas (públicas), escríbete DM (cifrado E2E, solo si ambos están en la misma zona y en línea), crea un grupo y copia el código TK-XXXXX.

## Local (sin nube)
```bat
python relay.py 8080 8081
```
- Web: http://localhost:8080 (móvil: http://TU-IP:8080)
- Y edita `config.js` con `relay: "ws://TU-IP:8081/ws"`.

## Límites honestos de v2
- Los DM son E2E; las salas generales y los grupos son públicos por diseño (no cifrados).
- No hay anti-screenshot real (llega en la app nativa).
- Takus y likes siguen siendo locales (demo). Sin inventario server-side todavía.
- Sin rate-limit ni moderación real (plan: radicarse en F3).