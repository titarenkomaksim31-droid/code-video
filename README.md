# code-video

**Русская версия:** [README.ru.md](README.ru.md)

An agent skill for making videos entirely out of code: one HTML file, Canvas 2D or Three.js, sound synthesized with Web Audio, output MP4 or WebM.

No footage, no images, no fonts, no mp3, no CDN. Open the file in a browser and it plays; run one command and it renders to a video file.

This is not a collection of "best practices". It is a set of working numbers: timings in frames, easing curves, levels in dB, exact ffmpeg commands, and the pitfalls that break a render.

![Frame from the template: the "Light" scene](docs/preview.jpg)

---

## What's inside

```
code-video/
├── SKILL.md                    main manual: frame contract, workflow, anti-patterns
├── README.md                   this file
├── README.ru.md                Russian version
├── references/
│   ├── 01-pipeline.md          file architecture, layers, per-frame budget
│   ├── 02-timing-and-easing.md BPM grid, easing, camera, text timings
│   ├── 03-visual-style.md      four style systems, palettes, light, composition
│   ├── 04-transitions.md       transition catalog with code
│   ├── 05-effects.md           glow, grain, particles, CRT, glitch, blur
│   ├── 06-typography.md        kinetic typography, Russian text specifics
│   ├── 07-audio.md             synthesis, score, mix, offline WAV render
│   ├── 08-3d.md                Three.js: light, shaders, particles, bloom
│   ├── 09-render.md            CDP, ffmpeg, contact sheets, BT.709
│   ├── 10-qa.md                checklists and defect table
│   └── 11-longform.md          videos of 60–180 seconds
├── assets/
│   └── skeleton.html           working template: 24 s, 4 scenes, sound, WebM recording
├── scripts/
│   └── render.mjs              frame-by-frame renderer, zero dependencies
└── docs/
    └── preview.jpg
```

The reference files are written in Russian. The skill works in any language: `SKILL.md` is the routing document an agent reads, and the demo template is language-agnostic.

---

## Quick start

Open `assets/skeleton.html` by double-clicking in Chrome:

- **▶** starts the piece with sound;
- **●** records a WebM with sound via `MediaRecorder`;
- `skeleton.html?t=14` renders a still at second 14 (useful for debugging a scene);
- Space pauses, arrow keys seek by 2 seconds.

The template already contains everything that usually gets rewritten from scratch: the `__meta / __draw / __ready` contract, the transport, the Web Audio graph, the score as data, offline audio rendering to WAV, and recording.

---

## Rendering to MP4

```bash
node scripts/render.mjs --html assets/skeleton.html --out out
```

What the script does:

1. launches headless Chrome and waits for `window.__ready`;
2. calls `window.__draw(t)` for each frame and captures PNGs over CDP;
3. pulls the audio: `window.__audioWav()` renders the score in an `OfflineAudioContext` in seconds, without real time;
4. muxes with `ffmpeg` to H.264 + AAC (BT.709, `-crf 18`).

Useful modes:

```bash
# stills only, to check scenes
node scripts/render.mjs --html film.html --out out --stills "2,8,14,20"

# a fragment at 60 fps
node scripts/render.mjs --html film.html --out out --fps 60 --from 4 --to 12

# the final MP4 plus a contact sheet
node scripts/render.mjs --html film.html --out out --sheet
```

If ffmpeg is not installed, the script still writes the PNG frames and `audio.wav` and prints a ready-to-paste mux command.

**Requirements:** Node 22+ (the global `WebSocket` is required; verified on 24), Chrome or Edge. ffmpeg is optional.
On Windows, Chrome is looked up in the standard locations; pass `--chrome "path"` to override.

---

## Install

The package is a folder with a `SKILL.md` inside. Installation is a copy — no build step, no npm, no dependencies.

### As a skill

Copy the `code-video` folder into your agent's skills directory:

| Agent | Destination |
|---|---|
| DSH | `~/.dsh/skills/code-video/` |
| Claude Code | `~/.claude/skills/code-video/` |
| Codex, Gemini CLI, Cursor | `~/.agents/skills/code-video/` |

For a project-local install, use the same folder names inside a repository: `<project>/.dsh/skills/`, `<project>/.claude/skills/`, `<project>/.agents/skills/`. The skill is then visible only in that project.

Windows, from the downloaded archive:

```powershell
Expand-Archive -Path "$env:USERPROFILE\Downloads\code-video.zip" `
               -DestinationPath "$env:USERPROFILE\.dsh\skills" -Force

# must print True
Test-Path "$env:USERPROFILE\.dsh\skills\code-video\SKILL.md"
```

Linux and macOS:

```bash
unzip code-video.zip -d ~/.dsh/skills/
test -f ~/.dsh/skills/code-video/SKILL.md && echo ok
```

The only thing that matters is ending up with `code-video/SKILL.md`, not `code-video/code-video/SKILL.md`. If the archive unpacked one level too deep, move the inner folder up.

The skill activates on its own whenever the task involves video, animation, titles or graphics. To invoke it explicitly, use its name: `/code-video`.

### Verify it works

1. Ask the agent: "make an html video with sound" — it should reference `code-video`.
2. Or open the template directly: `assets/skeleton.html`, press ▶, and check that the picture and sound start.
3. Or render a few frames: `node scripts/render.mjs --html assets/skeleton.html --out out --stills "2,8,14,20"` — PNGs appear in `out/`.

### Uninstall

```powershell
Remove-Item "$env:USERPROFILE\.dsh\skills\code-video" -Recurse -Force
```

### As a DSH plugin (optional)

If you want a plugin rather than a plain skill folder, put the contents into the profile and add an entry to `cordis.patch.yml`:

```yaml
- insert:
    - id: code-video-plugin
      name: "./plugins/code-video/index.mjs"
```

New plugins are added only through `insert`. An entry shaped like `- id: ...` in the user patch layer fails with `entry "..." not found`.

---

## Three principles

1. **A frame is a pure function of time.** `draw(t)` does not remember the previous frame. That is what makes seeking, frame-by-frame rendering and pixel-exact repeatability possible.
2. **Sound is a score, not a file.** An array of `{t, type, ...}` events is read by both the synthesizer and the timeline. One source of truth means perfect sync.
3. **One file.** No images, no fonts, no mp3, no CDN. Opens with a double click and renders offline.

---

## Verified

- `skeleton.html` rendered in headless Chrome: 8 control frames at 1920×1080, no console exceptions.
- Audio: 24.6 s, 2 channels, 44.1 kHz, peak −1.4 dB, groove RMS ≈ −20 dB.
- `render.mjs`: the PNG + WAV path is verified end to end; the MP4 branch is a standard ffmpeg H.264/AAC command.
- Syntax of both `skeleton.html` and `render.mjs` checked with `node --check`; no external requests or secrets anywhere in the package.

One known gap: ffmpeg was not available in the build environment, so the final mux step is not covered by a test run. Everything up to `audio.wav` is.

---

## License

MIT. Do whatever you want; attribution is not required.
