import { CONFIG, CONSENT, VOICES, TAKES, allClips } from "./protocol.js";
import { OUT_RATE, levelStats, activeDb, resample, encodeWav, makeZip, clipFlags, farSeconds, LIMITS } from "./core.js";

const params = new URLSearchParams(location.search);
const DEMO = params.get("demo") === "1";
const $ = (sel) => document.querySelector(sel);
const app = $("#app");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------- storage (IndexedDB: survives reloads and crashes) ----------------

const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open("voice-recorder", 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore("session");
    req.result.createObjectStore("clips");
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const idb = (store, mode, fn) =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
const put = (store, key, val) => idb(store, "readwrite", (s) => s.put(val, key));
const get = (store, key) => idb(store, "readonly", (s) => s.get(key));
const del = (store, key) => idb(store, "readwrite", (s) => s.delete(key));

// ---------------- audio engine ----------------

const WORKLET = `
class Rec extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.buf = []; this.n = 0; this.lv = 0; this.pk = 0; this.ln = 0;
    this.port.onmessage = (e) => { if (e.data.rec !== undefined) { if (!e.data.rec) this.flush(true); this.on = e.data.rec; } }; }
  flush(done) { if (this.buf.length) { const out = new Float32Array(this.n); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; } this.port.postMessage({ type: "chunk", data: out }, [out.buffer]); }
    this.buf = []; this.n = 0; if (done) this.port.postMessage({ type: "flushed" }); }
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); this.lv += ch[i] * ch[i]; if (a > this.pk) this.pk = a; }
    this.ln += ch.length;
    if (this.ln >= 2048) { this.port.postMessage({ type: "level", rms: Math.sqrt(this.lv / this.ln), peak: this.pk }); this.lv = 0; this.pk = 0; this.ln = 0; }
    if (this.on) { this.buf.push(new Float32Array(ch)); this.n += ch.length; if (this.n >= 16384) this.flush(false); }
    return true; }
}
registerProcessor("rec", Rec);`;

const engine = {
  ctx: null, node: null, stream: null, settings: null, chunks: [], onLevel: null, flushed: null,
  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    let source;
    if (DEMO) {
      source = demoSource(this.ctx);
      this.settings = { demo: true, sampleRate: this.ctx.sampleRate };
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const track = this.stream.getAudioTracks()[0];
      this.settings = { ...track.getSettings(), label: track.label, contextRate: this.ctx.sampleRate };
      source = this.ctx.createMediaStreamSource(this.stream);
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    this.node = new AudioWorkletNode(this.ctx, "rec");
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(this.node).connect(mute).connect(this.ctx.destination); // keeps the worklet running
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "level") this.onLevel?.(m.rms, m.peak);
      else if (m.type === "chunk") this.chunks.push(m.data);
      else if (m.type === "flushed") this.flushed?.();
    };
  },
  start() {
    this.chunks = [];
    this.node.port.postMessage({ rec: true });
  },
  async stop() {
    const done = new Promise((r) => (this.flushed = r));
    this.node.port.postMessage({ rec: false });
    await done;
    const n = this.chunks.reduce((a, c) => a + c.length, 0);
    const x = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) { x.set(c, o); o += c.length; }
    this.chunks = [];
    return { samples: x, rate: this.ctx.sampleRate };
  },
  beep(freq = 1000, ms = 250) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.3, this.ctx.currentTime);
    g.gain.setValueAtTime(0, this.ctx.currentTime + ms / 1000);
    o.connect(g).connect(this.ctx.destination);
    o.start();
    o.stop(this.ctx.currentTime + ms / 1000 + 0.05);
  },
};

// ?demo=1: synthetic input (quiet noise floor plus speech-like bursts) so the whole flow can be
// tested without a microphone. The bursts are muted during the room check, like a silent room.
function demoSource(ctx) {
  const sr = ctx.sampleRate;
  const loop = (fill) => {
    const buf = ctx.createBuffer(1, sr * 4, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = fill(i / sr);
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true; s.start();
    return s;
  };
  const floor = loop(() => (Math.random() * 2 - 1) * 0.001);
  const speech = loop((t) => (t % 0.5 < 0.32 && t > 0.6 ? (Math.random() * 2 - 1) * 0.08 * Math.sin(2 * Math.PI * 3 * t) ** 2 : 0));
  const gate = ctx.createGain();
  speech.connect(gate);
  const mix = ctx.createGain();
  floor.connect(mix); gate.connect(mix);
  engine.demoSpeech = (on) => gate.gain.setValueAtTime(on ? 1 : 0, ctx.currentTime);
  return mix;
}

// Keep the screen on while recording (iOS stops capture when the screen locks).
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { wakeLock = null; }
}
let recordingActive = false;
let interrupted = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
  else if (recordingActive) {
    // Real input: the take is incomplete, so it is discarded and redone. Demo input is synthetic,
    // so a hidden test browser only gets counted, not discarded.
    if (DEMO) { S.interruptions++; save(); } else interrupted = true;
  }
});

// ---------------- session ----------------

const CLIPS = allClips();
let S = null; // session state, persisted

function newSession(pid) {
  return { pid, startedAt: new Date().toISOString(), consent: null, details: {}, settings: null,
    floorDb: null, normalDb: null, far: null, done: {}, interruptions: 0, protocol: CONFIG.protocolVersion };
}
const save = () => put("session", S.pid, S);
const keyOf = (clipKey) => `${S.pid}/${clipKey}`;
const nextPending = () => CLIPS.find((c) => !S.done[c.key]);

// ---------------- UI helpers ----------------

function screen(html) {
  app.innerHTML = html;
  window.scrollTo(0, 0);
  const done = Object.keys(S?.done || {}).length;
  $("#progress").style.width = `${S ? (100 * done) / CLIPS.length : 0}%`;
}
const on = (sel, fn) => $(sel)?.addEventListener("click", fn);
const voiceCard = (v) =>
  v ? `<div class="voice voice-${v}"><strong>${esc(VOICES[v].label)}</strong><span>${esc(VOICES[v].how)}</span>${VOICES[v].check ? `<em>${esc(VOICES[v].check)}</em>` : ""}</div>` : "";

function meter() {
  engine.onLevel = (rms) => {
    const el = $("#meter i");
    if (!el) return;
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    el.style.width = `${Math.max(0, Math.min(100, ((db + 70) / 70) * 100))}%`;
  };
  return `<div id="meter" class="meter"><i></i></div>`;
}

// ---------------- screens ----------------

async function start() {
  const pid = (params.get("id") || "").trim().toUpperCase();
  if (!pid) return askId();
  const existing = await get("session", pid);
  S = existing || newSession(pid);
  if (existing && Object.keys(existing.done).length) return resumeScreen();
  welcome();
}

function askId() {
  screen(`<h1>Voice recording</h1><p>Enter the participant ID you were given (for example P07).</p>
    <input id="pid" autocapitalize="characters" placeholder="P07"><button id="go" class="primary">Continue</button>`);
  on("#go", () => {
    const v = $("#pid").value.trim().toUpperCase();
    if (v) { params.set("id", v); history.replaceState(null, "", `?${params}`); start(); }
  });
}

function resumeScreen() {
  const n = Object.keys(S.done).length;
  screen(`<h1>Welcome back, ${esc(S.pid)}</h1><p>${n} of ${CLIPS.length} recordings are saved on this phone. You can pick up where you left off.</p>
    <button id="cont" class="primary">Continue</button><button id="restart" class="quiet">Start over (deletes them)</button>`);
  on("#cont", () => micCheck(() => routeNext()));
  on("#restart", async () => {
    if (!confirm("Delete all recordings for this ID on this phone and start over?")) return;
    for (const c of CLIPS) await del("clips", keyOf(c.key));
    S = newSession(S.pid); await save(); welcome();
  });
}

function welcome() {
  screen(`<h1>Voice recording</h1>
    <p>Participant <strong>${esc(S.pid)}</strong>. This takes about 20 minutes and records you reading short messages in three voices: normal, whispered, and quiet. The last part is read from across the room.</p>
    <p>Everything stays on this phone until you send it yourself at the end. Nothing is uploaded by this page.</p>
    <p>Your recordings are private: they're used only for this research and are never posted or shared publicly.</p>
    <p>You'll need a quiet room, a table, and 1.5 to 2 metres of space.</p>
    ${DEMO ? `<p class="warn">Demo mode: synthetic audio, no microphone.</p>` : ""}
    <button id="go" class="primary">Start</button>`);
  on("#go", consent);
}

function consent() {
  screen(`<h1>Consent</h1>
    <label class="check"><input type="checkbox" id="c1"> <span>${esc(CONSENT.required)}</span></label>
    <button id="go" class="primary" disabled>Continue</button>`);
  $("#c1").addEventListener("change", (e) => ($("#go").disabled = !e.target.checked));
  on("#go", async () => {
    S.consent = { version: CONFIG.consentVersion, use: true, publicRelease: false, text: CONSENT, at: new Date().toISOString() };
    await save(); details();
  });
}

function details() {
  const sel = (id, label, opts) => `<label>${label}<select id="${id}"><option value="">Prefer not to say</option>${opts.map((o) => `<option>${o}</option>`).join("")}</select></label>`;
  screen(`<h1>About you <span class="muted">(optional)</span></h1>
    ${sel("sex", "Sex", ["Female", "Male", "Other"])}
    ${sel("age", "Age", ["18–29", "30–44", "45–59", "60+"])}
    <label>First language<input id="lang" placeholder="e.g. English"></label>
    <label>Accent or region<input id="accent" placeholder="e.g. Southern California"></label>
    <label>Room<select id="floor"><option value="">—</option><option>Carpet</option><option>Hard floor</option></select></label>
    <label>Rough room size (m)<input id="room" placeholder="e.g. 4 × 3"></label>
    <button id="go" class="primary">Continue</button>`);
  on("#go", async () => {
    S.details = { sex: $("#sex").value, ageBand: $("#age").value, firstLanguage: $("#lang").value, accent: $("#accent").value,
      floor: $("#floor").value, roomSize: $("#room").value };
    await save(); setup();
  });
}

function setup() {
  screen(`<h1>Before you start</h1><ul class="steps">
    <li>Turn on <strong>Do Not Disturb</strong> and turn off notification sounds.</li>
    <li>Take off any case that covers the bottom edge of the phone (the microphone is there).</li>
    <li>Turn off fans, the TV, and anything humming; close the window.</li>
    <li>Hold the phone like a voice note: <strong>bottom edge toward your mouth, 10 to 20 cm away</strong>, fingers clear of the bottom edge.</li>
    <li>Keep this page open the whole time. Leaving it or locking the screen stops the recording.</li></ul>
    <button id="go" class="primary">Turn on the microphone</button>`);
  on("#go", () => micCheck(() => routeNext()));
}

async function micCheck(then) {
  try {
    if (!engine.ctx) await engine.init();
  } catch (e) {
    return screen(`<h1>Microphone unavailable</h1><p class="warn">${esc(e.message || e)}</p>
      <p>Allow microphone access for this page (Settings → Safari → Microphone), then reload.</p>`);
  }
  S.settings = engine.settings; await save(); keepAwake();
  screen(`<h1>Microphone check</h1><p>Say one sentence in your normal voice. The bar should move well past the middle without staying at the far right.</p>
    ${meter()}<p class="muted">${esc(describeSettings(engine.settings))}</p><button id="go" class="primary">Sounds good</button>`);
  on("#go", then);
}

function describeSettings(s) {
  if (!s) return "";
  if (s.demo) return "Demo input";
  const off = ["echoCancellation", "noiseSuppression", "autoGainControl"].filter((k) => s[k] === false).length;
  return `${off} of 3 voice-processing features confirmed off · ${Math.round(s.sampleRate || s.contextRate)} Hz`;
}

function routeNext() {
  const c = nextPending();
  if (!c) return review();
  const take = TAKES.find((t) => t.id === c.take);
  const first = take.mode !== "clip" || take.clips[0].id === c.clipId;
  if (first) return takeIntro(take);
  if (take.mode === "clip") return clipScreen(take, take.clips.findIndex((x) => x.id === c.clipId));
}

function takeIntro(take) {
  const idx = TAKES.indexOf(take) + 1;
  screen(`<p class="muted">Part ${idx} of ${TAKES.length}</p><h1>${esc(take.title)}</h1>${voiceCard(take.voice)}<p>${esc(take.intro)}</p>
    <button id="go" class="primary">Begin</button>`);
  on("#go", () => (take.mode === "silence" ? silenceScreen(take) : take.mode === "far" ? farSetup(take) : clipScreen(take, 0)));
}

// ---------- W0: room noise floor ----------

function silenceScreen(take) {
  screen(`<h1>Room check</h1><p>Hold the phone in position. When you tap Start, stay silent until the timer ends.</p>
    ${meter()}<div class="big" id="count">${take.seconds}</div><button id="go" class="primary">Start</button>`);
  on("#go", async () => {
    $("#go").disabled = true;
    recordingActive = true; interrupted = false;
    engine.demoSpeech?.(false);
    engine.start();
    for (let s = take.seconds; s > 0; s--) { $("#count").textContent = s; await sleep(1000); }
    const raw = await engine.stop();
    engine.demoSpeech?.(true);
    recordingActive = false;
    if (interrupted) return interruptedScreen(() => silenceScreen(take));
    const x = resample(raw.samples, raw.rate);
    const st = levelStats(x);
    S.floorDb = st.rmsDb;
    await storeClip({ take: "W0", clipId: "room", key: "W0_room", voice: null, text: "" }, x, raw.rate, []);
    const noisy = st.rmsDb > LIMITS.roomNoisyDb;
    screen(`<h1>${noisy ? "This room is a bit noisy" : "The room is quiet enough"}</h1>
      <p>Background level: ${st.rmsDb.toFixed(0)} dBFS${noisy ? `. Whispers may get lost. Try turning off fans or moving somewhere quieter, then check again.` : "."}</p>
      ${noisy ? `<button id="again" class="primary">Check again</button><button id="go" class="quiet">Continue anyway</button>` : `<button id="go" class="primary">Continue</button>`}`);
    on("#again", async () => { delete S.done.W0_room; await save(); silenceScreen(take); });
    on("#go", routeNext);
  });
}

// ---------- W1–W5: one clip per screen ----------

function clipScreen(take, i) {
  const clip = take.clips[i];
  const key = `${take.id}_${clip.id}`;
  const lines = clip.lines.map((l) => `<p class="read">${esc(l)}</p>`).join("");
  screen(`<p class="muted">${esc(take.title)} · ${i + 1} of ${take.clips.length}</p>${voiceCard(take.voice)}
    <div class="script">${lines}</div>${meter()}
    <div class="cue" id="cue"></div>
    <button id="rec" class="primary">Record</button>`);
  on("#rec", async () => {
    const btn = $("#rec");
    if (!recordingActive) {
      recordingActive = true; interrupted = false;
      engine.start();
      btn.disabled = true;
      $("#cue").textContent = "…";
      await sleep(500);
      $("#cue").textContent = take.voice === "whisper" ? "Whisper now" : "Speak now";
      btn.textContent = "Done";
      btn.disabled = false;
      return;
    }
    btn.disabled = true;
    $("#cue").textContent = "";
    await sleep(500);
    const raw = await engine.stop();
    recordingActive = false;
    if (interrupted) return interruptedScreen(() => clipScreen(take, i));
    const x = resample(raw.samples, raw.rate);
    const st = { ...levelStats(x), activeLevelDb: activeDb(x) };
    const flags = clipFlags(st, { voice: take.voice, floorDb: S.floorDb, normalDb: S.normalDb });
    await storeClip({ take: take.id, clipId: clip.id, key, voice: take.voice, text: clip.text }, x, raw.rate, flags, st);
    if (take.voice === "normal" && take.id === "W1" && !flags.length) S.normalDb = S.normalDb ?? st.activeLevelDb;
    await save();
    clipResult(take, i, key, flags);
  });
}

function clipResult(take, i, key, flags) {
  const last = i === take.clips.length - 1;
  screen(`<h1>${flags.length ? "Have a listen" : "Got it"}</h1>
    ${flags.length ? `<p class="warn">${flags.map(esc).join("<br>")}</p>` : ""}
    <button id="play" class="quiet">Play it back</button>
    <button id="next" class="primary">${last ? "Next part" : "Next"}</button>
    <button id="redo" class="quiet">Record again</button>`);
  on("#play", () => playClip(key));
  on("#redo", async () => { delete S.done[key]; S.redos = (S.redos || 0) + 1; await save(); clipScreen(take, i); });
  on("#next", routeNext);
}

// ---------- W6: hands-free far take ----------

function farSetup(take) {
  screen(`<h1>From across the room</h1>${voiceCard("far")}
    <p>Lay the phone flat on the table, screen up, bottom edge toward where you'll sit. Measure from your mouth to the phone.</p>
    <label>Distance, mouth to phone (metres)<input id="dist" inputmode="decimal" placeholder="1.8"></label>
    <p>When you tap Start you'll have 10 seconds to walk over. A beep starts the recording; the messages then appear one at a time. A second beep means you're done: walk back and wait for the screen to say finished.</p>
    <button id="go" class="primary" disabled>Start</button>`);
  $("#dist").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value.replace(",", "."));
    $("#go").disabled = !(v >= 0.5 && v <= 5);
  });
  on("#go", () => farRun(take, parseFloat($("#dist").value.replace(",", "."))));
}

async function farRun(take, distance) {
  app.innerHTML = `<div class="far"><div class="far-count" id="fc">10</div><div class="far-text" id="ft">Walk to your spot</div></div>`;
  for (let s = 10; s > 0; s--) { $("#fc").textContent = s; await sleep(1000); }
  recordingActive = true; interrupted = false;
  engine.start();
  const t0 = performance.now();
  const at = () => (performance.now() - t0) / 1000;
  await sleep(300);
  const beeps = [at()];
  engine.beep(1000);
  await sleep(1500);
  $("#fc").textContent = "";
  const shown = [];
  for (const c of take.clips) {
    $("#ft").textContent = c.text;
    const start = at();
    await sleep(farSeconds(c.text) * 1000);
    shown.push({ id: c.id, start: +start.toFixed(3), end: +at().toFixed(3) });
    $("#ft").textContent = "";
    await sleep(1500);
  }
  beeps.push(at());
  engine.beep(1500);
  $("#ft").textContent = "Done: walk back to the phone";
  await sleep(3000);
  const raw = await engine.stop();
  recordingActive = false;
  if (interrupted) return interruptedScreen(() => farSetup(take));
  screen(`<h1>Processing…</h1>`);
  await sleep(50);
  const x = resample(raw.samples, raw.rate);
  const st = { ...levelStats(x), activeLevelDb: activeDb(x) };
  S.far = { distanceM: distance, beepsS: beeps.map((b) => +b.toFixed(3)), sentencesS: shown };
  await storeClip({ take: take.id, clipId: "take", key: `${take.id}_take`, voice: "far", text: take.clips.map((c) => c.text).join(" ") }, x, raw.rate, [], st);
  await save();
  screen(`<h1>Finished</h1><button id="play" class="quiet">Play it back</button><button id="next" class="primary">Continue</button>
    <button id="redo" class="quiet">Record this part again</button>`);
  on("#play", () => playClip(`${take.id}_take`));
  on("#redo", async () => { delete S.done[`${take.id}_take`]; S.far = null; await save(); farSetup(take); });
  on("#next", routeNext);
}

function interruptedScreen(retry) {
  S.interruptions++; save();
  screen(`<h1>The recording was interrupted</h1><p>The page left the screen or the phone locked, so that recording is incomplete. Please do it again.</p>
    <button id="go" class="primary">Try again</button>`);
  on("#go", retry);
}

// ---------- storage of clips ----------

async function storeClip(c, x, nativeRate, flags, st = null) {
  const wav = encodeWav(x, OUT_RATE);
  await put("clips", keyOf(c.key), wav);
  const stats = st || { ...levelStats(x), activeLevelDb: activeDb(x) };
  S.done[c.key] = { take: c.take, clipId: c.clipId, voice: c.voice, text: c.text, recordedAt: new Date().toISOString(),
    seconds: +stats.seconds.toFixed(2), peakDb: +stats.peakDb.toFixed(1), rmsDb: +stats.rmsDb.toFixed(1),
    activeDb: +(stats.activeLevelDb ?? stats.rmsDb).toFixed(1), flags, nativeRate };
  await save();
}

let player = null;
async function playClip(key) {
  const wav = await get("clips", keyOf(key));
  if (!wav) return;
  player?.pause();
  player = new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
  player.play();
}

// ---------- review and finish ----------

function review() {
  const rows = CLIPS.map((c) => {
    const d = S.done[c.key];
    const f = d?.flags?.length ? `<span class="flag">${d.flags.map(esc).join("; ")}</span>` : "";
    return `<li><span>${esc(c.take)} · ${esc(c.clipId)}</span>${f}<span class="row-btns"><button data-play="${c.key}" class="mini">Play</button><button data-redo="${c.key}" class="mini">Redo</button></span></li>`;
  }).join("");
  screen(`<h1>All done</h1><p>Every recording is saved on this phone. Anything flagged is worth a listen. To record one again, tap Redo; otherwise, send everything.</p>
    <ul class="review">${rows}</ul><button id="go" class="primary">Prepare to send</button>`);
  app.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", () => playClip(b.dataset.play)));
  app.querySelectorAll("[data-redo]").forEach((b) =>
    b.addEventListener("click", async () => {
      delete S.done[b.dataset.redo];
      if (b.dataset.redo === "W6_take") S.far = null;
      if (b.dataset.redo === "W0_room") S.floorDb = null;
      await save();
      routeNext();
    }));
  on("#go", finish);
}

async function buildZip() {
  const files = [];
  for (const c of CLIPS) {
    const wav = await get("clips", keyOf(c.key));
    if (wav) files.push({ name: `clips/${c.key}.wav`, data: new Uint8Array(wav) });
  }
  const manifest = {
    participant: S.pid, protocol: CONFIG.protocolVersion, createdAt: new Date().toISOString(), startedAt: S.startedAt,
    consent: S.consent, details: S.details, userAgent: navigator.userAgent, demo: DEMO,
    audio: { sampleRate: OUT_RATE, format: "wav pcm16 mono", capture: S.settings },
    roomFloorDb: S.floorDb, far: S.far, interruptions: S.interruptions, redos: S.redos || 0,
    clips: CLIPS.filter((c) => S.done[c.key]).map((c) => ({ file: `clips/${c.key}.wav`, ...S.done[c.key] })),
  };
  files.unshift({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return new File([makeZip(files)], `${S.pid}.zip`, { type: "application/zip" });
}

async function finish() {
  screen(`<h1>Preparing…</h1>`);
  const file = await buildZip();
  const mb = (file.size / 1e6).toFixed(1);
  const canShare = navigator.canShare?.({ files: [file] });
  const subject = `Voice recordings ${S.pid}`;
  screen(`<h1>Send your recordings</h1><p>Your file is <strong>${esc(file.name)}</strong> (${mb} MB).</p>
    ${canShare ? `<p>Tap <strong>Send</strong>, choose <strong>Mail</strong>, and send it to <strong>${esc(CONFIG.recipient)}</strong> with the subject “${esc(subject)}”. AirDrop or Drive work too.</p><button id="share" class="primary">Send</button>` : `<p>Save the file, then email it as an attachment to <strong>${esc(CONFIG.recipient)}</strong> with the subject “${esc(subject)}”.</p>`}
    <button id="save" class="${canShare ? "quiet" : "primary"}">Save a copy</button>
    <p class="muted">If your email won't send a ${mb} MB attachment, reply to Luke and he'll send a link to upload it instead.</p>
    <p class="muted">The recordings stay on this phone until you clear this site's data in Safari.</p>`);
  on("#share", async () => {
    try { await navigator.share({ files: [file], title: subject, text: `${subject}. Please send to ${CONFIG.recipient}.` }); } catch {}
  });
  on("#save", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  });
}

window.addEventListener("error", (e) => {
  console.error(e.error || e.message);
});

start();
