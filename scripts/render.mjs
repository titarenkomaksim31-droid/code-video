#!/usr/bin/env node
/**
 * code-video · покадровый рендер без зависимостей
 *
 * Поднимает headless Chrome, дёргает window.__draw(t) для каждого кадра,
 * снимает PNG через CDP, забирает WAV из window.__audioWav() и склеивает
 * всё ffmpeg-ом (если он есть).
 *
 * Примеры:
 *   node render.mjs --html ../assets/skeleton.html --out ../out
 *   node render.mjs --html film.html --out out --fps 60 --from 4 --to 12
 *   node render.mjs --html film.html --out out --stills "2,8,14,20"
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Глобальный WebSocket появился только в Node 22: на 18–20 скрипт молча упадёт.
if (typeof WebSocket !== 'function') {
  console.error('Нужен Node 22 или новее (глобальный WebSocket). Сейчас: ' + process.version);
  process.exit(1);
}

/* ---------------- аргументы ---------------- */
function parseArgs(argv) {
  const o = {
    html: path.join(HERE, '..', 'assets', 'skeleton.html'),
    out: path.join(HERE, '..', 'out'),
    fps: 30, from: 0, to: null, width: 1920, height: 1080,
    stills: null, sheet: false, keep: false, chrome: process.env.CHROME || null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--html') o.html = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--fps') o.fps = Number(argv[++i]);
    else if (a === '--from') o.from = Number(argv[++i]);
    else if (a === '--to') o.to = Number(argv[++i]);
    else if (a === '--width') o.width = Number(argv[++i]);
    else if (a === '--height') o.height = Number(argv[++i]);
    else if (a === '--stills') o.stills = argv[++i];
    else if (a === '--sheet') o.sheet = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--chrome') o.chrome = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return o;
}

/* ---------------- окружение ---------------- */
function findChrome(explicit) {
  const win = [
    explicit,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const unix = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  for (const p of [...win, ...unix]) if (p && fs.existsSync(p)) return p;
  throw new Error('Chrome не найден. Укажи --chrome "путь" или переменную CHROME.');
}

function findFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? 'ffmpeg' : null;
}

/* ---------------- CDP ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else {
        const h = this.handlers.get(m.method);
        if (h) h(m.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
}

async function waitFile(p, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const s = (await fsp.readFile(p, 'utf8')).trim();
      if (s) return s;
    } catch { /* файла ещё нет */ }
    await sleep(120);
  }
  throw new Error('Chrome не создал DevToolsActivePort за ' + ms + ' мс');
}

async function connect(chromePath, pageUrl, opts) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'codevideo-'));
  const args = [
    '--headless=new',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--remote-allow-origins=*',
    '--remote-debugging-port=0',
    '--window-size=' + opts.width + ',' + opts.height,
    '--user-data-dir=' + profile,
    pageUrl
  ];
  const proc = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const raw = await waitFile(portFile);
  const port = raw.split(/\r?\n/)[0].trim();

  let targets = [];
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch { }
    if (targets.some(t => t.type === 'page')) break;
    await sleep(150);
  }
  const page = targets.find(t => t.type === 'page' && /^file:/.test(t.url))
    || targets.find(t => t.type === 'page');
  if (!page) throw new Error('Не нашёл вкладку в Chrome');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket к Chrome не открылся')), { once: true });
  });
  const cdp = new CDP(ws);
  return { cdp, proc, profile, ws };
}

/* ---------------- основной сценарий ---------------- */
const opts = parseArgs(process.argv.slice(2));
const chromePath = findChrome(opts.chrome);
const ffmpeg = findFfmpeg();
const htmlPath = path.resolve(opts.html);
if (!fs.existsSync(htmlPath)) { console.error('Нет файла: ' + htmlPath); process.exit(1); }

const outDir = path.resolve(opts.out);
await fsp.mkdir(outDir, { recursive: true });

const pageUrl = pathToFileURL(htmlPath).href + '?t=0&bare';
console.log('Chrome :', chromePath);
console.log('Страница:', htmlPath);
console.log('ffmpeg :', ffmpeg || 'нет — соберу PNG+WAV, склейка вручную');
console.log('Выход  :', outDir);

const { cdp, proc, profile, ws } = await connect(chromePath, pageUrl, opts);

let fatal = null;
cdp.on('Runtime.exceptionThrown', p => {
  fatal = p.exceptionDetails;
  console.error('JS ИСКЛЮЧЕНИЕ:', p.exceptionDetails.text,
    (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || '');
});
cdp.on('Runtime.consoleAPICalled', p => {
  if (p.type === 'error') console.error('console.error:', p.args.map(a => a.value ?? a.description ?? '?').join(' '));
});

try {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false
  });

  // ждём контракт
  let ready = false;
  for (let i = 0; i < 150; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true });
    if (r.result && r.result.value === true) { ready = true; break; }
    await sleep(100);
  }
  if (!ready) throw new Error('window.__ready не появился — страница не по контракту');
  if (fatal) throw new Error('Ошибка на странице: ' + fatal.text);

  const meta = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__meta || {})', returnByValue: true
  });
  const m = JSON.parse(meta.result.value || '{}');
  const duration = opts.to != null ? opts.to : (m.duration || 10);
  console.log('Мета   :', m.title || '—', '|', duration + ' c |', opts.fps + ' fps');

  const draw = async t => {
    await cdp.send('Runtime.evaluate', { expression: 'window.__draw(' + Number(t).toFixed(6) + ')' });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(shot.data, 'base64');
  };

  if (opts.stills) {
    // только отдельные кадры — для быстрой проверки сцен
    const times = opts.stills.split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n));
    for (const t of times) {
      const png = await draw(t);
      const name = 'still_' + String(t).replace('.', '_') + '.png';
      await fsp.writeFile(path.join(outDir, name), png);
      console.log('  кадр t=' + t + ' → ' + name);
    }
  } else {
    const from = opts.from, fps = opts.fps;
    const total = Math.max(1, Math.round((duration - from) * fps));
    const t0 = Date.now();
    for (let i = 0; i < total; i++) {
      const t = from + i / fps;
      const png = await draw(t);
      await fsp.writeFile(path.join(outDir, 'frame_' + String(i).padStart(5, '0') + '.png'), png);
      if (i % 30 === 0 || i === total - 1) {
        const el = (Date.now() - t0) / 1000;
        const eta = i > 0 ? el / i * (total - i) : 0;
        console.log('  ' + (i + 1) + '/' + total + '  ' + el.toFixed(1) + ' c  ETA ' + eta.toFixed(0) + ' c');
      }
      if (fatal) throw new Error('Ошибка на кадре ' + i + ': ' + fatal.text);
    }

    // звук
    let wavPath = null;
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'window.__audioWav()', awaitPromise: true, returnByValue: true
      });
      const b64 = r.result && r.result.value;
      if (b64) {
        wavPath = path.join(outDir, 'audio.wav');
        await fsp.writeFile(wavPath, Buffer.from(b64, 'base64'));
        console.log('Звук   : audio.wav (' + (fs.statSync(wavPath).size / 1024 / 1024).toFixed(1) + ' МБ)');
      } else {
        console.log('Звук   : window.__audioWav() вернул пусто');
      }
    } catch (e) {
      console.log('Звук   : не удалось (' + e.message + ')');
    }

    if (ffmpeg && wavPath) {
      const mp4 = path.join(outDir, path.basename(htmlPath, '.html') + '.mp4');
      const args2 = [
        '-y',
        '-framerate', String(fps), '-start_number', '0', '-i', path.join(outDir, 'frame_%05d.png'),
        '-i', wavPath,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-fps_mode', 'cfr',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-movflags', '+faststart',
        mp4
      ];
      console.log('ffmpeg : сборка…');
      const r = spawnSync(ffmpeg, args2, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
      if (r.status !== 0) console.error(r.stderr);
      else console.log('Готово : ' + mp4 + ' (' + (fs.statSync(mp4).size / 1024 / 1024).toFixed(1) + ' МБ)');
    } else if (wavPath) {
      console.log('\nСобрать вручную:');
      console.log('ffmpeg -y -framerate ' + fps + ' -i "' + path.join(outDir, 'frame_%05d.png') + '" -i "' +
        wavPath + '" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest out.mp4');
    }

    if (opts.sheet && ffmpeg) {
      const mp4 = path.join(outDir, path.basename(htmlPath, '.html') + '.mp4');
      if (fs.existsSync(mp4)) {
        const sheet = path.join(outDir, 'sheet.png');
        spawnSync(ffmpeg, ['-y', '-i', mp4, '-vf', 'fps=2,scale=480:-1,tile=5x3', '-frames:v', '1', sheet]);
        console.log('Лист   : ' + sheet);
      }
    }
  }
} finally {
  try { ws.close(); } catch { }
  proc.kill();
  await sleep(300);
  if (!opts.keep) { try { await fsp.rm(profile, { recursive: true, force: true }); } catch { } }
}

if (fatal) process.exit(2);
