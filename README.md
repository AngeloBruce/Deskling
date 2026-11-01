# Deskling 🦀

Un compañero de escritorio para Windows: un bichito pixelado que vive en una esquina
de la pantalla, mira qué música escuchas y en qué estás trabajando, te comenta
cosas y te avisa de tus notificaciones **aunque tengas activado No molestar**.

Usa IA gratis (Groq o NVIDIA) y filtra contraseñas, códigos y otros datos sensibles
**antes** de mandar cualquier cosa.

**Qué hace:**
- 🎵 Comenta la música que suena y baila con Spotify. Controla play/pausa y siguiente desde el menú o con la rueda del mouse.
- 💻 Opina sobre lo que estás haciendo (título de la ventana y, si lo activás, una captura filtrada).
- 📩 Te lee las notificaciones de Windows, aunque tengas No molestar activado.
- 🍅 Modo foco (pomodoro): se calla, te guarda las notificaciones y te avisa si te vas a YouTube.
- ✅ Te avisa cuando Claude Code termina o necesita permiso.
- 📊 Al final del día te muestra un resumen: apps, pomodoros, canciones.
- 💻 De vez en cuando saca su laptop y se pone a teclear.
- 🔐 Todo pasa por un filtro de seguridad local antes de salir a la IA.

## Cómo usarlo

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Copia `.env.example` como `.env` y pon tu key gratis de Groq
   (https://console.groq.com/keys).
3. Arráncalo:
   ```bash
   npm start
   ```

### Instalarlo como programa (.exe)

```bash
npm run dist
```

Genera `dist/Deskling Setup 0.1.0.exe`. Al abrirlo, se instala solo para tu usuario (sin pedir administrador) en `%LOCALAPPDATA%\Programs\deskling`, con accesos directos en el escritorio y en el menú Inicio. Se desinstala desde Configuración → Aplicaciones.

- **Tus datos van aparte**, en `%APPDATA%\Deskling`: ahí van `config.json`, los logs y el `.env` con tu key. Copiá ahí tu `.env` antes de abrirlo por primera vez. La key nunca se mete adentro del instalador.
- **Aviso de Windows SmartScreen:** como el `.exe` no está firmado (un certificado cuesta plata), Windows puede mostrar "Windows protegió su PC". Tocá *Más información → Ejecutar de todas formas*.
- **Si `npm run dist` falla con "Cannot create symbolic link"**: es un problema conocido de electron-builder en Windows sin permisos de administrador. Activá el *Modo de programador* de Windows, o extraé a mano `winCodeSign` en `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` sin la carpeta `darwin`.

- **Doble clic** en Clawd → opina ahora.
- **Clic derecho** en Clawd (o en el ícono de la bandeja) → pausar, activar la captura de pantalla, ver el registro de seguridad, salir.
- **Arrastrarlo** para moverlo.

## Qué ve y qué manda

| Fuente | Cómo se lee | ¿Sale de la PC? |
|---|---|---|
| Ventana activa | API de Windows (título + proceso) | Sí, el título filtrado. Las apps de `privateApps` se mandan como "[app privada]" |
| Música | Control de medios de Windows (Spotify, YouTube, etc.) | Sí: artista y canción |
| Notificaciones | `UserNotificationListener` de Windows | **No.** Se muestran solo en el globito; a la IA solo le llega el nombre de la app |
| Captura (apagada por defecto) | Captura → OCR **local** de Windows → guard | Solo si el OCR no encontró nada sensible |

## Seguridad (`src/guard.js`)

Todo el texto pasa por el guard, que:
- tacha API keys, tarjetas (validadas con Luhn), emails y teléfonos;
- detecta palabras como *contraseña*, *código de verificación*, *OTP*, *PIN*… y tacha los códigos;
- bloquea capturas que tengan algo de eso;
- deja registrado en `logs/guard.log` **qué** bloqueó (nunca el dato).

Pruebas: `npm test`.

## Configuración (`config.json`)

- `provider`: `groq` o `nvidia`.
- `cooldownSeconds`, `musicCooldownSeconds`: cuánto espera entre comentarios.
- `workCommentDelaySeconds`: cuánto tienes que quedarte en una app para que la comente.
- `checkinMinutes`: cada cuánto hace un comentario general.
- `screenCapture`: `true` para que también mire la pantalla (se puede cambiar desde el menú).
- `privateApps`: palabras que, si aparecen en la app o el título, hacen que no mire ni mande nada.
- `ignoredNotificationApps`: apps cuyas notificaciones ignora.
- `personality`: la personalidad de Clawd.
- `avoidEmojis`: emojis que Clawd nunca usa (si se le escapa uno, lo cambia por ✨).

- `claudeCode`: avisos de Claude Code (ver abajo). `nagMinutes` = cuánto espera antes de enojarse.
- `focus`: modo foco / pomodoro (`workMinutes`, `breakMinutes`, `longBreakMinutes`, `cyclesBeforeLongBreak`).
  `priorityApps`: apps cuyas notificaciones se muestran igual durante el foco.
- `distractions`: palabras que marcan una app como distracción (`keywords`). En foco avisa a los
  `focusSeconds` segundos; fuera del foco, a los `minutes` minutos.

## Control de música

- Clic derecho → arriba del menú aparece la canción con ⏮ ⏯ ⏭ (el menú queda abierto para pasar varias).
- Rueda del mouse sobre Clawd: para arriba = siguiente, para abajo = anterior.
- Controla la app que está sonando; si no suena nada, Spotify (`src/sensors/win-sensors.ps1`, el mismo que lee la música).

## Modo foco

Clic derecho → **Modo foco**. Mientras dura (25 min por defecto):
- Clawd no opina ni tira tips (salvo que le pidas "Opiná ahora");
- las notificaciones se guardan y en el descanso te dice cuántas llegaron y de qué app;
- los avisos de Claude Code sí pasan;
- si te vas a YouTube/TikTok/etc., te lo recuerda.

Al lado de Clawd aparece un contador (🍅 en foco, ☕ en el descanso). Cada 4 focos toca descanso largo.

## Arrancar con Windows

Clawd se abre solo cuando iniciás sesión en Windows (la versión instalada; con `npm start` no se toca el arranque, salvo que uses el interruptor). Se apaga y se prende desde el menú → **"Abrir al iniciar"** (o `autoStart` en `config.json`). Lo que hace es crear una tarea `Deskling` en el Programador de tareas y una entrada en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, porque algunas versiones de Windows 11 ignoran esa lista. Las dos son solo de tu usuario y no necesitan permisos de administrador.

## Resumen del día

Clawd cuenta cuánto tiempo pasás en cada app, las canciones, los pomodoros, las veces que terminó Claude Code y las notificaciones. Todo se guarda en tu PC (`logs/stats-AAAA-MM-DD.json`) y solo cuenta el nombre de la app, nunca el título de la ventana.

El resumen aparece una vez por día:
- cuando tocás **"Terminé por hoy"** en el menú (ese lo podés pedir siempre),
- a las 23 h (`summary.hour`),
- o si después de las 18 h (`summary.afterHour`) dejás la compu sola 30 min (`summary.idleMinutes`). En ese caso queda esperándote en el globito.

Los días con menos de 30 min de uso (`summary.minActiveMinutes`) no tienen resumen automático. A la IA solo le llegan los números y los nombres de las apps, para que agregue una frase de cierre.

## Avisos de Claude Code

`hooks/clawd-hook.js` se registra como hook `Stop` y `Notification` en `~/.claude/settings.json`:

```json
"hooks": {
  "Stop":         [{ "hooks": [{ "type": "command", "command": "node \"C:/ruta/a/Deskling/hooks/clawd-hook.js\"", "timeout": 5 }] }],
  "Notification": [{ "hooks": [{ "type": "command", "command": "node \"C:/ruta/a/Deskling/hooks/clawd-hook.js\"", "timeout": 5 }] }]
}
```

Cuando Claude termina o te pide permiso, Clawd te avisa (si no estás mirando la app de Claude, la terminal o VS Code).
Si no vas a verlo en `nagMinutes`, se enoja 😤. El hook solo habla con `127.0.0.1` y si Clawd está cerrado no hace nada.

Depuración: con `CLAWD_DEBUG=1` escribe todo lo que pasa en `logs/debug.log`.

## Estructura

```
src/
  main.js              proceso principal: ventana, bandeja, decide cuándo hablar
  brain.js             cliente de la IA (API compatible con OpenAI)
  guard.js             filtro de datos sensibles
  preload.js           puente seguro ventana ↔ main
  sensors/
    win-sensors.ps1    ventana activa, música y notificaciones (PowerShell)
    ocr.ps1            OCR local de capturas
    index.js           arranca los scripts y emite eventos
  renderer/            el sprite de Clawd, el globito y las animaciones
test/guard.test.js     pruebas del filtro
```

> Clawd es la mascota de Claude Code y una marca de Anthropic. Este es un proyecto
> personal de fans, no es oficial.

## Aviso

Proyecto personal y sin fines de lucro. **No tiene relación con Anthropic.**
El personaje Clawd y la marca Claude pertenecen a Anthropic. Este repo solo se inspira en ellos.

## Licencia

El código está bajo licencia [MIT](LICENSE).
