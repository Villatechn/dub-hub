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
.env.example      Plantilla vacía de variables; esta sí se versiona
.env.local        Token real de Blob. IGNORADO por git, nunca versionarlo
.gitignore        Ignora .env*, node_modules/ y .vercel
```

La función necesita `BLOB_READ_WRITE_TOKEN`. En producción la inyecta Vercel sola al
conectar el Blob store desde la pestaña *Storage*; `.env.local` es solo para local.
**Nunca poner el token en un archivo versionado** ni pegarlo en `index.html`, que se
sirve al público entero.

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

**El video se comparte solo si el usuario lo pide, y con tope.** Durante mucho tiempo
la regla fue que el video *nunca* se subía; se relajó porque exigir que cada amigo
consiguiera el archivo por su cuenta era la mayor fricción para jugar. Hoy:

- La sala funciona igual de bien **sin** video: es el modo de siempre.
- Quien crea la sala puede marcar «COMPARTIR EL VIDEO», con tope de **25 MB**
  (`MAX_CLIP`). Pasado ese tamaño la casilla se deshabilita sola.
- Quien entra por el enlace y ya tiene el mismo archivo (mismo nombre y tamaño) lo
  reusa de su biblioteca en vez de bajarlo: bajarlo otra vez gasta cuota.

Sigue vigente el porqué de la regla vieja: con clips de 20 MB y 4 amigos son ~80 MB
por partida, así que el límite de transferencia de Vercel Blob (10 GB/mes en Hobby)
da para unas 125 partidas. **No subir el video por omisión ni quitar el tope.**

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

En el equipo del usuario hay **Node** (instalado con `winget install OpenJS.NodeJS.LTS`)
y **no hay python**. Extraer el script con PowerShell, no con python3:

```powershell
$s = Get-Content index.html -Raw
$m = [regex]::Matches($s, '(?s)<script>(.*?)</script>')
$m[$m.Count-1].Groups[1].Value | Out-File -FilePath "$env:TEMP\c.js" -Encoding utf8
node --check "$env:TEMP\c.js"
node --check api/room.js
```

Ojo: cada llamada a PowerShell arranca con el `Path` viejo, así que Node no aparece
hasta refrescarlo:
`$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")`

Las funciones puras (análisis, puntaje, mezcla, codificación) se extraen recortando
entre los comentarios `/* ===== ... ===== */` y se prueban con **señales sintéticas**:
ráfagas tonales con armónicos, contorno de tono y envolvente. Sirven para verificar
puntajes, detección de segmentos, niveles y el viaje exportar→importar.

Para probar `api/room.js` sin desplegar, crear un `@vercel/blob` falso en memoria en
`node_modules/` que exporte `put`, `list`, `del`, más un `fetch` global que resuelva
las URLs simuladas. **Que guarde `Buffer`, no `String`**: los trozos del clip son
binarios y pasarlos por `String()` los corrompe sin que ninguna prueba de texto lo note.

**Probar el juego entre dos personas de verdad, en el navegador.** Es lo único que
encontró los dos bugs de ids de segmento; las pruebas de Node los daban por buenos
porque el arnés usaba los mismos ids en ambos lados. La receta:

1. Un servidor local mínimo que sirva `index.html`, enrute `/api/room` al handler y
   sirva los blobs falsos con `access-control-allow-origin: *`. Que mande
   `cache-control: no-store`, o el navegador seguirá ejecutando la versión vieja y se
   pierde un rato largo persiguiendo un fantasma.
2. Apuntar las URL del blob falso al servidor local (una variable de entorno basta).
3. Jugador A en `localhost:PUERTO`, jugador B en `127.0.0.1:PUERTO`. **Son orígenes
   distintos**, así que tienen IndexedDB separados: es la forma de simular dos
   computadoras sin dos navegadores.
4. Como no hay micrófono, inyectar la toma directo en `S.takes` calculando
   `compare()` a mano, y para el clip fabricar un **WAV sintético** con ráfagas
   tonales — la app acepta `audio/*` y `autoSegments()` detecta las ráfagas como
   segmentos.

Borrar los archivos de prueba antes de entregar; no deben quedar en el repo. En
particular **borrar el `@vercel/blob` falso de `node_modules/`**: si se queda, la app
parece funcionar pero guarda todo en memoria y no persiste nada.

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

**Los ids de segmento NUNCA se comparan entre jugadores; se emparejan por tiempo.**
Esto costó dos bugs seguidos y los dos eran silenciosos — las tomas simplemente no
aparecían, sin ningún error. `nid()` mete azar en cada id, así que dos personas que
segmentan el mismo clip sacan **los mismos tiempos con ids distintos**:

- `partySync()` construía un mapa identidad (`map[s.id]=s.id`) sobre los segmentos
  *locales*. Cuando los cortes calzaban, `partyJoin()` no adoptaba los ids de la sala
  y el mapa nunca contenía el id ajeno: se descartaban **todas** las tomas. Lo
  perverso es que fallaba justo en el caso bueno (todos con el mismo clip) y
  funcionaba cuando los cortes *no* calzaban. Hoy usa `mapSegments(room.segments)`,
  el mismo emparejador por solapamiento de la importación por archivo.
- `partyPush()` subía las tomas con los ids *locales* de quien graba. El que recibía
  no tenía cómo relacionarlos con los de la sala. Hoy traduce a los ids de la sala
  antes de subir, usando `S.party.segs` como referencia canónica.

La regla que queda: **lo que viaja se referencia siempre a `S.party.segs`** (los
segmentos de la sala, definidos por quien la creó). Cualquier código nuevo que mande
o reciba tomas tiene que traducir en la frontera, nunca asumir que un id ajeno
significa algo localmente.

**Un trozo de clip no puede pasar de 4.5 MB.** Es el tope de tamaño de petición de
las funciones serverless de Vercel. Por eso `CLIP_CHUNK` son 2.5 MB *en crudo*: ya en
base64 pesan ~3.4 MB y la petición completa llega a 3.33 MB medidos. Subir el trozo
no deja margen para mucho más. La bajada no tiene este problema porque va directo al
CDN.

---

## Servidor de salas (`api/room.js`)

Tres acciones sobre un único endpoint:

| Petición | Efecto |
|---|---|
| `POST ?action=create` | Crea sala, devuelve código de 4 caracteres |
| `POST ?action=track&code=XXXX` | Sube o reemplaza una pista |
| `POST ?action=clip&code=XXXX` | Sube **un trozo** del video (opcional) |
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

**Los metadatos de la sala (clip + segmentos) viven en un blob aparte**, con el
vencimiento también codificado en el nombre para no tener que descargarlo solo para
saber si expiró:

```
salas/<CÓDIGO>/meta__<expiresAt>.json
```

`findRoomMeta()` hace un solo `list()` con prefijo `salas/<CÓDIGO>/`, filtra por ese
patrón y **devuelve también el listado completo**, del que salen las pistas y el clip
sin pedir nada más. Si se cambia el formato, actualizar `findRoomMeta()` y
`cleanupExpired()` juntos: ambas funciones parsean el mismo nombre.

**El video, cuando se comparte, va troceado:**

```
salas/<CÓDIGO>/clip/manifest__<b64meta>.json   ← {name, type, size, n}
salas/<CÓDIGO>/clip/parte__NNN.bin            ← binario crudo, 2.5 MB por trozo
```

`clipFrom()` arma la respuesta y **devuelve `null` si faltan trozos**, de modo que una
subida interrumpida no se anuncia como clip usable. El listado entrega las **URL
públicas del CDN**, no el contenido: la bajada nunca pasa por la función serverless.
El índice va con ceros a la izquierda y además se ordena numéricamente — un trozo
fuera de orden produciría un video corrupto.

Las salas mueren a las **48 horas**; la limpieza es oportunista al crear salas nuevas
(`cleanupExpired()` lista hasta 1000 blobs bajo `salas/` y borra los de código vencido),
sin cron (Hobby tiene cuota limitada de cron jobs).

---

## Cliente de salas

Estado en `S.party = {code, mine, map, seen, segs, timer, busy}`.

- `map` traduce id remoto → id de pista local, para que sincronizar dos veces no duplique
- `seen` guarda el último timestamp visto por pista, para no rebajar lo que ya se tiene
- `segs` son los **segmentos canónicos de la sala**: la referencia contra la que se
  traduce todo lo que entra y sale (ver la nota sobre ids de segmento más arriba)
- `busy` es una **marca de tiempo**, no un booleano: si una petición se cuelga, el
  candado caduca a los 30 segundos en vez de matar la sincronización para siempre

`S.pending` guarda la sala a la que invitaron pero a la que todavía no se entra. Al
abrir un enlace `#sala=XXXX`, `lookupRoom()` consulta la sala **antes** de exigir un
clip y `renderInvite()` muestra qué hace falta: si la sala trae video, ofrece bajarlo
y entrar de una vez; si no, dice exactamente qué archivo hay que conseguir. Antes se
pedía «carga el clip» sin decir cuál, que era el punto donde la gente se atascaba.

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
