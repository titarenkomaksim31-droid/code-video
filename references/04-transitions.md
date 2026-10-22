# 04. Переходы: событие на бите

Переход — смена состояния кадра, а не ещё одна анимация внутри сцены. При 120 BPM beat = 0.5 с, bar = 2 с; на 30 fps это 15 и 60 кадров. Переход занимает 6–12 кадров (0.20–0.40 с) и привязан к beat. Всё длиннее 12 кадров — уже сцена.

## 4.1 Принципы

- **Сетка.** Cut начинается на beat. Dip, zoom, whip и остальные с импактом заканчиваются на beat: `t0 = beat - D`. Райзер достигает пика на beat, когда p=1 и B занял кадр.
- **Длина.** 6 кадров = 0.200 с, 8 = 0.267, 10 = 0.333, 12 = 0.400 при 30 fps. На 60 fps это 12, 16, 20, 24 кадра: 6 кадров при 60 fps равны 0.1 с и пролетают незаметно.
- **Два готовых кадра.** `a` — полный кадр A, `b` — полный кадр B, оба уже отрисованы в offscreen 1920×1080. Композитор не вызывает функции сцен и не знает их устройства.
- **Чистота.** `p = clamp01((t - t0) / D)`. Внутри нет `Date.now()`, `performance.now()` и `Math.random()` без сида: искры и срезы — хеш от `p` и индекса.
- **Края.** `apply(..., 0)` даёт ровно A, `apply(..., 1)` — ровно B. Проверяй p = 0, 0.25, 0.5, 0.75, 1 на вспышку и провал.
- **Дозировка.** Один переход на 8 битов: при 20 с (40 битов) максимум 5. На каждом резе переход превращает монтаж в аттракцион.
- **Звук.** Без звукового события смена читается как сбой. Минимум одно: райзер, импакт или обратный вдох.

```js
const FPS = 30, BEAT = 0.5;               // 120 BPM
const D = 8 / FPS;                        // 0.267 c
const t0 = BEAT - D;                      // конец перехода — на beat
const p = Math.min(1, Math.max(0, (t - t0) / D));
```

Звуковые рецепты: райзер 0.6–1.0 с, тон 110→880 Гц через bandpass Q=4, gain 0.0001→0.16, обрыв за 20 мс до beat; импакт 120→42 Гц за 0.22 с, gain 0.5 (0.25 при плотном пэде) и хвост 0.30 с; обратный вдох 0.35–0.60 с, шум 300→3500 Гц; тишина 1–2 кадра перед импактом. Пик мастера ≤ −1 dB.

## 4.2 Каталог переходов

Сниппеты показывают суть; боевые функции `(ctx, a, b, p)` — в реестре 4.5. Кадры каталога — для 30 fps; при 60 fps удвой их, чтобы сохранить секунды.

### Cut on beat — 1 кадр
```js
// p не нужен: решай по t < cutT
ctx.drawImage(t < cutT ? a : b, 0, 0, 1920, 1080);
```
Время: 1 кадр, 0.033 с. Сцены: готовые кадры, offscreen не обязателен. Звук: сухой транзиент или удар на beat; если A громкая — 1 кадр тишины. Камера должна сохранять направление движения.

### Dip to black — 8–10 кадров
```js
const k = 1 - Math.abs(2 * p - 1);        // 0 → 1 → 0
ctx.fillStyle = `rgba(5,6,13,${k})`;
ctx.fillRect(0, 0, 1920, 1080);
```
Время: 8–10 кадров, чёрный держится 1–2 кадра. Сцены: оба кадра в offscreen, в середине нужен фон `#05060d`, не прозрачность. Звук: вдох 0.4 с, 1 кадр тишины, низкий импакт на выходе.

### Whip pan — 8–12 кадров
```js
const e = p * p * (3 - 2 * p);
ctx.drawImage(a, -e * W, 0, W, H);
ctx.drawImage(b, (1 - e) * W, 0, W, H);
```
Время: 8–12 кадров. Сцены: оба кадра в offscreen; движение в A и B должно идти в одну сторону. Звук: шум через bandpass 300→4000 Гц за 0.35 с и импакт в конце.

### Zoom blur — 10–12 кадров
```js
const blur = 12 * Math.sin(Math.PI * p);  // 0 → 12 → 0 px
ctx.filter = `blur(${blur.toFixed(1)}px)`;
scaled(ctx, a, 1 + 0.35 * p, 1);
scaled(ctx, b, 1.25 - 0.25 * p, p);
ctx.filter = 'none';
```
Время: 10–12 кадров. Сцены: оба кадра в offscreen с заполненным фоном. Звук: саб 60→35 Гц и короткий райзер; без импакта zoom читается как расфокус. На статике не применять: blur неподвижного кадра выглядит дефектом оптики.

### Luma wipe — 8–12 кадров
```js
const edge = p * 1.2 - 0.1;               // -0.1 → 1.1
const g = mx.createLinearGradient(0, 0, W, H);
g.addColorStop(0, '#000');
g.addColorStop(clamp01(edge - 0.08), '#000');
g.addColorStop(clamp01(edge + 0.08), '#0000');
```
Время: 8–12 кадров. Сцены: оба кадра в offscreen плюс третий под маску. Звук: фильтр-свип по кромке и ping, когда кромка проходит центр.

### Iris — 10–12 кадров
```js
const r = Math.hypot(W, H) * 0.55 * smooth(p);
ctx.beginPath();
ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
ctx.clip();
```
Время: 10–12 кадров. Сцены: оба кадра в offscreen; центр iris держи на смысловом объекте B. Звук: закрывающийся фильтр на A и щелчок при раскрытии. Не совмещать с резким движением камеры.

### Glitch / RGB split — 6–8 кадров
```js
const base = p < 0.5 ? a : b;
const k = Math.sin(Math.PI * p);
tint(ctx, base, '#4ff0ff', -22 * k, 0.45 * k);
tint(ctx, base, '#ff3fa4', 22 * k, 0.45 * k);
```
Время: 6–8 кадров, 0.20–0.27 с. Сцены: оба кадра в offscreen и scratch под каналы. Звук: 3–4 шумовых всплеска по 30–40 мс на 32-х (0.0625 с), без райзера. Дольше 8 кадров — сломанный рендер, не глитч.

### Burn — 10–12 кадров
```js
const x = W * (p * 1.2 - 0.1);            // фронт огня
const g = ctx.createLinearGradient(x - 240, 0, x + 240, 0);
g.addColorStop(0.48, 'rgba(255,209,102,0)');
g.addColorStop(0.52, 'rgba(255,209,102,.9)');
ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
```
Время: 10–12 кадров. Сцены: оба кадра в offscreen; фронт и искры аддитивные. Звук: треск 0.3–0.5 с и низкий бум на p≈0.5. Огонь без тепла в звуке — просто оранжевая заливка.

### Shape mask — 8–12 кадров
```js
const r = 1520 * smooth(p);               // ромб закрывает углы
ctx.beginPath();
ctx.moveTo(W / 2, H / 2 - r);
ctx.lineTo(W / 2 + r, H / 2);
ctx.lineTo(W / 2, H / 2 + r);
ctx.lineTo(W / 2 - r, H / 2);
ctx.closePath(); ctx.clip();
```
Время: 8–12 кадров. Сцены: оба кадра в offscreen; маска через clip. Звук: 4–8 тиков по шагам маски, последний — на полном раскрытии. Форма повторяет мотив ролика.

### Push / slide — 8–12 кадров
```js
const e = smooth(p);
ctx.drawImage(a, -e * W, 0, W, H);
ctx.drawImage(b, (1 - e) * W, 0, W, H);
```
Время: 8–12 кадров. Сцены: оба кадра в offscreen; направление совпадает с движением внутри сцен. Звук: низкий whoosh и импакт на посадке. Без смаза push дешевле whip и точнее держит геометрию.

### Light leak — 6–10 кадров
```js
const k = Math.sin(Math.PI * p);
ctx.globalCompositeOperation = 'screen';
ctx.fillStyle = `rgba(255,209,102,${0.45 * k})`;
ctx.fillRect(W * p, 0, W * 0.2, H);
```
Время: 6–10 кадров. Сцены: оба кадра в offscreen для crossfade; сам leak — один градиент. Звук: мягкий обратный swell без импакта. Держи opacity ниже 50%, иначе leak становится главным объектом.

### Match cut — 1 кадр
```js
// объект A и объект B совпадают по x, y, размеру и направлению
ctx.drawImage(t < cutT ? a : b, 0, 0, 1920, 1080);
```
Время: 1 кадр. Сцены: геометрия совпадает до пикселя; offscreen нужен для сравнения кадров. Звук: продолжение мотива без whoosh. Это не эффект, а подготовка двух сцен.

## 4.3 Когда какой переход

| Тон | Переходы | Длина при 30 fps | Звук |
|---|---|---|---|
| Энергия, дроп | cut, whip, zoom, glitch, push | 6–12 (cut — 1) | транзиент + импакт, райзер 0.6–1.0 с |
| Покой, дыхание | dip, luma, light leak, iris | 8–12 | обратный swell −18 дБ, без удара |
| Драма, акцент | burn, shape, iris, dip | 10–12 | 2 кадра тишины + саб-импакт |
| Конец | dip to black, leak в чёрный | 12 | вдох 0.8 с, без импакта, хвост 0.5 с |

Cut на beat — база. Остальные переходы ставятся там, где меняется смысл: раздел, материал, финал. Между двумя кадрами одной функции достаточно cut.

## 4.4 Композиция

- **Один владелец кадра.** В `[t0, t0 + D]` работает только композитор. Enter/exit твины A заканчиваются до `t0`, элементы B входят после `t0 + D`.
- **Не запускать enter и exit одновременно.** На одном резе это даёт двойную экспозицию и два движения. Оставляй либо переход сцен, либо анимацию элемента.
- **Текст не едет вместе с кадром.** Подписи, HUD и титры рисуй после `apply`, поверх готового кадра. В whip/zoom/glitch текст внутри сцены превращается в смаз.
- **Текст A гаснет до t0**, 3 кадра: `alpha = clamp01((t0 - t) / (3 / FPS))`. **Текст B входит после t0 + D**, 3–4 кадра. В окне перехода виден максимум один текстовый слой.
- **Постоянный титр** не участвует в анимации сцены: статичная плашка поверх, opacity 0.85–1.0, без масштабирования.
- **Читаемость.** В кадре перехода нет текста мельче 22 px; плашка 40–60% непрозрачности; контраст ≥ 4.5:1. Проверяй кадр в масштабе 50%: 16 px HUD превращается в 8 px и теряется, 22 px — на грани.
- **Плашка гаснет вместе с текстом:** `plateAlpha = textAlpha * 0.55`, иначе фон мигает отдельно от букв.

```js
// окно перехода: сцены не запускают собственные enter/exit
const busy = t >= t0 && t <= t0 + D;
const textA = clamp01((t0 - t) / (3 / FPS));
const textB = clamp01((t - t0 - D) / (4 / FPS));
apply(ctx, 'whip', a, b, p);               // фоном владеет переход
if (!busy) {
  ctx.globalAlpha = t < t0 ? textA : textB;
  ctx.fillStyle = '#f4f7ff'; ctx.font = '500 26px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.fillText(t < t0 ? 'Старый раздел' : 'Новый раздел', 960, 960);
}
ctx.globalAlpha = 1;
```

## 4.5 Реестр

```js
const W = 1920, H = 1080, DIAG = Math.hypot(W, H);
const CYAN = '#4ff0ff', MAG = '#ff3fa4', AMBER = '#ffd166';
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = p => p * p * (3 - 2 * p);
const full = (c, s) => c.drawImage(s, 0, 0, W, H);
const mk = () => { const c = new OffscreenCanvas(W, H); return [c, c.getContext('2d')]; };
const [mask, mx] = mk(), [chan, cx] = mk();   // luma и каналы

function scaled(c, s, k, a = 1) {
  c.globalAlpha = a; c.drawImage(s, W * (1 - k) / 2, H * (1 - k) / 2, W * k, H * k); c.globalAlpha = 1;
}

function tint(c, s, col, dx, a) {
  cx.clearRect(0, 0, W, H); cx.drawImage(s, 0, 0, W, H);
  cx.globalCompositeOperation = 'source-in'; cx.fillStyle = col; cx.fillRect(0, 0, W, H);
  cx.globalCompositeOperation = 'source-over';
  c.globalAlpha = a; c.drawImage(chan, dx, 0, W, H); c.globalAlpha = 1;
}

const TRANSITIONS = {
  cut(c, a, b, p) { full(c, p < 0.5 ? a : b); },
  dip(c, a, b, p) {
    const k = 1 - Math.abs(2 * p - 1);
    full(c, p < 0.5 ? a : b);
    c.fillStyle = `rgba(5,6,13,${k})`; c.fillRect(0, 0, W, H);
  },
  whip(c, a, b, p) {
    const e = smooth(p);
    c.drawImage(a, -e * W, 0, W, H); c.drawImage(b, (1 - e) * W, 0, W, H);
    c.globalAlpha = 0.14;
    for (let i = 1; i <= 4; i++) c.drawImage(a, -Math.max(0, e - i * 0.035) * W, 0, W, H);
    c.globalAlpha = 1;
  },
  zoom(c, a, b, p) {
    const e = smooth(p);
    c.save(); c.filter = `blur(${(12 * Math.sin(Math.PI * p)).toFixed(1)}px)`;
    scaled(c, a, 1 + 0.35 * e); scaled(c, b, 1.25 - 0.25 * e, e); c.restore();
  },
  luma(c, a, b, p) {
    full(c, a); mx.clearRect(0, 0, W, H); mx.drawImage(b, 0, 0, W, H);
    mx.globalCompositeOperation = 'destination-in';
    const e = 1.2 * p - 0.1, g = mx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#000'); g.addColorStop(clamp01(e - 0.08), '#000');
    g.addColorStop(clamp01(e + 0.08), '#0000'); g.addColorStop(1, '#0000');
    mx.fillStyle = g; mx.fillRect(0, 0, W, H);
    mx.globalCompositeOperation = 'source-over'; full(c, mask);
  },
  iris(c, a, b, p) {
    full(c, a); const r = DIAG * 0.55 * smooth(p);
    c.save(); c.beginPath(); c.arc(W / 2, H / 2, Math.max(0.01, r), 0, Math.PI * 2);
    c.clip(); full(c, b); c.restore();
  },
  glitch(c, a, b, p) {
    const base = p < 0.5 ? a : b, k = Math.sin(Math.PI * p);
    full(c, base); tint(c, base, CYAN, -22 * k, 0.45 * k); tint(c, base, MAG, 22 * k, 0.45 * k);
    c.globalAlpha = 0.85;
    for (let i = 0; i < 7; i++) {
      const sy = ((i * 137 + 43) % 1000) / 1000 * H, sh = 10 + (i * 23) % 44;
      const dx = (i % 2 ? -1 : 1) * 30 * k * (0.5 + (i % 3) * 0.2);
      c.drawImage(base, 0, sy, W, sh, dx, sy, W, sh);
    }
    c.globalAlpha = 1;
  },
  burn(c, a, b, p) {
    full(c, a); c.globalAlpha = smooth(p); full(c, b); c.globalAlpha = 1;
    const x = W * (p * 1.2 - 0.1), g = c.createLinearGradient(x - 240, 0, x + 240, 0);
    g.addColorStop(0, 'rgba(255,209,102,0)'); g.addColorStop(0.48, 'rgba(255,209,102,.9)');
    g.addColorStop(0.55, 'rgba(255,63,164,.55)'); g.addColorStop(1, 'rgba(255,63,164,0)');
    c.globalCompositeOperation = 'screen'; c.fillStyle = g; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 24; i++) {
      const n = Math.sin(i * 78.233 + p * 31.7) * 43758.5453, r = n - Math.floor(n);
      c.globalAlpha = 0.15 + r * 0.5; c.fillStyle = i % 3 ? AMBER : MAG;
      c.fillRect(x + (r - 0.5) * 220, (i * 97) % H, 2 + r * 6, 8 + r * 26);
    }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  },
  shape(c, a, b, p) {
    full(c, a); const r = 1520 * smooth(p);
    c.save(); c.beginPath(); c.moveTo(W / 2, H / 2 - r);
    c.lineTo(W / 2 + r, H / 2); c.lineTo(W / 2, H / 2 + r); c.lineTo(W / 2 - r, H / 2);
    c.closePath(); c.clip(); full(c, b); c.restore();
  },
  push(c, a, b, p) {
    const e = smooth(p);
    c.drawImage(a, -e * W, 0, W, H); c.drawImage(b, (1 - e) * W, 0, W, H);
  },
  leak(c, a, b, p) {
    const k = Math.sin(Math.PI * p);
    full(c, a); c.globalAlpha = smooth(p); full(c, b); c.globalAlpha = 1;
    c.globalCompositeOperation = 'screen';
    const x = W * (0.12 + 0.76 * p), g = c.createRadialGradient(x, H * 0.36, 0, x, H * 0.36, W * 0.48);
    g.addColorStop(0, `rgba(255,209,102,${0.5 * k})`); g.addColorStop(0.5, `rgba(255,63,164,${0.22 * k})`);
    g.addColorStop(1, 'rgba(5,6,13,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.globalAlpha = 0.12 * k; c.fillStyle = AMBER; c.fillRect(x - 40, 0, 80, H);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  },
  match(c, a, b, p) { full(c, p < 0.5 ? a : b); },
};

function apply(ctx, name, a, b, p) {
  p = clamp01(p);
  const hard = name === 'cut' || name === 'match';
  if (!hard && (p <= 0 || p >= 1)) { full(ctx, p >= 1 ? b : a); return; }
  const fn = TRANSITIONS[name];
  if (!fn) throw new Error(`unknown transition: ${name}`);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  fn(ctx, a, b, p);
  ctx.restore();
}
```

Сцены рендерятся в два постоянных холста, чтобы не создавать десятки объектов в секунду:

```js
const A = new OffscreenCanvas(W, H), B = new OffscreenCanvas(W, H);
function sceneFrame(scene, t, target) {
  const c = target.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, W, H);
  c.save();
  scene(c, t);                            // сцена сама заливает фон
  c.restore();
  return target;
}
// в __draw(t): B получает время от начала своего входа
const p = clamp01((t - cutT) / D);
apply(ctx, 'dip', sceneFrame(sceneA, t, A), sceneFrame(sceneB, Math.max(0, t - cutT), B), p);
```

## 4.6 Ошибки

| Ошибка | Что видит зритель | Исправление |
|---|---|---|
| Переход длиннее двух битов (1.0 с) | затянутая смена, темп падает | рабочий предел 6–12 кадров (0.2–0.4 с), хвост переноси в новую сцену |
| Zoom blur на статике | плавающий расфокус без причины | движение камеры/объекта ≥3% кадра за кадр или cut |
| Dip to black в середине клипа | ролик закончился и начался снова | dip только в финале; в середине luma, glitch или cut |
| Переход без звука | смена выглядит случайной | райзер до beat, импакт в первом кадре B или вдох |
| p=0 или p=1 не равен чистому кадру | вспышка/провал на стыке | ранний выход `apply` на краях; сравнение кадров |
| Два перехода на одном резе | двойная экспозиция, рывок | один владелец кадра; enter/exit вне окна |
| `Math.random()` в искрах | искры прыгают при повторном рендере | хеш от `p` и индекса, как в burn |
