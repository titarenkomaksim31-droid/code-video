# 06. Типографика: системный шрифт, ручной трекинг

Текст в code-video — часть кадра, а не HTML-вёрстка. Его рисует Canvas 2D в координатах 1920×1080, с DPR=1; CSS масштабирует холст. Шрифт берётся из системы, кегль и межбуквенное расстояние считаются в пикселях, переносы задаются вручную. Ни `@font-face`, ни внешних файлов.

## 6.1 Шрифты

Системные семейства различаются метриками; гарантированы только generic-семейства, остальное — резервы. Ширину измеряй после установки `ctx.font`: подмена шрифта меняет строку на 5–15%.

| ОС | Sans по умолчанию | Кириллические резервы | Mono |
|---|---|---|---|
| Windows 10/11 | Segoe UI | Arial, Times New Roman, Georgia, Consolas | Consolas |
| macOS | SF Pro через `system-ui` | Helvetica Neue, Arial, Georgia | SF Mono, Menlo |
| Linux | DejaVu Sans или Liberation Sans | DejaVu Sans, Liberation Sans | DejaVu Sans Mono |

Рабочие стеки:

```js
const SANS = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, "Liberation Sans", sans-serif';
const MONO = 'Consolas, "SF Mono", "Cascadia Mono", "DejaVu Sans Mono", monospace';
const DISPLAY = SANS;                       // тот же стек, вес 900
```

- `system-ui` и `sans-serif` есть всегда; «Inter», «Roboto», «Montserrat» — нет. Если система не нашла первый шрифт, Chrome берёт следующий из стека и не сообщает об этом.
- Вес 900 — титры и один смысловой акцент в кадре. Вес 600 — подзаголовок, 400–600 — подписи и HUD. Тонкие 100–300 после H.264 распадаются на 1 px и исчезают.
- Если в системе нет 900, Canvas синтезирует жирность из 700 или берёт ближайший вес. Компенсируй кеглем, а не обводкой: `strokeText` на 2–4 px утолщает буквы и забивает просветы.
- `ctx.font` — часть состояния: `save()` запоминает его, `restore()` возвращает прежний. Ставь его непосредственно перед `measureText()` и `fillText()`.
- Не грузи webfont в один HTML: кириллический WOFF2 на один вес — 25–60 КБ, base64 добавляет 33%; четыре веса дают 130–320 КБ, `FontFace.load()` задерживает первый кадр, а лицензия шрифта становится частью поставки. Системный стек даёт 0 КБ и старт без ожидания.

## 6.2 Размеры для 1920×1080

| Роль | Кегль, px | Вес | Трекинг | Высота строки | Практический предел |
|---|---:|---:|---:|---:|---|
| Титул | 140–220 | 900 | +6…+14% (900: 6–9) | 1.00–1.10 | 8–16 капс-знаков в строке |
| Подзаголовок | 30–40 | 500–600 | 0…+2% | 1.25 | 20–40 символов |
| Подпись, субтитр | 22–26 | 400–600 | +8…+12% | 1.35 | 20–40 символов |
| HUD, метка | 16–20 | 500–600 | +10…+14% | 1.20 | 3–12 символов |
| Минимум | 16 | — | — | — | только служебный HUD |

Формулы от высоты кадра: титул `0.1296–0.2037 H` (140–220 px), подзаголовок `0.0278–0.0370 H` (30–40), подпись `0.0204–0.0241 H` (22–26), HUD `0.0148–0.0185 H` (16–20). Минимум 16 px = `0.0148 H`. При 1080 диапазоны дают значения таблицы с округлением.

```js
const W = 1920, H = 1080;
const TITLE = Math.round(H * 0.15);         // 162 px
const SUB = Math.round(H * 0.033);          // 36 px
const CAP = Math.round(H * 0.022);          // 24 px
const HUD = Math.round(H * 0.017);          // 18 px
```

- 16 px читается только как HUD с расстояния 1 м; всё, что зритель обязан прочитать с одного просмотра, — 22 px и выше.
- Две строки титула по 200 px при line-height 1.05 занимают 420 px — половину высоты. Оставляй под них 2–3 пустых трека.
- Длинный заголовок не уменьшай ниже 140 px: переноси на вторую строку вручную и проверяй ширину `fitText` по safe area 1728 px.

## 6.3 Трекинг

`ctx.letterSpacing` поддерживается не везде и не наследуется как обычный CSS. Ручной трекинг работает в Chrome/Edge одинаково и позволяет центрировать строку по фактической ширине.

Для строки из `n` глифов с ширинами `w_i` и трекингом `tr`:

```text
x_i = startX + Σ(j < i)(w_j + tr)
width = Σ w_j + tr × (n - 1)
tr = size × em
```

Последняя литера не получает трекинг. Если добавить его после последней, центр сместится на `tr/2`; на титуле 180 px с `+0.10em` это 9 px.

| Случай | em | Пример |
|---|---:|---|
| Капс, вес 900 | +0.06…+0.09 | 180 px → 10.8–16.2 px |
| Капс, вес 600 | +0.09…+0.14 | 180 px → 16.2–25.2 px |
| Строчный заголовок | −0.01…−0.02 | 220 px → −2.2…−4.4 px |
| Подпись, субтитр | +0.08…+0.12 | 26 px → 2.1–3.1 px |

```js
function trackedWidth(ctx, text, size, em, weight = 900, family = SANS) {
  const chars = [...text];
  ctx.save();
  ctx.font = `${weight} ${size}px ${family}`;
  let w = 0;
  for (const ch of chars) w += ctx.measureText(ch).width;
  w += size * em * Math.max(0, chars.length - 1);
  ctx.restore();
  return w;
}

const w = trackedWidth(ctx, 'СИГНАЛ', 180, 0.10);   // 900, SANS
```

Ручной замер по глифам теряет кернинг пар. Для титров это незаметно, для абзаца — нет: длинный текст рисуй одним `fillText`, без покадрового трекинга. Для капса с 900 бери нижнюю границу диапазона: жирные буквы уже широкие, +14% разваливает слово.

## 6.4 Приёмы с кодом

Общие хелперы для сниппетов:

```js
const INK = '#f4f7ff', CYAN = '#4ff0ff', MAG = '#ff3fa4';
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const lerp = (a, b, p) => a + (b - a) * p;
const out3 = p => 1 - Math.pow(1 - p, 3);
```

### Per-letter stagger

```js
drawTracked(ctx, 'СИГНАЛ', 960, 560, {
  size: 180, weight: 900, tracking: 0.10,
  p: clamp01((t - 0.2) / 0.7), stagger: 0.05, rise: 0.25,
});
```

Каждая литера входит на 0.05 прогресса позже предыдущей; при 18 литерах последняя стартует на 0.85. Для 4–6 букв ставь 0.07–0.09, для строки 20+ — 0.02–0.03.

### Mask reveal через clip

```js
ctx.save();
ctx.beginPath();
ctx.rect(340, 380, 1240 * out3(p), 260);
ctx.clip();
ctx.font = `900 180px ${SANS}`;
ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
ctx.fillStyle = INK; ctx.fillText('СИГНАЛ', 960, 520);
ctx.restore();
```

Маска идёт слева направо. Ширина 1240 px и x=340 рассчитаны на строку до 1200 px; при другой ширине бери `trackedWidth` и добавь 40 px запаса. `clip` не смягчает край — для мягкой кромки нужен градиент в offscreen.

### Baseline shift

```js
const chars = [...'ТИШИНА'];
ctx.font = `900 120px ${SANS}`;
ctx.textAlign = 'center'; ctx.fillStyle = INK;
for (let i = 0; i < chars.length; i++) {
  const dy = Math.sin(t * 3 + i * 0.9) * 14;
  ctx.fillText(chars[i], 560 + i * 140, 600 + dy);
}
```

Амплитуда 14 px при 120 px — 12% кегля; больше 20% буквы начинают скакать. Сдвиг по `sin(t)` — чистая функция времени, допустим в `__draw`.

### Scale punch

```js
const s = 1 + 0.12 * Math.sin(Math.PI * clamp01(p / 0.18));
ctx.save();
ctx.translate(960, 560); ctx.scale(s, s);
ctx.font = `900 200px ${SANS}`;
ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
ctx.fillText('СТОП', 0, 0);
ctx.restore();
```

Пик +12% за 0.18 прогресса, то есть 5–6 кадров при 30 fps. Точка масштабирования — центр строки; `textAlign` до `translate` не спасёт от уезжания.

### Хроматическая аберрация

```js
const d = 12 * Math.sin(Math.PI * p);
ctx.font = `900 180px ${SANS}`;
ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
ctx.globalCompositeOperation = 'screen';
ctx.fillStyle = CYAN; ctx.fillText('СИГНАЛ', 960 - d, 540);
ctx.fillStyle = MAG; ctx.fillText('СИГНАЛ', 960 + d, 540);
ctx.globalCompositeOperation = 'source-over';
ctx.fillStyle = INK; ctx.fillText('СИГНАЛ', 960, 540);
```

Смещение 0→12→0 px. `screen` складывает каналы без грязного коричневого; белый верхний слой возвращает читаемость. На светлом фоне приём не работает.

### Typewriter

```js
const chars = [...'СИГНАЛ'];
const shown = chars.slice(0, Math.ceil(clamp01(p) * chars.length)).join('');
ctx.font = `600 120px ${SANS}`;
ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = INK;
ctx.fillText(shown, 520, 600);
const cx = 520 + ctx.measureText(shown).width + 8;
if (Math.floor(t * 6) % 2 === 0) ctx.fillRect(cx, 470, 12, 140);
```

Курсор ставится по ширине уже набранной строки, а не по числу символов: у пропорционального шрифта «Ш» шире «I». Символы не должны «прыгать» — при наборе переноси только курсор.

### Tracking-in

```js
drawTracked(ctx, 'СИГНАЛ', 960, 560, {
  size: 180, weight: 900, p: 1,
  tracking: lerp(0.26, 0.08, out3(p)),       // p — прогресс приёма
});
```

Сжатие идёт от 0.26em к 0.08em, строка центрируется на каждом кадре. Разница 0.18em при 180 px — 32.4 px суммарно; для 6 букв это 162 px хода. Не совмещай с per-letter stagger: два движения спорят за одно слово.

## 6.5 Русский текст

- Строка подписи — 20–40 символов. При 26 px это 350–700 px; при 40 px — 550–1100 px, то есть 20–64% safe width 1728.
- Переноси вручную массивом строк. На последней строке — минимум два слова и 8 символов.

```js
const lines = [
  'Ролик собирается из кода:',
  'картинки, шрифты и mp3 — всё в JS.',
];
```

- «ё» пиши всегда: «всё», «ещё», «тёмный». Не заменяй на «е»; ширина и смысл меняются.
- Длинное тире — `—` с пробелами: `код — это кадр`. Дефис только в составных: `code-video`, `интернет-магазин`. Диапазоны — короткое тире: `20–90 с`.
- Кавычки — ёлочки: `«сигнал»`. Вложенные — лапки: `«кнопка „пуск“»`. Прямые `"..."` в кириллице читаются как машинописный черновик.
- Предлог не остаётся в конце строки. Если текст уходит в DOM/HTML, склеивай его с существительным через NBSP:

```js
const NOBREAK = /(?<=^|\s)(в|во|без|безо|на|по|с|со|к|ко|из|за|от|до|у|о|об|при|про|над|надо|под|подо|пред|перед|через|меж|между|и|а|но|не|ни|для)\s/giu;
const glue = s => s.replace(NOBREAK, '$1\u00A0');
glue('Ролик из кода и в дом');              // «из», «и», «в» держатся за слова
```

- Не начинай строку с тире, союза или предлога; в Canvas перенос делает только автор, автоматического переноса нет. Проверяй ширину каждой строки через `measureText`.

## 6.6 Подписи и субтитры

Safe area 5%: `x` от 96 до 1824, `y` от 54 до 1026. Нижняя граница субтитра — 984 px, чтобы плашка не липла к краю. Высота строки строго 1.35: при 26 px это 35 px, две строки — 70 px.

Скорость чтения 15–20 символов в секунду. Планируй 18 симв/с, проверяй на 20: строка 40 символов держится 2.0–2.7 с. Таблица ниже — чистое время; нижний порог показа 1.2 с, даже для «ОК».

| Символов | 15 симв/с | 20 симв/с | 30 fps, кадров |
|---:|---:|---:|---:|
| 20 | 1.33 с | 1.00 с | 30–40 |
| 40 | 2.67 с | 2.00 с | 60–80 |
| 80 (2 строки) | 5.33 с | 4.00 с | 120–160 |

```js
const size = 26, lh = Math.round(size * 1.35);   // 35
const line = 'Один кадр — одна функция времени';
ctx.font = `500 ${size}px ${SANS}`;
const tw = ctx.measureText(line).width, padX = 24, padY = 14, bottom = 984;
const top = bottom - lh - padY * 2;
ctx.fillStyle = 'rgba(5,6,13,.52)';              // 52% плашки
ctx.fillRect(960 - tw / 2 - padX, top, tw + padX * 2, lh + padY * 2);
ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
ctx.fillText(line, 960, top + padY + lh / 2);
```

- Плашка 40–60% непрозрачности: 40% на контрастном фоне, 55–60% на светлом/шумном. Ниже 40% текст теряется, выше 60% плашка становится прямоугольником.
- Подпись не участвует в переходе: она появляется после `apply` и живёт 12+ кадров. Внутри whip/zoom/glitch подпись не читается.
- Не ставь подпись на нижние 96 px, если там прогресс-бар или логотип: они должны делить safe area, а не перекрывать друг друга.

## 6.7 drawTracked и fitText

`drawTracked` рисует одну строку по глифам, центрирует по фактической ширине и умеет per-letter stagger, typewriter и tracking-in. Для длинного абзаца вызывай обычный `fillText` с ручными переносами.

```js
function drawTracked(ctx, text, x, y, o = {}) {
  const size = o.size ?? 64, weight = o.weight ?? 600, family = o.family ?? SANS;
  const color = o.color ?? INK, align = o.align ?? 'center';
  const p = clamp01(o.p ?? 1), stagger = o.stagger ?? 0.035;
  const mode = o.mode ?? 'stagger', chars = [...text], n = chars.length;
  ctx.save();
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = o.baseline ?? 'alphabetic';
  ctx.fillStyle = color;

  const from = o.fromTracking ?? o.tracking ?? 0;
  const tr = lerp(from, o.tracking ?? 0, out3(p)) * size;
  const widths = chars.map(ch => ctx.measureText(ch).width);
  const total = widths.reduce((s, w) => s + w, 0) + tr * Math.max(0, n - 1);
  let cursor = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const st = Math.min(stagger, 0.85 / Math.max(1, n - 1));
  const span = Math.max(0.15, 1 - st * Math.max(0, n - 1));

  for (let i = 0; i < n; i++) {
    const local = clamp01((p - i * st) / span);
    const alpha = mode === 'type' ? (local > 0 ? 1 : 0) : local;
    const rise = mode === 'type' ? 0 : (1 - out3(local)) * size * (o.rise ?? 0.25);
    ctx.globalAlpha = (o.alpha ?? 1) * alpha;
    ctx.fillText(chars[i], cursor, y + rise);
    cursor += widths[i] + tr;
  }
  ctx.restore();
}
```

`fitText` подбирает максимальный кегль, при котором строка с заданным трекингом влезает в `maxWidth`. Возвращает целое число; если даже `min` не влезает, вернёт `min` — тогда нужен перенос.

```js
function fitText(ctx, text, maxWidth, o = {}) {
  const weight = o.weight ?? 900, family = o.family ?? SANS;
  const tracking = o.tracking ?? 0, chars = [...text];
  const gaps = Math.max(0, chars.length - 1);
  let lo = o.min ?? 16, hi = o.max ?? 220;
  ctx.save();
  for (let i = 0; i < 18; i++) {
    const size = (lo + hi) / 2;
    ctx.font = `${weight} ${size}px ${family}`;
    let w = 0;
    for (const ch of chars) w += ctx.measureText(ch).width;
    w += size * tracking * gaps;
    if (w <= maxWidth) lo = size; else hi = size;
  }
  ctx.restore();
  return Math.floor(lo);
}

const titleSize = fitText(ctx, 'СИГНАЛ', 1728, {
  min: 140, max: 220, weight: 900, tracking: 0.10,
});
drawTracked(ctx, 'СИГНАЛ', 960, 560, {
  size: titleSize, weight: 900, tracking: 0.10,
  p: clamp01(t / 0.8), stagger: 0.05, rise: 0.25,
});
```

`drawTracked` теряет кернинг, потому что рисует по одному глифу. На титрах это маскирует трекинг; на подписи из 40 символов используй `fillText`. `fitText` тоже меряет по глифам, поэтому его результат совпадает с `drawTracked` до пикселя, но не с обычным `fillText`.
