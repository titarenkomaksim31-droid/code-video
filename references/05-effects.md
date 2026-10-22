# Эффекты code-video

Оценки — для Canvas2D, Chrome/Edge, 1920×1080, DPR 1. Бюджет `__draw`: 25 мс при 30 fps и 12 мс при 60 fps. На 30 fps: сцена 12–15 мс, эффекты 8–10 мс, суммарно 22–25 мс; на 60 fps: сцена 7–8 мс, эффекты 3–4 мс, суммарно 11–12 мс. Остаток кадра 33.3/16.7 мс уходит браузеру и захвату.

Порядок: сцена → glow/bloom → trails → CRT/glitch/аберрация → `grade()` → зерно → титры. Все canvas, спрайты и паттерны создаются до `window.__ready = true`; в `draw()` нет `createElement('canvas')` и `getImageData` на полном кадре. В сниппетах `W = 1920`, `H = 1080`, `FPS = window.__meta.fps`; объяви эти константы один раз.

## Glow

Два прохода на объект: широкий тусклый и узкий яркий. Оба рисуются за один кадр, без чтения пикселей.

| Проход | Радиус | Alpha | Режим | Задача |
|---|---|---|---|---|
| Широкий | blur 24–40 px | 0.15–0.30 | `screen` | Атмосфера, ореол вокруг источника |
| Узкий | blur 4–8 px | 0.60–0.90 | `lighter` | Яркое ядро и цвет |

- Статичную форму отрендерь один раз в два спрайта 512×512 — широкий с blur 24–40 и узкий с blur 4–8 — и дважды вызывай `drawImage`; это 0.1–0.4 мс на объект.
- Динамичную форму рисуй с `ctx.filter = 'blur(24px)'`, затем сбрось `filter = 'none'`; два прохода на 300×200 px стоят 0.8–2.5 мс.
- `shadowBlur` выгоден для 1–4 мелких объектов радиусом ≤24 px: одна растеризация и один blur. `shadowBlur` 32–60 на большой фигуре стоит 3–10 мс и пересчитывается каждый кадр — для неона это плохой выбор.
- `lighter` складывает каналы и быстро выбивает цвет в белый. Держи центр на 55–70% alpha, а широкий слой — на `screen`.
- Бюджет: ≤6 объектов, 12 вызовов (2 прохода), 1.5–3.5 мс; широких — не больше 6. Свечение только от ярких источников, не от тёмных контуров.

## Bloom в 2D

Порог по яркости считается на уменьшенной копии, поэтому цикл проходит 129 600 пикселей, а не 2.07 млн. Размытие — двумя `drawImage` через буфер 1/8; финальное сложение `screen`.

```js
const BW = 480, BH = 270; // 1/4 кадра
const bloomCanvas = document.createElement('canvas');
bloomCanvas.width = BW; bloomCanvas.height = BH;
const bloomCtx = bloomCanvas.getContext('2d', { willReadFrequently: true });

const blurCanvas = document.createElement('canvas');
blurCanvas.width = BW / 2; blurCanvas.height = BH / 2;
const blurCtx = blurCanvas.getContext('2d');

function bloom(ctx, src, strength = 0.35) {
  bloomCtx.globalCompositeOperation = 'copy';
  bloomCtx.drawImage(src, 0, 0, BW, BH);

  const img = bloomCtx.getImageData(0, 0, BW, BH);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
    const k = Math.min(1, Math.max(0, (l - 0.68) / 0.32));
    d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; d[i + 3] = 255;
  }
  bloomCtx.putImageData(img, 0, 0);

  // Размытие через drawImage: вниз до 1/8 и обратно.
  blurCtx.globalCompositeOperation = 'copy';
  blurCtx.imageSmoothingEnabled = true;
  blurCtx.drawImage(bloomCanvas, 0, 0, blurCanvas.width, blurCanvas.height);
  bloomCtx.globalCompositeOperation = 'copy';
  bloomCtx.imageSmoothingEnabled = true;
  bloomCtx.drawImage(blurCanvas, 0, 0, BW, BH);

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = strength;
  ctx.drawImage(bloomCanvas, 0, 0, W, H);
  ctx.restore();
}
```

Порог 0.62–0.75; strength 0.22–0.45 на тёмном фоне и 0.15–0.25 на светлом. Один проход 2.5–5 мс. На 60 fps используй буфер 1/8 (240×135) без промежуточного blur; порог и цикл остаются. Bloom не заменяет glow: он размывает уже нарисованные яркие пятна всего кадра.

## Зерно

Три тайла 256×256 создаются один раз с сидом. Каждый кадр выбирается тайл и целочисленный сдвиг; всё детерминировано от `t`, без `Math.random()` внутри `draw`.

```js
function hash32(n) {
  n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
  n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
  return (n ^ (n >>> 15)) >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGrain(seed) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  const rnd = mulberry32(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 48 + Math.floor(rnd() * 160);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

const GRAIN = [makeGrain(0xA11), makeGrain(0xB22), makeGrain(0xC33)];
const GRAIN_PATTERNS = [];

function drawGrain(ctx, t, alpha = 0.05) {
  const frame = Math.floor(t * FPS);
  const idx = hash32(frame) % 3;
  if (!GRAIN_PATTERNS[idx]) {
    GRAIN_PATTERNS[idx] = ctx.createPattern(GRAIN[idx], 'repeat');
  }
  const ox = hash32(frame + 0x9E3779B9) % 256;
  const oy = hash32(frame + 0x85EBCA6B) % 256;

  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha;
  ctx.translate(-ox, -oy);
  ctx.fillStyle = GRAIN_PATTERNS[idx];
  ctx.fillRect(0, 0, W + 256, H + 256);
  ctx.restore();
}
```

Alpha 0.04–0.06: на светлых сценах 0.04, на тёмных 0.05–0.06, для MP4 на тёмном фоне 0.055–0.06. Тайл не масштабируется: зерно должно быть 1 px. Сдвиг меняется каждый кадр, тайл тоже; повторяемость 3×256 px не видна. Стоимость 0.4–1.2 мс.

## Хроматическая аберрация

Полный разрыв 1–4 px, к краям больше. Работает на трёх временных буферах: сцена копируется в каждый, тонируется через `multiply` в красный, зелёный и синий каналы, затем каналы складываются `lighter` на чёрном.

- `k = (d / 2) / (0.5 * Math.hypot(W, H))`, где `d` — полный разрыв 1–4 px. Для 4 px `k = 0.00182`.
- Красный канал масштабируется вокруг центра на `1 + k`, синий на `1 - k`, зелёный остаётся 1. В центре сдвиг 0, на краю `d/2` для каждого канала.
- Три копии 1920×1080 и три финальных `drawImage` стоят 4–9 мс; включай на 1–4 кадра глитча, не постоянно.
- Для одного спрайта или заголовка дешевле три цветных копии со сдвигом ±1–2 px и `screen`; это не поканальное разделение, но на мелком объекте неотличимо.
- Не применяй aberration к тексту, который должен читаться: 1 px разрыва уже снижает контраст мелких штрихов.

## Частицы

Пул фиксированного размера; позиция и alpha вычисляются из `t`, а не накапливаются. Спрайт 64×64 создаётся один раз, пул инициализируется сидом. 500–2000 частиц при 30 fps — рабочий диапазон; 2000 стоит 4–8 мс, на 60 fps оставь 500–900.

```js
const COUNT = 1400;
const SPARK = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(244,247,255,1)');
  grd.addColorStop(0.25, 'rgba(79,240,255,0.85)');
  grd.addColorStop(1, 'rgba(79,240,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return c;
})();

const rnd = mulberry32(0xC0FFEE);
const P = Array.from({ length: COUNT }, () => {
  const life = 1.2 + rnd() * 2.8;
  return {
    x: rnd() * W, y: 220 + rnd() * (H - 220),
    vx: -40 + rnd() * 80, vy: -120 - rnd() * 260,
    g: 50 + rnd() * 120, size: 6 + rnd() * 20,
    alpha: 0.12 + rnd() * 0.5, life, phase: rnd() * life,
  };
});

function drawParticles(ctx, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < COUNT; i++) {
    const p = P[i];
    const age = (t + p.phase) % p.life;
    const a = Math.sin(Math.PI * (age / p.life));
    const x = p.x + p.vx * age;
    const y = p.y + p.vy * age + 0.5 * p.g * age * age;
    if (a <= 0.01 || x < -64 || x > W + 64 || y < -64 || y > H + 64) continue;
    const s = p.size * (1 - 0.35 * (age / p.life));
    ctx.globalAlpha = p.alpha * a;
    ctx.drawImage(SPARK, x - s / 2, y - s / 2, s, s);
  }
  ctx.restore();
}
```

Alpha угасает по `sin(πk)`, поэтому частицы не мигают на респавне. `globalAlpha` меняется на каждой частице; `save()` один на весь слой. Не ставь `shadowBlur` на 1400 частиц. Аддитивный слой на светлом фоне сначала затемняй или уменьшай alpha до 0.1–0.25, иначе получишь белую засветку.

## Огонь и дым

Три слоя: задний дым, тело пламени, ядро и искры. Пламя — 12–24 билборда с общей палитрой; дым — 4–8 больших мягких пятен, нарисованных до огня.

| Слой | Composite | Alpha | Размер | Движение |
|---|---|---|---|---|
| Дым | `source-over` | 0.06–0.16 | 300–700 px | вверх 40–90 px/c, низкая частота турбулентности |
| Пламя | `lighter` | 0.18–0.35 | 80–240 px | вверх 120–260 px/c, ramp от ядра к краю |
| Ядро и искры | `lighter` | 0.60–1.00 | 10–70 px | вверх 260–520 px/c, короткая жизнь |

```js
const FIRE_RAMP = [
  [0.00, 'rgba(255,250,235,1)'],
  [0.20, 'rgba(255,209,102,1)'],
  [0.45, 'rgba(255,122,24,0.90)'],
  [0.70, 'rgba(255,63,50,0.65)'],
  [0.88, 'rgba(92,18,10,0.35)'],
  [1.00, 'rgba(5,6,13,0)'],
];

function turbulence(x, y, t) {
  return Math.sin(x * 0.011 + t * 1.7)
    + 0.5 * Math.sin(y * 0.019 - t * 2.3)
    + 0.25 * Math.sin((x + y) * 0.031 + t * 3.1);
}
```

`turbulence` даёт диапазон ±1.75; умножай на 28–70 px. Верхние билборды смещаются сильнее и уменьшаются, палитра берётся из `FIRE_RAMP` как `createRadialGradient` с центром в точке билборда. Ядро рисуется отдельным белым эллипсом 40–110 px. Никакого покадрового шума на весь экран: шумовые текстуры готовятся один раз, огонь двигается синусами. Стоимость 3–7 мс.

## CRT

Сканлайны, phosphor-маска и бегущая полоса рисуются паттернами, а barrel — вертикальными срезами 8 px в отдельный буфер.

- Сканлайны: период 2–4 px, тёмная линия 1–2 px, alpha 0.08–0.18. Паттерн высотой 4 px создаётся один раз и заливается `fillRect` целиком.
- Barrel: `drawImage` по 8 px; каждый столбец растягивается по вертикали на `1 + 0.025 * nx²`, где `nx` — координата от -1 до 1. Это даёт выпуклость 1.5–2.5% на краях и 0 в центре.
- Phosphor-маска: триада R/G/B шириной 3 px, alpha 0.12–0.20, `overlay`; работает только при 1:1, иначе начинается муар.
- Бегущая полоса: высота 80–180 px, `screen`, alpha 0.06–0.12, скорость 0.20–0.35 высоты экрана в секунду, координата `((t * 0.22) % 1) * H`.
- Виньетка CRT жёстче обычной: 40–70% на краях, затемнение начинается с 35–45% радиуса.

```js
function barrel(ctx, src, amount = 0.025) {
  const strip = 8;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += strip) {
    const nx = (x + strip / 2 - W / 2) / (W / 2);
    const dh = H * (1 + amount * nx * nx);
    ctx.drawImage(src, x, 0, strip, H, x, (H - dh) / 2, strip, dh);
  }
}
```

`src` — отдельная копия кадра: в один canvas читать и писать столбцы нельзя. Один проход 8 px — 240 `drawImage`, 2–5 мс вместе с маской. На 60 fps сначала уменьшай CRT-слой вдвое или делай strip 16 px.

## Трейлы и фидбек-буфер

Затухание: нарисуй предыдущий кадр с alpha 0.85, затем текущую сцену. Яркость следа через `n` кадров равна `0.85^n`: 50% между 4-м и 5-м кадром (≈143–167 мс), 10% к 15-му (≈500 мс). Рабочий диапазон 0.82–0.90 при 30 fps; на 60 fps для той же длительности следа бери 0.92–0.93.

```js
const history = document.createElement('canvas');
history.width = W; history.height = H;
const hctx = history.getContext('2d');

function drawTrail(ctx, t) {
  hctx.globalCompositeOperation = 'copy';
  hctx.drawImage(ctx.canvas, 0, 0); // предыдущий кадр

  ctx.fillStyle = '#05060d';
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.85;
  ctx.drawImage(history, 0, 0);
  ctx.globalAlpha = 1;
  drawMovingLayer(ctx, t); // только движущийся слой
}
```

Прямой `ctx.drawImage(ctx.canvas, 0, 0)` в Chrome допустим, но копия в отдельный буфер предсказуема и не зависит от чтения-записи одного источника.

Трейл — единственный эффект с памятью. В строгом контракте `__draw(t)` он зависит от предыдущих кадров и ломает произвольный доступ. Используй его только при последовательном рендере с обязательным сбросом буфера на `t = 0`; чистый вариант — 4–6 «призраков» объекта, нарисованных при `t - i / 30` с alpha `0.65^i`.

## Глитч и displacement

Событие длится 1–3 кадра, повторяется не чаще раза в 1.5–3 c. Все параметры берутся из `hash32` по номеру кадра, поэтому рендер воспроизводим.

- Полосы: 1–4 полосы высотой 8–90 px, сдвиг ±12–64 px, копия кадра-источника, полосы рисуются поверх базы.
- Блочный сдвиг: сетка 3–6×2–4, блоки 120–360 px, смещение ±32–160 px по x и ±8–32 px по y; не больше 12 блоков на кадр.
- RGB split: 1–4 px полного разрыва, на краях больше; 4 px — только на 1–2 кадра.
- «Снег»: на буфере 1/4 зажги 2–4% пикселей белым на 1–3 px, alpha 0.08–0.16; полный кадр не трогай.
- Затемнение: один чёрный кадр на монтажном акценте дешевле и читается сильнее, чем 10 полос.

```js
function glitchBands(ctx, snapshot, t) {
  const frame = Math.floor(t * FPS);
  const count = 2 + hash32(frame * 17 + 3) % 3;
  for (let i = 0; i < count; i++) {
    const h = 8 + hash32(frame * 31 + i * 7) % 82;
    const y = hash32(frame * 43 + i * 11) % (H - h);
    const dx = (hash32(frame * 59 + i * 13) % 129) - 64;
    ctx.drawImage(snapshot, 0, y, W, h, dx, y, W, h);
  }
}
```

Включай функцию только в окне-условии: например, `(Math.floor(t * 10) * 977) % 100 < 3` даёт короткое событие в среднем раз в 3.3 c. Стоимость полос 1–3 мс, снега 1–3 мс, полного RGB split 4–9 мс. Не смешивай в одном кадре снег, блочный сдвиг и полный split: эффект станет нечитаемым.

## Blur

- `ctx.filter = 'blur(16px)'`: Chrome поддерживает; сбрасывай в `'none'`, иначе фильтр унаследуют следующие объекты. Полный кадр 16 px — 8–20 мс, только для пост-обработки или одного статичного слоя.
- Downscale-размытие: 1/4 → `drawImage` с `imageSmoothingEnabled = true`, затем обратно. Один шаг даёт радиус около 4 px, 1/8 — 8–12 px; стоимость 1–3 мс. Не делай больше двух шагов, получишь видимые квадраты.
- Motion blur: 3–7 копий движущегося объекта вдоль вектора, шаг 4–24 px, alpha 0.12–0.25; фон не размывается. Стоимость 2–5 мс на объект.
- CSS `filter` на самом `<canvas>` не попадает в `captureStream()` как пиксели; для MediaRecorder и ffmpeg эффект должен быть нарисован внутри canvas.
- Не блури полный кадр на каждом кадре при 30 fps, если уже включены bloom, CRT и зерно: бюджет закончится на одной сцене.

## Стоимость эффектов

Порядок величин на кадр 1920×1080, Chrome, без учёта захвата. Складывай только включённые эффекты: при 30 fps их сумма — 8–10 мс, при 60 fps — 3–4 мс.

| Эффект | В реальном времени | мс/кадр | Что включать только в пост-обработке |
|---|---|---|---|
| Glow, 2 прохода, 6 объектов | да | 1.5–4 | Свечение на 20+ объектах |
| Bloom 1/4 с порогом | да | 2.5–5 | Три и более bloom-уровня |
| Зерно, 3 тайла | да | 0.4–1.2 | Пересчёт зерна на полном разрешении |
| Сканлайны и phosphor-маска | да | 0.5–1.5 | Маска с периодами меньше 3 px |
| Chromatic aberration, 3 буфера | только глитч | 4–9 | Постоянный split всего кадра |
| Частицы 1000 / 2000 | да | 2–5 / 4–8 | 5000+ с `shadowBlur` |
| Огонь, 3 слоя | да | 3–7 | Покадровый шумовый огонь |
| CRT barrel, strip 8 px | да | 2–5 | strip 2 px или 4K-срезы |
| Трейл 0.85 | только последовательный рендер | 0.4–1.2 | Многокадровое накопление 20+ кадров |
| Глитч-полосы / снег | да | 1–3 / 1–3 | Полный RGB split в каждом кадре |
| `ctx.filter` blur 16 px, fullscreen | нет при 60 fps | 8–20 | Motion blur всей сцены |
| Downscale blur 1/4 | да | 1–3 | 3+ шагов размытия |
| LGG pixel LUT, полный кадр | нет | 12–30 | Да, вместе с оптическим flow |
| `getImageData` на полном кадре | нет | 15–35 | Да, только финальный проход |
