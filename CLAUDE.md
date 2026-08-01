# EL DOBLAJE — contexto del proyecto

Juego de fiesta donde varias personas doblan por turnos los segmentos de un clip de
video y reciben un puntaje de qué tan parecida quedó su interpretación al original.
Inspirado en *Choicer Voicer*, pero con multipista, salas remotas y puntaje real.

Hablar en español con el usuario. Sus respuestas preferidas son directas y sin rodeos.

---

## Mantener este archivo al día

Si un cambio toca algo de arquitectura (estructura de archivos, reglas de la sección
"Reglas que no se rompen", el formato de `api/room.js`, los pesos del motor de
análisis, etc.), actualizar este `CLAUDE.md` **en el mismo commit** que el cambio de
código. Un `CLAUDE.md` desactualizado deja de servir en un par de sesiones y empieza
a dar contexto falso en vez de ayudar.

---

## Estructura

```
index.html        La app entera: HTML + CSS + JS en un solo archivo, sin build
package.json      Solo declara @vercel/blob para la función serverless
api/room.js       Función serverless de Vercel: salas temporales
LEEME.md          Guía de despliegue para el usuario
```

Desplegado en **Vercel, plan Hobby (gratuito)**, como sitio estático con carpeta `api/`.
Preset de framework: *Other*.

---

## Reglas que no se rompen

**Sin build step, sin framework, sin bundler.** `index.html` se abre directo en un
navegador y funciona. No introducir React, Vite, npm scripts de compilación ni
dividir el archivo en módulos. Si algo necesita una librería, se carga por CDN de
forma perezosa y con degradación elegante si falla (así están el QR y ffmpeg.wasm).

**Nada de `localStorage` ni `sessionStorage`.** La persistencia de clips usa
IndexedDB con respaldo en memoria si no está disponible (`Store` al inicio del script).

**El video nunca se sube al servidor.** Es la decisión de arquitectura central. El
servidor guarda solo segmentos y pistas de voz: ~1 MB por sala. Si se subiera el
video (10–50 MB), el límite de transferencia de Vercel Blob (10 GB/mes en Hobby) se
agotaría en unas 80 partidas. Cada jugador usa su propia copia local del archivo.

**El puntaje no debe cambiar por el volumen.** `compare()` normaliza por pico, así que
es inmune al nivel de grabación. La igualación de volumen (`normGain`) se aplica
**solo en la mezcla**, nunca destructivamente sobre `tk.raw`. Mantener esa separación.

---

## Motor de análisis

Todo se remuestrea a **8 kHz** para analizar (`ASR`). Marco de 40 ms (`WIN=320`),
salto de 10 ms (`HOP=80`). El remuestreo a 8 kHz es lo que hace viable la detección
de tono: a 44.1 kHz la autocorrelación costaba ~10⁹ operaciones por clip.

- `extractFeatures(sig)` → `{rms, f0, peak, n}` por marco
- `pitchAt()` — autocorrelación normalizada, rango 70–380 Hz, umbral de correlación 0.45
- `sliceFeat(f, i0, i1)` — recorta rasgos a un segmento, recalculando el pico
- `compare(ref, take)` → cuatro sub-puntajes más el total

Pesos y curva del total:

```js
raw   = timing*0.28 + pitch*0.34 + energy*0.18 + coverage*0.20
total = round(100 * raw^1.45)
```

El exponente 1.45 comprime el rango medio a propósito: sin él, una toma mediocre
sacaba 75 y todo se sentía regalado. Verificado contra imitaciones sintéticas:
copia exacta = 100, retraso de 400 ms = 33, hablar sin parar = 56.

**Entonación** compara el contorno *relativo* en semitonos (se resta la mediana de cada
uno), de modo que voces graves y agudas compiten parejo. **Sincronía** compara máscaras
de habla/silencio dilatadas ±4 marcos (40 ms de tolerancia).

---

## Cómo probar

No hay navegador aquí. El método que funciona:

```bash
# 1. Sintaxis
python3 -c "
import re; s=open('index.html').read()
open('/tmp/c.js','w').write(re.findall(r'<script>(.*?)</script>', s, re.S)[-1])"
node --check /tmp/c.js
node --check api/room.js

# 2. Lógica pura: extraer bloques por sus comentarios delimitadores
#    y exportarlos con module.exports + un setEnv que inyecta globals
```

Las funciones puras (análisis, puntaje, mezcla, codificación) se extraen recortando
entre los comentarios `/* ===== ... ===== */` y se prueban con **señales sintéticas**:
ráfagas tonales con armónicos, contorno de tono y envolvente. Sirven para verificar
puntajes, detección de segmentos, niveles y el viaje exportar→importar.

Para probar `api/room.js` sin desplegar, crear un `@vercel/blob` falso en memoria en
`node_modules/` que exporte `put`, `list`, `del`, más un `fetch` global que resuelva
las URLs simuladas.

**Trampa conocida:** al simular dos jugadores en la misma sala, cada uno necesita su
**propia instancia del módulo** (`delete require.cache[...]` antes de cada `require`).
Compartir el módulo hace que el estado `S` se pise entre jugadores y produce fallos
fantasma que parecen bugs de la app pero son del arnés.

Borrar los archivos de prueba antes de entregar; no deben quedar en el repo.

---

## Detalles que costaron encontrar

**`seekTo()` espera el evento `seeked`.** Asignar `video.currentTime` y reproducir de
inmediato arranca unos milisegundos corrido, lo que castigaba la sincronía
injustamente. No reemplazar por asignación directa.

**La grabación captura con `ScriptProcessorNode`** (obsoleto pero universal) en vez de
`MediaRecorder`, para tener muestras crudas alineadas al reloj de `AudioContext`. El
desfase entre el arranque del video y el inicio de captura se corrige con `startIdx`,
restando el sobrepaso medido. `AudioWorklet` requeriría un archivo aparte o un blob,
lo que choca con la regla de archivo único.

**`getUserMedia` pide `echoCancellation`, `noiseSuppression` y `autoGainControl` en
`false`.** Con el control automático de ganancia activo, el análisis de energía es
inútil porque el navegador aplana la dinámica.

**ffmpeg.wasm desde CDN necesita `classWorkerURL`.** El build UMD carga su worker con
una ruta relativa (`814.ffmpeg.js`) que falla por origen cruzado. Hay que pasarlo como
blob. Versiones fijadas y verificadas: ffmpeg 0.12.15, util 0.12.2, core 0.12.10.

**MP4 se intenta primero de forma nativa** (`MediaRecorder.isTypeSupported`). Chrome,
Edge y Safari lo graban directo; Firefox cae a WebM y solo entonces se descarga el
conversor. No invertir ese orden: la conversión es lentísima comparada con lo nativo.

---

## Servidor de salas (`api/room.js`)

Tres acciones sobre un único endpoint:

| Petición | Efecto |
|---|---|
| `POST ?action=create` | Crea sala, devuelve código de 4 caracteres |
| `POST ?action=track&code=XXXX` | Sube o reemplaza una pista |
| `GET ?code=XXXX` | Listado de la sala |
| `GET ?code=XXXX&track=ID` | Descarga una pista con su audio |

**Los metadatos de pista viajan dentro del nombre del archivo**, codificados en
base64url:

```
salas/<CÓDIGO>/pistas/<id>__<timestamp>__<b64meta>.json
```

Así el listado sale de un solo `list()` sin descargar ningún blob. Es lo que permite
que el sondeo cada 8 segundos no consuma transferencia. Si se cambia el formato del
nombre, hay que actualizar `parseTrackPath()` en el mismo archivo.

Al subir una pista se borran las versiones anteriores del mismo `id`, así que
regrabar no acumula basura. El timestamp en el nombre también evita servir versiones
cacheadas por el CDN.

Los `id` se sanean con `safeId()` a `[A-Za-z0-9]` — probado contra intentos de escape
tipo `../../`. El alfabeto de códigos excluye caracteres ambiguos (I, L, O, 0, 1).

Las salas mueren a las **48 horas**; la limpieza es oportunista al crear salas nuevas,
sin cron (Hobby tiene cuota limitada de cron jobs).

---

## Cliente de salas

Estado en `S.party = {code, mine, map, seen, timer, busy}`.

- `map` traduce id remoto → id de pista local, para que sincronizar dos veces no duplique
- `seen` guarda el último timestamp visto por pista, para no rebajar lo que ya se tiene
- `busy` es una **marca de tiempo**, no un booleano: si una petición se cuelga, el
  candado caduca a los 30 segundos en vez de matar la sincronización para siempre

`ingestTrack()` es compartida entre la importación por archivo y la sincronización de
sala. Siempre **recalifica** las tomas contra el clip local en vez de confiar en el
puntaje que venga del otro lado.

---

## Ideas pendientes

- **Puerta de ruido**: la igualación de volumen sube el ruido de fondo junto con la voz
  cuando alguien graba en ambiente ruidoso
- **Ensayo en bucle**: hoy son 1, 2 o 3 repeticiones fijas; para frases largas sería
  mejor repetir hasta que la persona presione una tecla
- **Detección de segmentos con música de fondo**: el umbral relativo al pico (`VOICE_FLOOR
  = 0.10`) funciona con diálogo limpio, pero con música continua no encuentra silencios
- **Modo en vivo por WebRTC**: las salas actuales son asíncronas; falta el modo
  "todos conectados a la vez" tipo Jackbox
- **Ajuste de ganancia por toma** (hoy solo hay por pista)

---

## Advertencias legales que el usuario ya conoce

El plan Hobby de Vercel es solo para uso personal y no comercial. No añadir descarga
de clips de YouTube ni de ningún servicio de streaming: viola sus términos y crearía
responsabilidad sobre contenido con derechos de autor en un proyecto pensado para
publicarse. La app trabaja con archivos que el usuario ya tiene en su equipo.
