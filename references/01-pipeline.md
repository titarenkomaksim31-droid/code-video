# Один HTML-файл: конвейер ролика 1920×1080

Ролик 20–90 с собирается как одна страница: Canvas 2D, синтез звука через Web Audio, никаких внешних файлов. Рендерер вызывает `window.__draw(t)` для каждого кадра с шагом `1 / fps`; тот же файл открывается в браузере для превью. Код — vanilla JS под Chrome/Edge без сборки; Node 24 нужен только внешнему циклу захвата и склейки. Ниже — контракт, порядок кода и ограничения, при которых 30 или 60 fps держатся без просадок.

## Почему один файл

| Свойство | Что даёт один файл | Что ломает разбиение на ассеты |
|---|---|---|
| Переносимость | `file:///.../film.html` открывается двойным кликом, без сервера и сборки | нужен HTTP-сервер, пути и MIME |
| CORS | все данные внутри, canvas остаётся origin-clean, работают `toBlob`, `captureStream`, `getImageData` | PNG, SVG и шрифт с `file://` могут дать tainted canvas или 404 |
| Детерминизм | один seed, одни часы, один код картинки и звука | кэш браузера, версия ассета и порядок загрузки меняют кадр |
| Покадровый рендер | один и тот же `__draw(i / fps)` в превью и в headless Chrome | нужна синхронизация нескольких страниц и таймлайнов |

MP4-путь: headless Chrome отдаёт 1920×1080 PNG для кадров `i = 0 … ceil(duration·fps)−1`, звук рендерится один раз в `OfflineAudioContext`, ffmpeg склеивает дорожки. 20 с при 30 fps — 600 кадров, 90 с — 2700 кадров; при 60 fps соответственно 1200 и 5400. Если ffmpeg нет, тот же файл пишет WebM через `canvas.captureStream(fps)` и `MediaRecorder`; это real-time запись, но внешних зависимостей нет.

## Контракт страницы

| Поле | Тип | Обязанность |
|---|---|---|
| `window.__meta` | объект | `{duration, fps, width, height, title}`: duration 20–90 с, width 1920, height 1080, fps 30 или 60 |
| `window.__draw(t)` | функция | синхронно рисует кадр для времени `t` в секундах; не возвращает данные и не меняет глобальное состояние между вызовами |
| `window.__ready` | boolean | `true` после первого успешного `__draw(0)` и подготовки всех offscreen-слоёв и аудиобуфера |

Рендерер ждёт `__ready`, ставит viewport 1920×1080, `deviceScaleFactor: 1`, вызывает `__draw(i / fps)`, снимает PNG. Превью не вызывает `__draw` с часами напрямую: транспорт сам формирует `t` по сетке из `__meta.fps`, поэтому превью и рендер совпадают.

Каркас на 30 строк уже соответствует контракту:

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"><title>Frame contract</title>
<style>html,body{margin:0;background:#05060d;overflow:hidden}canvas{display:block;width:100vw;height:100vh;object-fit:contain}</style>
</head>
<body>
<canvas id="c" width="1920" height="1080"></canvas>
<script>
'use strict';
const W = 1920, H = 1080, FPS = 30, DURATION = 24;
const C = { bg: '#05060d', cyan: '#4ff0ff' };
const ctx = document.getElementById('c').getContext('2d', { alpha: false });

function draw(t) {
  const beat = t % 0.5;                    // сетка 120 BPM
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.cyan;
  ctx.globalAlpha = 0.35 + 0.65 * Math.exp(-8 * beat);
  ctx.fillRect(120, 900, 360 * (1 - Math.exp(-5 * t)), 8);
}
window.__meta = { duration: DURATION, fps: FPS, width: W, height: H, title: 'Frame contract' };
window.__draw = draw;
draw(0);                                   // прогрев до __ready
window.__ready = true;
</script>
</body>
</html>
```

`__meta` пишется один раз до `__ready`. Если аудиобуфер готовится асинхронно, `__ready = true` ставится в `.then()` после `OfflineAudioContext.startRendering()`, а не до него.

## Кадр — чистая функция времени

Внутри `draw(t)` можно читать константы, заранее вычисленные массивы, кэшированные `OffscreenCanvas`, `CanvasPattern` и `AudioBuffer`. Меняющееся значение допустимо, только если оно целиком пересчитано из `t` в этом же вызове: координата, масштаб, альфа, индекс кадра. Нельзя мутировать счётчики, накапливать позиции и читать часы: число вызовов зависит от превью, рендерера и загрузки машины.

```js
// Плохо: результат зависит от количества вызовов
let x = 0;
function drawBad(t) { x += 4; ctx.fillRect(x, 500, 40, 40); }

// Хорошо: позиция вычисляется из t
function drawGood(t) { const x = 80 + 340 * t; ctx.fillRect(x, 500, 40, 40); }
```

Случайность вводится один раз на загрузке через seeded PRNG. `Math.random()` внутри `draw` даёт другую последовательность при повторном рендере: кадр 90 в превью и в PNG не совпадёт, а WebM-запись нельзя воспроизвести.

```js
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(0xC0FFEE);
const stars = Array.from({ length: 220 }, () => ({
  x: rnd() * 1920, y: rnd() * 1080, r: 0.6 + rnd() * 1.8, phase: rnd() * 6.283
}));
```

Для зерна и частиц, которые обязаны меняться от кадра к кадру, сид считается из номера кадра и соли, а не из времени с плавающей точкой:

```js
const frameRng = (i, salt = 0) =>
  mulberry32((Math.imul(i, 2654435761) ^ salt) >>> 0);

// внутри draw: значения только читаются
const r = frameRng(Math.floor(t * FPS), 7);
```

`hp = Math.sin(t * 1.7) * 30` — тоже чистая функция, если амплитуда и фаза заданы константами. Состояние, пришедшее из предыдущего кадра, всегда переписывается в координату: `scale = 1 + 0.06 * Math.exp(-6 * (t % 2))`.

## Скелет файла и порядок секций

| Секция | Что содержит | Почему стоит здесь |
|---|---|---|
| `constants` | `W`, `H`, `FPS`, `DURATION`, палитра, BPM | числа нужны всем нижним секциям и не зависят от них |
| `utils` | `clamp01`, `lerp`, seeded PRNG, easing, работа с цветом | чистые функции без побочных эффектов вызываются из сцен и рендера |
| `prerender` | offscreen-канвасы, спрайты свечения, тайлы зерна, кэш метрик текста | тяжёлая подготовка делается один раз до первого кадра и до `__ready` |
| `audio` | `OfflineAudioContext`, осцилляторы, шумовые буферы, шина эффектов | звук рендерится отдельно от `draw`, но из того же score |
| `score` | массив событий `{t, type, …}`, рассчитанный из BPM | картинка и звук читают одни и те же моменты времени |
| `scenes` | по функции на сцену: `(ctx, t)`, только своя геометрия | сцена не знает о соседях и переходах |
| `render` | порядок слоёв, камера, переходы, вызов `__draw` | единственная точка, где собирается итоговый кадр |
| `transport` | `requestAnimationFrame`, пауза, `__ready`, MediaRecorder | управление временем не смешивается с рисованием |
| `ui` | кнопки, таймкод, прогресс вне canvas | DOM не попадает в кадр и скрывается при захвате |

Порядок `audio` → `score` → `scenes` не случаен: аудио и визуал используют общий ритм, но рендерятся независимо. Ни `audio`, ни `score` не вызываются из `draw`; `draw` только читает уже готовые значения.

## Таймлайн как данные

Сцены — массив, а не цепочка `if` внутри одной функции. Границы лежат на сетке кадров, покрывают `[0, duration)` без разрывов, конец последней сцены равен `duration`.

```js
const scenes = [
  { id: 'intro', from: 0,  to: 3,  draw(g, t) { /* только вход и заголовок */ } },
  { id: 'body',  from: 3,  to: 17, draw(g, t) { /* только основной объект */ } },
  { id: 'outro', from: 17, to: 24, draw(g, t) { /* только финальный кадр */ } },
];

const q = (t) => Math.floor(t * FPS + 1e-6) / FPS;   // квантование вниз

function sceneAt(t) {
  const ft = q(t);
  return scenes.find((s) => ft >= s.from && ft < s.to) ?? scenes.at(-1);
}

// Проверка покрытия и стыков — на загрузке, не в draw
for (let i = 1; i < scenes.length; i++) {
  if (scenes[i].from !== scenes[i - 1].to) throw new Error('разрыв таймлайна');
}
if (scenes[0].from !== 0 || scenes.at(-1).to !== DURATION) throw new Error('плохие границы');
```

Переходы — отдельный слой поверх таймлайна. Сцена не содержит `if (t < 3.3)`, не рисует соседа и не знает, растворяется она или режется. Переходный слой берёт две сцены и смешивает два буфера:

```js
const transitions = [{ at: 3, dur: 0.4, kind: 'dissolve' }];
const A = new OffscreenCanvas(W, H), B = new OffscreenCanvas(W, H);
const ga = A.getContext('2d'), gb = B.getContext('2d');

function paint(g, scene, t) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  scene.draw(g, t);
}

function drawTimeline(t) {
  const ft = q(t);
  const tr = transitions.find((x) => ft >= x.at && ft < x.at + x.dur);
  if (!tr) return paint(ctx, sceneAt(t), t);
  const i = scenes.findIndex((s) => s.from === tr.at);
  const p = ((ft - tr.at) / tr.dur);
  const mix = p * p * (3 - 2 * p);                // сглаживание 0→1
  paint(ga, scenes[i - 1], t);
  paint(gb, scenes[i], t);
  ctx.globalAlpha = 1;
  ctx.drawImage(A, 0, 0);
  ctx.globalAlpha = mix;
  ctx.drawImage(B, 0, 0);
  ctx.globalAlpha = 1;
}
```

Переход ставится только на стык сцен: иначе `findIndex` вернёт −1, и в буфер попадёт `undefined`. Проверяй `scenes.some((s) => s.from === tr.at)` до рендера. Растворение 0.3–0.5 с на 30 fps — это 9–15 кадров и два полных буфера 1920×1080. На 60 fps такой переход дороже: считай его как минимум 2 полных `drawImage` из бюджета ниже.

## Слои кадра

| Слой | Что рисует | Пример | Обновление |
|---|---|---|---|
| `background` | заливка, туманность, сетка, звёзды | `#05060d`, радиальный градиент, 220 звёзд | статика в кэше; движение с parallax 0.2 |
| `mid` | смысловой объект и типографика | заголовок, схема, большие цифры | каждый кадр, parallax 0.5 |
| `foreground` | частицы и свет поверх объекта | пыль, искры, световой лик, сканлайны | каждый кадр, parallax 1.0 |
| `grade` | общий цвет и оптика | виньетка, зерно, цветовой сдвиг | полноэкранно, после мира |
| `hud` | служебные подписи | номер бара, прогресс, уголки | последним, не проходит через grade |

Порядок фиксирован: `grade` смешивает фон, mid и foreground, но не должен тонировать HUD. После `grade` обязательно вернуть `globalCompositeOperation = 'source-over'` и `globalAlpha = 1`, затем рисовать HUD.

```js
function renderFrame(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  drawBackground(t);   // кэш + сдвиг 0.2
  drawMid(t);          // смысл кадра
  drawForeground(t);   // частицы и сканлайны
  drawGrade(t);        // виньетка, зерно, цвет
  drawHud(t);          // тонкие подписи
}
```

## Кэширование

`OffscreenCanvas` 1920×1080 занимает 1920 · 1080 · 4 = 8 294 400 байт, то есть 7,9 МиБ. Пять полных слоёв — уже 39,6 МиБ; два буфера перехода добавляют ещё 15,8 МиБ. Кэшируй не «на всякий случай», а только то, что меняется реже раза в кадр.

- Статический фон: один раз отрисовать в `OffscreenCanvas`, затем один `drawImage` за кадр. Это 2,07 Мпикс копирования; если фон меняется, дешевле держать в кэше только неподвижную часть.
- Свечение: спрайт 128×128 или 256×256 с радиальным градиентом, созданный один раз. Рисовать через `globalCompositeOperation = 'lighter'`; 30–40 спрайтов дешевле, чем 30–40 `shadowBlur`.
- Зерно: 4 тайла 256×256, заполненные `mulberry32`; один `CanvasPattern` и сдвиг на `(i·37) % 256`, `(i·61) % 256`. `globalAlpha` 0.04–0.08.
- Сканлайны: тайл 1×4 с одной непрозрачной строкой, `globalAlpha` 0.04–0.06; паттерн создаётся один раз.
- Метрики текста: массив `{text, width, x}` считается после установки `ctx.font`, а не через `measureText` в каждом кадре.

Кэшировать нельзя: итоговый кадр с движущимся объектом, числа и подписи, зависящие от `t`, динамические траектории частиц и любую геометрию, которая меняется каждый кадр. Кэш градиента с координатами под конкретную трансформацию тоже бесполезен после смены камеры. `putImageData` игнорирует `globalAlpha` и композитинг — для прозрачных слоёв он не заменяет `drawImage`.

```js
function glowSprite(r, rgb) {
  const c = new OffscreenCanvas(r * 2, r * 2);
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, `rgba(${rgb}, 0.9)`);
  gr.addColorStop(0.35, `rgba(${rgb}, 0.35)`);
  gr.addColorStop(1, `rgba(${rgb}, 0)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
}

const glowCyan = glowSprite(128, '79,240,255');
```

## Бюджет производительности

При 60 fps кадр длится 16,67 мс; бюджет `__draw` — 12 мс, остальное оставляем браузеру и захвату. При 30 fps кадр 33,33 мс, бюджет — 25 мс. Превышение на 1 мс в 2700 кадрах добавляет 2,7 с рендера; превышение на 10 мс делает 60 fps невозможными.

| Дорого | Почему | Дёшево |
|---|---|---|
| `shadowBlur = 24` на 120 частицах | 120 blur-проходов за кадр, 7200 в секунду при 60 fps | спрайт 128×128 и `drawImage` с `lighter` |
| `createRadialGradient` в цикле 150 раз | 150 новых объектов и заливок за кадр, 9000 в секунду при 60 fps | 4 заранее созданных спрайта по цветам |
| `measureText` на 80 подписях | shaping строки повторяется каждый кадр, 4800 вызовов в секунду при 60 fps | один замер после `ctx.font`, дальше число |
| `ctx.filter = 'blur(12px)'` на весь экран | фильтр обрабатывает 2,07 Мпикс и часто уходит в CPU | размытый слой один раз в `OffscreenCanvas` |
| 4 × `drawImage` 1920×1080 | 8,3 Мпикс копирования за кадр, 498 Мпикс/с при 60 fps | один статический full-screen слой плюс мелкие спрайты |
| `save/restore` на каждую частицу | стек состояний дороже, чем одна явная установка `globalAlpha` | `save/restore` на группу, поля сбрасываются вручную |

Профилировать только снаружи `__draw`, не внутри:

```js
const t0 = performance.now();
window.__draw(i / FPS);
const frameMs = performance.now() - t0;
```

Если `frameMs > 12` при 60 fps, сначала убирай `filter` и `shadowBlur`, затем full-screen композиты, затем уменьшай число частиц в два раза. Размытие полного экрана — 2,07 Мпикс, а 1500 прямоугольников 8×8 px — 0,096 Мпикс, поэтому blur убирай первым.

## Гигиена canvas

- `save()` и `restore()` — строго парами. Если функция может выбросить исключение, используй `try/finally`, иначе стек и трансформации утекут в следующий кадр.
- В начале каждого кадра `setTransform(1, 0, 0, 1, 0, 0)`. Никакой накопленной `translate` между кадрами.
- Главный контекст берётся с `alpha: false`: пиксели непрозрачны, фон обязан закрашиваться каждый кадр целиком.
- После `shadowBlur` сбрасывай `shadowBlur = 0` и `shadowColor = 'transparent'`; после `lighter` возвращай `globalCompositeOperation = 'source-over'`, после прозрачности — `globalAlpha = 1`.
- `ctx.filter` сбрасывается в `'none'`, иначе он применится к последующим текстам и HUD.
- `clip()` живёт до `restore()`; без парного `save` клип обрежет все следующие слои.
- `fillText` зависит от `textAlign` и `textBaseline`; ставь их перед каждой серией подписей, не наследуй от предыдущей сцены.
- `putImageData` не учитывает `globalAlpha` и `globalCompositeOperation`; для зерна на прозрачном слое используй `drawImage` из `OffscreenCanvas`.
- DPR остаётся 1: bitmap 1920×1080, CSS масштабирует отображение. `canvas.width` и `canvas.height` не меняются от размера окна.

```js
function beginFrame() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.shadowBlur = 0;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
}

function withState(fn) {
  ctx.save();
  try { fn(); } finally { ctx.restore(); }
}
```

## Чек-лист файла

1. `__meta.width === 1920`, `__meta.height === 1080`, `duration` в диапазоне 20–90, `fps` равен 30 или 60.
2. `__draw(0)` выполняется до `__ready = true`, первый кадр не пустой и не содержит артефактов предыдущего запуска.
3. Внутри `draw` нет `Date.now`, `performance.now`, `Math.random` и чтения изменяемых переменных из прошлого кадра.
4. Каждый случайный массив создаётся с `mulberry32` и фиксированным сидом; повторный запуск даёт тот же PNG для того же индекса кадра.
5. Сцены покрывают `[0, duration)` без разрывов, их `from/to` лежат на сетке `1 / fps`, последняя `to === duration`.
6. Нет ни одного внешнего URL, шрифта, изображения или mp3; в Network пусто, кроме самого документа.
7. Главный canvas создан с `{ alpha: false }`, фон закрашивается каждый кадр.
8. Все `save()` закрыты `restore()`, после glow и grade сброшены `globalAlpha`, `globalCompositeOperation`, `filter`, `shadowBlur`.
9. Замер `__draw` для худшего кадра укладывается в 12 мс при 60 fps и 25 мс при 30 fps.
10. Аудиодорожка длиной ровно `duration`, пик не выше 0.9, а при отсутствии ffmpeg файл пишет WebM через MediaRecorder без ошибок.
