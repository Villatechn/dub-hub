# EL DOBLAJE — desplegar y jugar con amigos

## Poner la app en línea (Vercel, plan Hobby, gratis)

1. Sube esta carpeta a un repo de GitHub (o corre `vercel --prod` desde aquí con el
   CLI, sin GitHub).
2. En [vercel.com](https://vercel.com): **Add New Project** → importa el repo.
   Framework preset: **Other**. No toques build command ni output directory: es un
   sitio estático más la carpeta `api/`.
3. **Paso obligatorio**: en el proyecto ya creado, ve a **Storage** → conecta tu Blob
   store. Eso inyecta sola la variable `BLOB_READ_WRITE_TOKEN` que usa `api/room.js`.
   Sin esto, CREAR SALA responde error 500.
4. Si conectaste el Blob después del primer deploy, hace falta un **redeploy** para
   que la función vea la variable (Deployments → ⋯ → Redeploy).

El archivo `.env.local` de esta carpeta tiene tu token para pruebas locales y está
ignorado por git a propósito — no lo subas a ningún lado.

## Cómo se juega en sala

1. Carga tu clip, deja que detecte los segmentos y dale **CREAR SALA**.
2. Si dejas marcado **COMPARTIR EL VIDEO EN LA SALA**, el clip se sube (hasta 25 MB) y
   tus amigos no necesitan tener el archivo: lo bajan al entrar. Si lo desmarcas, cada
   quien tiene que conseguir el mismo archivo por su cuenta.
3. Pásales el **código de 4 letras**, el enlace o el QR.
4. Quien abre el enlace ve de una vez qué necesita. Si la sala trae video, le sale
   **DESCARGAR EL VIDEO Y ENTRAR** y queda listo de un clic.
5. Cada quien elige cuál pista es la suya y graba. Con **SUBIR CADA TOMA
   AUTOMÁTICAMENTE** marcado, las tomas viajan solas; los demás las reciben en menos
   de 8 segundos y aparecen ya calificadas contra su propia copia del clip.

No hace falta que estén conectados al mismo tiempo: la sala aguanta **48 horas** y
cada quien graba cuando pueda.

## Límites a tener en cuenta

- Plan Hobby de Vercel: uso personal, no comercial.
- Blob gratis: 10 GB de transferencia al mes. Sin compartir el video solo viajan las
  voces (~1 MB por sala) y no lo vas a notar. Compartiendo un clip de 20 MB con 4
  amigos gastas ~80 MB por partida, o sea unas 125 partidas al mes.
- Tope de 25 MB por clip. Si tu video pesa más, la casilla se deshabilita sola y te
  dice cuánto pesa; recórtalo o mándalo por tu cuenta.
- Las salas y sus videos se borran solos a las 48 horas. No hay que limpiar nada.
