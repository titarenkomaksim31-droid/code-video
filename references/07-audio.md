# Аудио: синтез, партитура и рендер Web Audio

Звук ролика собирается в `AudioContext` из генераторов: ни mp3, ни сэмплов. Все примеры совместимы с контрактом кадра 1920×1080, 30 fps, BPM 120. Аудио и видео синхронизируются по секундам: тик партитуры `t` равен времени `t` в `window.__draw(t)`.

```js
const BPM = 120, BEAT = 60 / BPM, BAR = BEAT * 4; // 0.5 и 2.0 с
```
## Архитектура графа
```text
kick/snare/hat ─────────────→ drums ─┐
bass ───────────────────────→ bass  ─┤
pad ─→ padDuck ─┐                    ├→ compressor → master → transport → analyser → monitor → destination
pluck ──────────┴→ music ────────────┤                              └──────→ MediaStreamDestination
riser/impact ───────────────→ fx ────┘

pad ───→ reverbSend (0.22) → convolver → reverbReturn → music
pluck ─────→ delaySend  (0.18) → delay 0.375 ⇄ feedback 0.3 / lowpass 2400 → delayReturn → music
```
| Узел | Тип | Роль |
|---|---|---|
| instrument gain | `GainNode` | уровень до суммирования, запас 4–18 dB |
| drums/bass/music/fx | `GainNode` | групповой уровень и общая обработка |
| padDuck | `GainNode` | сайдчейн только для пэда, 2–4 dB |
| compressor | `DynamicsCompressorNode` | склейка, контроль пиков |
| master | `GainNode` | калибровка −14 LUFS, 0.82 старт |
| transport | `GainNode` | единая точка съёма и паузы, часы не здесь |
| analyser | `AnalyserNode` | meter после master, до монитора |
| monitor | `GainNode` | mute для UI, запись не глушит |
| destination | `AudioDestinationNode` | динамики/наушники |
| recDest | `MediaStreamAudioDestinationNode` | параллельный поток для MediaRecorder |
| reverb/delay | send-шины | мокрый сигнал, dry идёт в music напрямую |

```js
function makeIR(ctx, sec = 2.8, decay = 3.2) {
  const n = Math.floor(ctx.sampleRate * sec), ir = ctx.createBuffer(2, n, ctx.sampleRate);
  let s = 0x9e3779b9;
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < n; i++, s ^= s << 13, s ^= s >>> 17, s ^= s << 5)
      d[i] = ((s >>> 0) / 4294967296 * 2 - 1) * (1 - i / n) ** decay;
  }
  return ir;
}
function createGraph(ctx, recording = false) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 6; comp.ratio.value = 3;
  comp.attack.value = 0.003; comp.release.value = 0.12;
  const master = ctx.createGain(); master.gain.value = 0.82;
  const transport = ctx.createGain();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.82;
  const monitor = ctx.createGain();
  const drums = ctx.createGain(), bass = ctx.createGain(), music = ctx.createGain(), fx = ctx.createGain();
  [drums, bass, music, fx].forEach(bus => bus.connect(comp));
  comp.connect(master).connect(transport);
  transport.connect(analyser); analyser.connect(monitor); monitor.connect(ctx.destination);
  const recDest = recording ? ctx.createMediaStreamDestination() : null;
  if (recDest) transport.connect(recDest);
  const padDuck = ctx.createGain(); padDuck.connect(music);
  const revSend = ctx.createGain(); revSend.gain.value = 0.22;
  const reverb = ctx.createConvolver(); reverb.buffer = makeIR(ctx);
  const revReturn = ctx.createGain(); revSend.connect(reverb).connect(revReturn).connect(music);
  const delay = ctx.createDelay(1); delay.delayTime.value = 0.375;
  const damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2400;
  const fb = ctx.createGain(), dlySend = ctx.createGain(), dlyReturn = ctx.createGain();
  fb.gain.value = 0.3; dlySend.gain.value = 0.18;
  dlySend.connect(delay); delay.connect(damp); damp.connect(fb); fb.connect(delay); damp.connect(dlyReturn); dlyReturn.connect(music);
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = noise.getChannelData(0);
  for (let i = 0, s = 0x1234567; i < nd.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; nd[i] = (s >>> 0) / 4294967296 * 2 - 1; }
  const active = new Set();
  const launch = (src, t, dur) => {
    src.start(t); src.stop(t + dur); active.add(src);
    src.addEventListener('ended', () => { active.delete(src); src.disconnect(); }, { once: true });
    return src;
  };
  return { ctx, drums, bass, music, fx, padDuck, comp, master, transport, analyser, monitor, recDest,
    revSend, revReturn, dlySend, dlyReturn, noise, active, launch, stream: recDest?.stream };
}
```
`transport` намеренно стоит после `master`: при паузе гаснет и монитор, и запись, а `analyser` показывает уже сведённый сигнал. `ctx.suspend()` не используется — он останавливает часы и ломает расчёт `origin`.
## Синтез инструментов
| Инструмент | Осциллятор | Огибающая | Фильтр / эффект |
|---|---|---|---|
| kick | sine 170→46 Гц за 0.09 с | 0.9→0.0001 за 0.09 с | без фильтра |
| snare | шум + sine 180 Гц | 0.5 и 0.25 за 0.16/0.08 с | bandpass 1900, Q 0.8 |
| hat | шум | 0.18→0.0001 за 0.03 с | highpass 7800 |
| bass | saw + sine на октаву ниже | 0.8 за 0.35 с | lowpass 2400→180 Гц, Q 6 |
| pluck | saw, detune +6 центов | 0.28 за 0.28 с | lowpass 5200→900 Гц; send 0.2 |
| pad | 2 saw на ноту, ±8 центов | атака 1 с, release 0.8 с | lowpass 1600, 2×0.05/ноту |
| riser | шум + sine 110→880 Гц | 0.16 и 0.08 за `dur` | bandpass 400→7800 Гц |
| impact | sine 70→32 Гц + шум | 0.8 и 0.45 за 0.9/0.6 с | lowpass 6000→120 Гц |

```js
const hz = m => 440 * 2 ** ((m - 69) / 12);
const gainEnv = (p, t, a, d, v) => {
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(v, t + a);
  p.exponentialRampToValueAtTime(0.0001, t + a + d);
};

const tone = (g, t, type, f, d) => { const o = g.ctx.createOscillator(); o.type = type; o.frequency.value = f; g.launch(o, t, d); return o; };
const nSrc = (g, t, d, loop = false) => { const n = g.ctx.createBufferSource(); n.buffer = g.noise; n.loop = loop; g.launch(n, t, d); return n; };
const filt = (g, type, f, q = 1) => { const b = g.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };

function kick(g, t, ev) {
  const o = tone(g, t, 'sine', 170, 0.1), a = g.ctx.createGain();
  o.frequency.exponentialRampToValueAtTime(46, t + 0.09);
  a.gain.setValueAtTime(0.9 * ev.v, t); a.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.connect(a).connect(g.drums);
}
function snare(g, t, ev) {
  const ng = g.ctx.createGain(); gainEnv(ng.gain, t, 0.001, 0.16, 0.5 * ev.v);
  nSrc(g, t, 0.2).connect(filt(g, 'bandpass', 1900, 0.8)).connect(ng).connect(g.drums);
  const og = g.ctx.createGain(); gainEnv(og.gain, t, 0.001, 0.08, 0.25 * ev.v);
  tone(g, t, 'sine', 180, 0.1).connect(og).connect(g.drums);
}
function hat(g, t, ev) {
  const a = g.ctx.createGain(); gainEnv(a.gain, t, 0.001, 0.03, 0.18 * ev.v);
  nSrc(g, t, 0.05).connect(filt(g, 'highpass', 7800)).connect(a).connect(g.drums);
}
function bass(g, t, ev) {
  const f = hz(ev.note), dur = ev.dur || 0.35, lp = filt(g, 'lowpass', 2400, 6), a = g.ctx.createGain();
  lp.frequency.exponentialRampToValueAtTime(180, t + 0.18); gainEnv(a.gain, t, 0.005, dur, 0.8 * ev.v);
  tone(g, t, 'sawtooth', f, dur + 0.05).connect(lp).connect(a).connect(g.bass);
  const sg = g.ctx.createGain(); gainEnv(sg.gain, t, 0.005, dur, 0.35 * ev.v);
  tone(g, t, 'sine', f / 2, dur + 0.05).connect(sg).connect(g.bass);
}
function pluck(g, t, ev) {
  const lp = filt(g, 'lowpass', 5200, 2), a = g.ctx.createGain();
  lp.frequency.exponentialRampToValueAtTime(900, t + 0.18); gainEnv(a.gain, t, 0.003, 0.28, 0.28 * (ev.v || 1));
  const o = tone(g, t, 'sawtooth', hz(ev.note), 0.32); o.detune.value = 6;
  o.connect(lp).connect(a); a.connect(g.music); a.connect(g.dlySend);
}
function pad(g, t, ev) {
  const dur = ev.dur || 1.9, f = filt(g, 'lowpass', 1600, 0.7); f.connect(g.padDuck); f.connect(g.revSend);
  for (const note of ev.notes) for (const det of [-8, 8]) {
    const a = g.ctx.createGain(), o = tone(g, t, 'sawtooth', hz(note), dur + 0.85); o.detune.value = det;
    a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(0.05, t + 1);
    a.gain.setValueAtTime(0.05, t + dur); a.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.8);
    o.connect(a).connect(f);
  }
}
function riser(g, t, ev) {
  const d = ev.dur || 4, bp = filt(g, 'bandpass', 400, 2.5), ng = g.ctx.createGain();
  const o = tone(g, t, 'sine', 110, d), og = g.ctx.createGain();
  bp.frequency.exponentialRampToValueAtTime(7800, t + d);
  ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(0.16, t + d * 0.9); ng.gain.linearRampToValueAtTime(0.0001, t + d);
  nSrc(g, t, d, true).connect(bp).connect(ng).connect(g.fx);
  o.frequency.exponentialRampToValueAtTime(880, t + d);
  og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.08, t + d * 0.9); og.gain.linearRampToValueAtTime(0.0001, t + d);
  o.connect(og).connect(g.fx);
}
function impact(g, t, ev) {
  const o = tone(g, t, 'sine', 70, 0.95), a = g.ctx.createGain(); o.frequency.exponentialRampToValueAtTime(32, t + 0.7);
  gainEnv(a.gain, t, 0.002, 0.9, 0.8 * ev.v); o.connect(a).connect(g.fx);
  const lp = filt(g, 'lowpass', 6000, 1.2), ng = g.ctx.createGain(); lp.frequency.exponentialRampToValueAtTime(120, t + 0.6);
  gainEnv(ng.gain, t, 0.001, 0.6, 0.45 * ev.v);
  nSrc(g, t, 0.65).connect(lp).connect(ng).connect(g.fx);
}

const VOICES = { kick, snare, hat, bass, pluck, pad, riser, impact };
```
## Партитура как данные
Событие — плоский объект с секундами от нуля. `buildScore()` не трогает AudioContext и вызывается один раз.

| Поле | Тип | Смысл |
|---|---|---|
| `t` | секунды | начало события, `0 ≤ t < duration` |
| `type` | строка | ключ из `VOICES` |
| `v` | 0…1 | velocity, множитель громкости |
| `note` | MIDI | для bass/pluck, 69 = A4 440 Гц |
| `notes` | MIDI[] | аккорд для pad |
| `dur` | секунды | длина ноты или riser |

```js
const PROG = [{ pad: [57, 60, 64], bass: 45 }, { pad: [53, 57, 60], bass: 41 }, // Am, F
  { pad: [60, 64, 67], bass: 48 }, { pad: [55, 59, 62], bass: 43 }]; // C, G

function buildScore(bars = 8) {
  const events = [];
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * BAR, chord = PROG[bar % 4];
    for (const b of [0, 0.5, 1, 1.5]) events.push({ t: t0 + b, type: 'kick', v: 1 });
    for (const b of [0.5, 1.5]) events.push({ t: t0 + b, type: 'snare', v: 0.9 });
    for (let i = 0; i < 16; i++) events.push({ t: t0 + i * 0.125, type: 'hat', v: i % 4 === 0 ? 1 : 0.6 });
    events.push({ t: t0, type: 'pad', notes: chord.pad, dur: 1.9, v: 0.8 });
    for (const b of [0, 0.75, 1.5]) events.push({ t: t0 + b, type: 'bass', note: chord.bass, dur: 0.35, v: 1 });
    const arp = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 4, 5, 4, 3];
    for (let i = 0; i < 16; i++) {
      const n = chord.pad[arp[i] % 3] + 12 * (1 + Math.floor(arp[i] / 3));
      events.push({ t: t0 + i * 0.125, type: 'pluck', note: n, v: i % 4 === 0 ? 0.9 : 0.55 });
    }
  }
  events.push({ t: 12, type: 'riser', dur: 4, v: 1 });
  events.push({ t: 8, type: 'impact', v: 0.8 }, { t: 15.9, type: 'impact', v: 1 });
  events.sort((a, b) => a.t - b.t);
  return { events, duration: bars * BAR }; // 8 тактов = 16 с
}
```
## Планировщик
Один `setInterval` с периодом 25 мс добирает события на 0.25 с вперёд. `origin` — время AudioContext, соответствующее `score.t = 0`; задержка 0.12 с покрывает дрожание таймера.

```js
function createTransport(g, score) {
  const LOOKAHEAD = 0.25, TICK_MS = 25;
  let origin = 0, offset = 0, startTime = 0, nextIndex = 0, timer = 0, playing = false;
  const now = () => g.ctx.currentTime;
  function stopSources() { for (const src of g.active) { try { src.stop(); } catch {} src.disconnect(); } g.active.clear(); }
  function tick() {
    const horizon = now() + LOOKAHEAD;
    while (nextIndex < score.events.length && origin + score.events[nextIndex].t < horizon) {
      const ev = score.events[nextIndex++]; VOICES[ev.type]?.(g, Math.max(origin + ev.t, now() + 0.005), ev);
    }
  }
  function start(from = 0) {
    if (playing) pause();
    offset = Math.max(0, Math.min(from, score.duration)); startTime = now() + 0.12; origin = startTime - offset;
    nextIndex = score.events.findIndex(e => e.t >= offset - 1e-6);
    if (nextIndex < 0) nextIndex = score.events.length;
    playing = true; timer = setInterval(tick, TICK_MS); tick();
  }
  function pause() {
    if (!playing) return;
    offset = Math.min(score.duration, offset + Math.max(0, now() - startTime));
    clearInterval(timer); timer = 0; playing = false; stopSources();
  }
  function seek(t) { const was = playing; pause(); offset = t; if (was) start(t); }
  function position() { return playing ? Math.min(score.duration, offset + Math.max(0, now() - startTime)) : offset; }
  return { start, pause, seek, stop: pause, position, isPlaying: () => playing };
}
```
`start(from)` сдвигает `origin` так, чтобы событие на `from` прозвучало через 0.12 с. `pause()` сохраняет позицию и глушит источники; `seek()` перезапускает планировщик с нового индекса. Пауза в записи даёт стык — для бесшовного монтажа используйте offline-рендер. `setInterval(25)` не заменяйте на `requestAnimationFrame`: при 30 fps окно планирования колеблется до 33 мс.
## Гармония
| Такт | Аккорд | MIDI пэда | Частоты, Гц | Бас MIDI / Гц |
|---|---|---|---|---|
| 1 | Am | 57, 60, 64 | 220.00, 261.63, 329.63 | 45 / 110.00 |
| 2 | F | 53, 57, 60 | 174.61, 220.00, 261.63 | 41 / 87.31 |
| 3 | C | 60, 64, 67 | 261.63, 329.63, 392.00 | 48 / 130.81 |
| 4 | G | 55, 59, 62 | 196.00, 246.94, 293.66 | 43 / 98.00 |

Бас — ровно на октаву ниже корня пэда. Арпеджио идёт 16-ми: `0.125 с` на шаг, 16 шагов на такт, формула высоты `hz(chord.pad[arp[i] % 3] + 12 * (1 + Math.floor(arp[i] / 3)))`. Прогрессия Am–F–C–G повторяется каждые 4 такта; 8 тактов дают два круга и 16.0 с.
## Микс
| Источник | dB | Линейный gain |
|---|---|---|
| kick | 0 | 1.000 |
| snare | −6 | 0.501 |
| hat | −18 | 0.126 |
| bass | −4 | 0.631 |
| pad | −16 | 0.158 |
| arp/pluck | −14 | 0.200 |

```js
const db = x => 10 ** (x / 20); // -6 dB → 0.501
```
Компрессор: threshold −16 dB, knee 6, ratio 3, attack 3 мс, release 120 мс. Цель — −14 LUFS integrated и true peak ≤ −1 dBTP (0.891 линейного). Web Audio не измеряет LUFS: рендерите WAV, проверяйте `ffmpeg -af ebur128=peak=true` (если ffmpeg есть) и правьте `master.gain`. Без LUFS-метра ставьте sample peak −1 dB и RMS микса около −15 dBFS; true peak требует 4× oversampling или `loudnorm`.
## Реверб и дилей
Импульсная характеристика — затухающий шум 2.8 с, decay 3.2, стерео. `ConvolverNode.normalize = true` (по умолчанию) выравнивает уровень; после замены IR перемеряйте мастер. Wet 15–25%: `revSend.gain = 0.15…0.25`, dry не трогаем. Дилей — 3/16 при 120 BPM: `3 × 0.125 = 0.375 с`; `feedback = 0.3`, `lowpass = 2400` внутри петли, send 0.18. `delay.delayTime` меняется мгновенно — не автоматизируйте его без `setTargetAtTime`.
## Сайдчейн
Каждый kick приглушает шину пэда на 2–4 dB: −3 dB = 0.708, −4 dB = 0.631. Автоматизация пишется на `padDuck.gain` в момент kick, до старта пэда.

```js
function duck(g, t, depthDb = 3) {
  const p = g.padDuck.gain, level = db(-depthDb);
  p.cancelScheduledValues(t); p.setValueAtTime(1, t);
  p.linearRampToValueAtTime(level, t + 0.012);
  p.setTargetAtTime(1, t + 0.025, 0.09);
}
```
Вызывайте `duck(g, at, 3)` внутри `VOICES.kick` после запуска осциллятора. Постоянная восстановления 0.09 с: к следующему удару (0.5 с) gain возвращается к 1.0 на 99%.
## OfflineAudioContext: WAV за секунды
`OfflineAudioContext` проходит всю партитуру без вывода в динамики: события ставятся на абсолютные `ev.t`, затем `startRendering()` рендерит быстрее реального времени (16 с микса — обычно 1–4 с на десктопе). `MediaRecorder` здесь не нужен.

```js
async function renderWav(score, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(2, Math.ceil((score.duration + 1.5) * sampleRate), sampleRate);
  const g = createGraph(ctx, false);
  for (const ev of score.events) VOICES[ev.type]?.(g, ev.t, ev);
  return encodeWav(await ctx.startRendering());
}
function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const ab = new ArrayBuffer(44 + n * ch * 2), v = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i)); let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, data[c][i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}
```
Для 60 fps-ролика длиной 90 с при 48 кГц буфер занимает `90 × 48000 × 2 × 2 ≈ 17.3 МБ`; WAV-файл того же порядка. `startRendering()` нельзя вызвать дважды — создавайте новый `OfflineAudioContext` на каждый рендер.
## Запись через MediaRecorder
```js
async function record(g, transport, seconds = 20) {
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(g.stream, { mimeType: mime, audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.start(250);
  await new Promise(r => setTimeout(r, 60)); // захват стартует раньше звука
  transport.start(0);
  await new Promise(r => setTimeout(r, seconds * 1000));
  transport.stop(); rec.stop();
  await new Promise(r => rec.onstop = r);
  return new Blob(chunks, { type: mime }); // Opus 192 кбит/с
}
```
`audioBitsPerSecond` — целевой битрейт, фактический зависит от Opus (обычно 160–220 кбит/с). Граф создавайте как `createGraph(ctx, true)`, иначе `g.stream === null`. Для MP4 нужен `ffmpeg -i mix.webm -c:a aac -b:a 192k mix.m4a`; при отсутствии ffmpeg оставляйте WebM. Синхронизация: запускайте `rec.start()` и `transport.start()` в одном обработчике, а расхождение первых 60 мс компенсируйте trim при монтаже.
## Ошибки
- **Autoplay policy.** `AudioContext` создаётся в `suspended`; `resume()` разрешён после жеста. В headless Chrome запускайте с `--autoplay-policy=no-user-gesture-required` и проверяйте `ctx.state === 'running'`.
- **Ноль в exponential ramp.** `exponentialRampToValueAtTime(0, t)` бросает `RangeError`. Минимум — `0.0001`, затем `linearRampToValueAtTime(0, t)`.
- **Клики при stop.** Обрывайте источник после спада gain 5–10 мс: `gain.setTargetAtTime(0, t, 0.004); src.stop(t + 0.02)`. Иначе слышен щелчок на срезе волны.
- **Утечка узлов.** После `ended` делайте `disconnect()`; шумовые буферы и IR создавайте один раз на контекст, а не на событие.
- **Моно/стерео.** Моно-шум апмикшируется в оба канала; стерео-IR даёт ширину. `analyser.fftSize = 2048` даёт 1024 бина по 23.4 Гц при 48 кГц.
- **Пауза.** Не используйте `ctx.suspend()` в связке с `ctx.currentTime`; планировщик замирает вместе с часами. Глушите `transport.gain` и источники.
