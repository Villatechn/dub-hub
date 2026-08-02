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

**El Blob store es PRIVADO.** No es un detalle menor: el modo de acceso se fija al
crear el store y **Vercel no deja cambiarlo después**. Todo lo que escribe la función
usa `access: 'private'`, y nada se sirve por URL pública — hasta los trozos del video
pasan por la función, que los lee con `get()` y los reenvía. Requiere
`@vercel/blob >= 2.3`; el `package.json` fija `^2.6.1`. Si alguna vez se quiere volver
al modo público (más barato de entregar), hay que crear un store nuevo, no cambiar
este.

Desplegado en **Vercel, plan Hobby (gratuito)**, como sitio estático con carpeta `api/`.
Preset de framework: *Other*.

---

## Reglas que no se rompen

**Sin build step, sin framework, sin bundler.** `index.html` se abre directo en un
navegador y funciona — con una sola excepción: **las salas no**, porque en `file://`
no existe `/api/room` y `fetch` falla con un `TypeError` seco. El panel PARTY lo
detecta (`sinServidor()`), se marca SIN SERVIDOR y explica que el resto sí sirve.
Al probar salas hay que usar el sitio publicado o `vercel dev`. No introducir React, Vite, npm scripts de compilación ni
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

Sigue vigente el porqué de la regla vieja, y con el store privado pesa más: cada
trozo que baja un amigo es **una invocación de función** y se cobra como *Fast Data
Transfer*, que Vercel documenta como ~3× más caro que el *Blob Data Transfer* de los
stores públicos. Con clips de 20 MB y 4 amigos son ~80 MB por partida. **No subir el
video por omisión, no quitar el tope de 25 MB y no subir `CLIP_CHUNK` sin recalcular
el margen de 4.5 MB.**

**El puntaje no debe cambiar por el volumen.** `compare()` normaliza por pico, así que
es inmune al nivel de grabación. La igualación de volumen (`normGain`), los volúmenes
manuales y la puerta de ruido se aplican **solo en la mezcla**, nunca destructivamente
sobre `tk.raw`. Mantener esa separación: es lo que permite subirle el volumen a una
toma o limpiarle el ruido sin que a nadie le cambie la nota.

**Nunca escribir `gain||1`.** Un volumen de 0 es legítimo — significa mudo — y `||1`
lo convierte en 1, dejando sonando a todo volumen justo lo que se mandó callar. Para
eso está `vol1()`, que solo cae a 1 cuando el valor falta o es basura. Se coló una vez
en seis sitios a la vez (mezcla, exportación, sincronización e importación) al añadir
los sliders, porque antes los botones `−`/`+` nunca bajaban de 0.25.

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

## Mezcla: volúmenes y puerta de ruido

Toda la ganancia pasa por un solo punto, `takeGain()`, que multiplica tres cosas:
igualación automática (`tk.norm`, si está marcada) × volumen de la pista (`t.gain`,
slider en la cabecera) × volumen de la toma (`tk.gain`, clic derecho sobre la celda,
o pulsación larga en móvil). Los tres viajan en la exportación y en la sincronización
de sala.

La **puerta de ruido** (`gateEnvelope`) devuelve una envolvente de ganancia por marcos
de 5 ms; `mixdown()` la interpola por muestra. Nunca modifica `tk.raw`. Cómo funciona:
el piso de ruido es el **percentil 20** de los RMS por marco, el umbral de apertura es
ese piso por un factor según el nivel, hay histéresis al 60 % para que no parpadee, y
la máscara se **dilata ±3 marcos** para no comerse el ataque de la primera sílaba ni
la cola de la última. Al final una media móvil de ±4 marcos suaviza las rampas.

Cada nivel se define por su piso, que es literalmente cuánto baja en los silencios:
0.50 (suave, −6 dB), 0.22 (media, −13 dB), 0.06 (fuerte, −24 dB). Verificado con
señales sintéticas: el ruido baja esos valores exactos y la voz queda en 0.0 dB.

Dos salvaguardas que importan: si el umbral quedara por encima del 60 % del pico se
recorta, para que **hablar sin parar no se recorte**; y con silencio absoluto o tomas
de menos de 8 marcos devuelve `null` (no hay nada que separar). La envolvente se
**cachea por toma y nivel**, porque es cara y no depende del volumen.

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
`node_modules/` que exporte `put`, `list`, `del` y **`get`** (devolviendo
`{statusCode, stream, blob}` con un `ReadableStream` de verdad, que es lo que consume
`readBlob()`). Requisitos que costaron un fallo cada uno:

- **Guardar `Buffer`, no `String`**: los trozos del clip son binarios y pasarlos por
  `String()` los corrompe sin que ninguna prueba de texto lo note.
- **Reproducir el rechazo a sobrescribir** y el error de acceso público sobre store
  privado. Si el falso es más permisivo que el SDK real, las pruebas pasan y la
  producción revienta — que es exactamente lo que ocurrió.
- **Un interruptor de fallo** (`_failWith(msg)`) consultado *dentro* de cada función.
  `room.js` desestructura `put/list/del/get` al cargar el módulo, así que reasignar
  `blob.get` desde la prueba no tiene ningún efecto.

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
   computadoras sin dos navegadores. Al recargar para probar otra sala, **cambiar
   también algo fuera del `#hash`** (`?r=2`): navegar de `#sala=AAAA` a `#sala=BBBB`
   es navegación en el mismo documento, no recarga, e `init()` nunca vuelve a correr
   — se queda el estado de la sala anterior y parece que todo falla.
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
| `GET ?code=XXXX&clip=N&ts=T` | Descarga **un trozo** del video (binario) |

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
salas/<CÓDIGO>/clip/<TS>__manifest__<b64meta>.json   ← {name, type, size, n}
salas/<CÓDIGO>/clip/<TS>__parte__NNN.bin             ← binario crudo, 2.5 MB por trozo
```

El `TS` lo genera **el cliente una vez por subida** y lo manda en cada trozo; agrupa
la subida completa. Existe por dos razones concretas: el SDK moderno **lanza error al
escribir sobre un pathname que ya existe** (salvo `allowOverwrite`), y reescribir el
mismo nombre podía servir el trozo viejo hasta 60 s por la caché del CDN. Con el
sello, cada subida estrena rutas y ninguno de los dos problemas aparece.

`clipFrom()` toma el manifiesto con el `TS` más alto, junta solo los trozos de ese
mismo sello y **devuelve `null` si faltan**, de modo que una subida interrumpida no se
anuncia como clip usable. Devuelve **URLs a la propia función** (`?clip=N&ts=T`), no
del CDN: el store es privado. El índice va con ceros a la izquierda y además se ordena
numéricamente — un trozo fuera de orden produciría un video corrupto.

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

- **Ensayo en bucle**: hoy son 1, 2 o 3 repeticiones fijas; para frases largas sería
  mejor repetir hasta que la persona presione una tecla
- **Detección de segmentos con música de fondo**: el umbral relativo al pico (`VOICE_FLOOR
  = 0.10`) funciona con diálogo limpio, pero con música continua no encuentra silencios
- **Modo en vivo por WebRTC**: las salas actuales son asíncronas; falta el modo
  "todos conectados a la vez" tipo Jackbox
- **Puerta de ruido por pista**: hoy el nivel es global para toda la mezcla; con un
  ambiente muy distinto entre jugadores convendría poder ajustarlo por pista

---

## Advertencias legales que el usuario ya conoce

El plan Hobby de Vercel es solo para uso personal y no comercial. No añadir descarga
de clips de YouTube ni de ningún servicio de streaming: viola sus términos y crearía
responsabilidad sobre contenido con derechos de autor en un proyecto pensado para
publicarse. La app trabaja con archivos que el usuario ya tiene en su equipo.
