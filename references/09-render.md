# 09. Рендер: из одного HTML в MP4

Ролик живёт как `window.__draw(t)` — чистая функция времени. Рендер — это цикл вызовов `__draw(t)` с шагом `1/fps` и склейка PNG в видео. Звук считается отдельно, в `OfflineAudioContext`, и склеивается на этапе ffmpeg.

## 9.1 Три пути получения файла

| Путь | Выход | Время на 60 с | Детерминизм | Когда брать |
|---|---|---|---|---|
| MediaRecorder в браузере | WebM (VP9 + Opus) | ровно 60 с, реальное время | нет, зависит от загрузки CPU | черновик ритма, показать в чате |
| headless Chrome + PNG + ffmpeg | MP4 (H.264 + AAC) | 2–6 мин | полный: кадр = `__draw(f/fps)` | финальный файл |
| `--screenshot` / DevTools | одиночный PNG | 0.3–0.8 с на кадр | кадр детерминирован | отладка текста, цвета, композиции |

Правило: MediaRecorder — только для проверки темпа и монтажа. Всё, что уходит заказчику, — MP4 из покадрового рендера.

### MediaRecorder: WebM в реальном времени

```js
// Пишет то, что видит зритель. Дропы кадров возможны — это норма для черновика.
const stream = canvas.captureStream(30);
const ac = new AudioContext({ sampleRate: 48000 });
const dest = ac.createMediaStreamDestination();
buildSound(ac, dest);                       // тот же buildSound, что и в offline-рендере
dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));

const rec = new MediaRecorder(stream, {
  mimeType: 'video/webm;codecs=vp9,opus',
  videoBitsPerSecond: 12_000_000,
});
const chunks = [];
rec.ondataavailable = e => e.data.size && chunks.push(e.data);
rec.onstop = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  a.download = 'draft.webm';
  a.click();
};
rec.start(1000);
// гоняем __draw(ac.currentTime) в rAF до __meta.duration
```

`captureStream(0)` + `track.requestFrame()` даёт ручную подачу видеокадров, но звук всё равно идёт по часам реального времени — рассинхрон на 90 с доходит до 0.3–0.8 с.

## 9.2 OfflineAudioContext → WAV

`OfflineAudioContext` считает сэмплы без обращения к звуковой карте: 90 с стерео 48 кГц рендерятся за 1–3 с и всегда занимают ровно 4 320 000 сэмплов. Это единственный способ получить дорожку, совпадающую с видео с точностью до сэмпла.

Пошагово:

1. Длительность аудио = `__meta.duration` ровно, без округлений до такта.
2. `OfflineAudioContext(2, ceil(duration * 48000), 48000)`.
3. Весь звук планируется на абсолютном времени от `0`, без `setTimeout`.
4. `startRendering()` → `AudioBuffer` → 16-bit PCM WAV.
5. WAV сохраняется рядом с кадрами и подаётся в ffmpeg как второй вход.

```js
// audio.js — тот же код работает и в превью, и в офлайн-рендере
async function renderWav(duration, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.7;                 // запас 3 дБ под пики
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.ratio.value = 4; comp.attack.value = 0.003;
  master.connect(comp).connect(ctx.destination);
  buildSound(ctx, master);                 // всё планируется, ничего не ждёт
  return encodeWav(await ctx.startRendering());
}

// 44-байтный заголовок + interleaved int16
function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, rate = buf.sampleRate;
  const dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, data[c][i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([dv.buffer], { type: 'audio/wav' });
}
```

Передача из браузера в Node:

```js
// 90 с стерео = 17.3 МБ PCM → 23 МБ base64. До 120 с терпимо, дальше — только download.
window.__wav = async () => {
  const blob = await renderWav(window.__meta.duration);
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);                          // Runtime.evaluate с returnByValue
};
```

Для длинных дорожек — `Browser.setDownloadBehavior` с `downloadPath` и клик по `<a download>`, файл появится на диске без base64.

## 9.3 Покадровый рендер через CDP

Chrome запускается один раз, кадры снимаются по протоколу. Зависимостей нет: в Node 24 `WebSocket` и `fetch` встроены.

```js
// render.js — node render.js index.html out 30
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9222;
const html = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3]);
const fpsArg = Number(process.argv[4] || 0);
const framesDir = path.join(outDir, 'frames');
fs.mkdirSync(framesDir, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'code-video-prof')}`,
  '--window-size=1920,1080', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--force-color-profile=srgb',
  '--font-render-hinting=none', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let ws, seq = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

async function wsUrl() {
  for (let i = 0; i < 150; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('Chrome не поднялся за 15 с');
}

(async () => {
  ws = new WebSocket(await wsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: pathToFileURL(html).href });

  const evalJs = async (expression, awaitPromise = true) =>
    (await S('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })).result.value;

  for (let i = 0; i < 300 && !(await evalJs('window.__ready === true')); i++) {
    await new Promise(r => setTimeout(r, 100));             // ждём контракт кадра
  }
  if (!(await evalJs('window.__ready === true'))) throw new Error('__ready не выставлен за 30 с');
  await evalJs('document.fonts.ready.then(() => true)');

  const meta = await evalJs('window.__meta');
  const fps = fpsArg || meta.fps || 30;
  const total = Math.round(meta.duration * fps);
  console.log(`кадров: ${total}, ${meta.width}x${meta.height} @ ${fps}`);
  const t0 = Date.now();                   // время стенных часов только для лога

  for (let f = 0; f < total; f++) {
    const t = f / fps;
    await evalJs(`window.__draw(${t})`);
    await evalJs('new Promise(r => requestAnimationFrame(() => r(1)))');
    const { data } = await S('Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
    fs.writeFileSync(path.join(framesDir, `f_${String(f).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
    if (f % 30 === 0) console.log(`${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  }

  const wav = await evalJs('window.__wav()');
  fs.writeFileSync(path.join(outDir, 'audio.wav'), Buffer.from(wav, 'base64'));
  ws.close(); chrome.kill();
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
```

Порядок кадров и таймауты:

- `f` идёт строго 0…N−1, имя `f_%05d.png`, никакой параллельности: один таб, один canvas.
- `total = Math.round(duration * fps)`. Для 90 с при 30 fps это 2700 кадров, последний `f_2699`, `t = 89.9667`.
- Таймаут на команду 30 с; первый кадр после `Page.navigate` — до 90 с (растеризация шрифтов, сборка текстур).
- Общий вотчдог 15 мин: `setTimeout(...).unref()` + `process.exit(1)`.
- `optimizeForSpeed: true` режет PNG-компрессию: кадр пишется в 2–3 раза быстрее, файл весит на 20–40 % больше (220–600 КБ против 180–400 КБ). Для PNG-последовательности это выгодно.
- Скан 1920×1080 PNG — 40–120 мс, запись — 5–15 мс. Итого 60–150 мс на кадр: 2700 кадров ≈ 3–7 мин.
- `<script type="module">` из `file://` не грузится (CORS). Ролик — один HTML с инлайновым классическим `<script>`.

## 9.4 Почему нельзя `--screenshot` на каждый кадр

`chrome --headless=new --screenshot=f.png` — это новый процесс браузера на каждый кадр:

- холодный старт 350–800 мс, из них 120–250 мс — запуск процессов и `BrowserMain`;
- шрифты и GPU-контекст поднимаются заново каждый раз;
- нет способа передать `t`: время задаётся только `--virtual-time-budget`, а он идёт от загрузки страницы, а не от нуля ролика;
- имя файла фиксировано, параллельный запуск дерётся за профиль и порт.

2700 кадров × 0.5 с = 22 минуты против 3–7 минут через CDP, при этом без гарантии одинакового состояния. Одиночный `--screenshot` годен ровно для одного дела — посмотреть композицию кадра:

```bash
# один кадр для проверки композиции — не для рендера
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --window-size=1920,1080 --force-device-scale-factor=1 --virtual-time-budget=2000 --screenshot="C:\work\reel\frame.png" "file:///C:/work/reel/index.html?t=12.5"
```

Одна строка — потому что в PowerShell `^` не является переносом строки: команду нужно писать целиком либо переносить обратным апострофом.

## 9.5 ffmpeg: сборка H.264

```bash
ffmpeg -y -framerate 30 -start_number 0 -i frames/f_%05d.png -i audio.wav -vf "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high -level 4.1 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -fps_mode cfr -r 30 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart -shortest out.mp4
```

| Флаг | Значение | Почему именно так |
|---|---|---|
| `-framerate 30` | входная частота PNG | без него ffmpeg возьмёт 25 fps и растянет время |
| `-crf 18` | качество | 16–18 для графики с резкими краями; 20 уже даёт ореолы на тексте |
| `-preset slow` | скорость/размер | ×1.6 времени рендера, −20 % битрейта |
| `-pix_fmt yuv420p` | цветность | иначе QuickTime и часть плееров не откроют файл |
| `-colorspace bt709` | тег матрицы | HD-плеер по умолчанию считает BT.709; без тега ffmpeg пишет BT.601 |
| `-movflags +faststart` | moov в начало | иначе воспроизведение в браузере стартует после полной загрузки |

Аудио отдельной командой, если нужно нормализовать:

```bash
ffmpeg -y -i audio.wav -af "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000" -c:a pcm_s16le audio_norm.wav
```

Склейка готовых частей (одинаковые параметры кодека):

```bash
ffmpeg -y -f concat -safe 0 -i list.txt -c copy -movflags +faststart full.mp4
```

`list.txt` — строки `file 'part1.mp4'`. Если части кодировались разными `-crf` или разрешением, `-c copy` даст рассинхрон: перекодировать в один проход через `filter_complex` с `concat=n=3:v=1:a=1`.

## 9.6 Проверка результата

```bash
ffprobe -v error -show_entries stream=index,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,sample_rate,channels -show_entries format=duration,size,bit_rate -of default=noprint_wrappers=1 out.mp4
```

| Поле | Ожидание для 90 с / 30 fps | Что значит отклонение |
|---|---|---|
| `r_frame_rate` | `30/1` | `2997/100` или `24000/1001` — VFR попал в файл |
| `avg_frame_rate` | `30/1` | расходится с `r_frame_rate` — дропы/дубли |
| `nb_frames` | 2700 | меньше — кадры потеряны при сборке |
| `duration` (video) | 90.000 ± 0.034 | ±1 кадр — предел, больше — арифметика `t` |
| `duration` (audio) | 90.000 ± 0.010 | короче — обрезан хвост, длиннее — `-shortest` не сработал |
| `bit_rate` | 8–20 Мбит/с | 40+ — шум и градиенты жрут битрейт, 2 — кадр «поплыл» |

Быстрая проверка на битые кадры:

```bash
ffmpeg -v error -i out.mp4 -f null - 2>&1
```

Пустой вывод = поток декодируется целиком.

## 9.7 Контактный лист

```bash
ffmpeg -y -i out.mp4 -vf "fps=2,scale=480:-1,tile=5x3" -frames:v 1 sheet.png
```

15 плиток по 480×270 = 2400×810, шаг 0.5 с → лист покрывает 7.5 с. Для 90 с нужно 12 листов:

```bash
ffmpeg -y -i out.mp4 -vf "fps=2,scale=480:-1,tile=5x3" -fps_mode vfr sheets/s_%02d.png
```

На листе ищут: пустые кадры, обрезанный текст, одинаковые соседние плитки (застывшая анимация), провалы по яркости между главами.

## 9.8 Ошибки

| Симптом | Причина | Фикс |
|---|---|---|
| Звук уходит вперёд к концу на 0.3–1 с | WAV из MediaRecorder, видео покадрово | `OfflineAudioContext` + `-shortest` |
| Картинка дёргается на ровном движении | `__draw` читает `Date.now()` или состояние | только `t`, проверить двойным прогоном и `fc /b` |
| Дропнутые кадры, «строб» | VFR во входе или `-vsync` по умолчанию | `-fps_mode cfr -r 30` |
| Зелёный оттенок, бледный циан | RGB→YUV по BT.601, теги BT.709 | `scale=out_color_matrix=bt709` + три тега |
| Видео 89.97 с, аудио 90.00 с | `Math.floor(duration*fps)` | `Math.round`, `total*fps` в мете |
| Первый кадр чёрный | снимок до `fonts.ready` | ждать `__ready` и `document.fonts.ready` |
| Последний кадр пустой | цикл до `f <= total` | `f < total` |
| Текст в PNG жирнее, чем в превью | `deviceScaleFactor` ≠ 1 | `Emulation.setDeviceMetricsOverride` |
| `Runtime.evaluate` виснет | `awaitPromise` без `returnByValue` | оба флага вместе |
| WebGL-кадр пустой | software-GL в headless | `--enable-unsafe-swiftshader` или `preserveDrawingBuffer: true` |
