// Pure audio and file helpers for the recorder. No DOM, no Web Audio: runs in the browser and
// in Node (tests: `node --test recorder/test`).

export const OUT_RATE = 16000;

// ---------- levels ----------

export function levelStats(x) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    sum += x[i] * x[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, x.length));
  return { peakDb: toDb(peak), rmsDb: toDb(rms), seconds: x.length / OUT_RATE };
}

export function toDb(v) {
  return 20 * Math.log10(Math.max(v, 1e-9));
}

// Active level: RMS over the loudest 30% of 20 ms frames, so leading and trailing silence
// doesn't drag the speech level down.
export function activeDb(x, rate = OUT_RATE) {
  const n = Math.round(rate * 0.02);
  const frames = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += x[j] * x[j];
    frames.push(s / n);
  }
  if (!frames.length) return toDb(0);
  frames.sort((a, b) => b - a);
  const top = frames.slice(0, Math.max(1, Math.round(frames.length * 0.3)));
  return toDb(Math.sqrt(top.reduce((a, b) => a + b, 0) / top.length));
}

// ---------- resampling (windowed sinc, Blackman window, precomputed taps) ----------

// Any input rate to OUT_RATE. Cutoff at 95% of the output Nyquist; ~16 zero crossings per side.
// Integer ratios (48 kHz -> 16 kHz, the usual case on phones) use one fixed kernel; other ratios
// use a table of PHASES fractional-delay kernels. No trig in the inner loop.
const PHASES = 512;

function kernel(frac, half, fc) {
  const h = new Float32Array(2 * half);
  let sum = 0;
  for (let j = 0; j < 2 * half; j++) {
    const d = frac + (half - 1 - j); // t - k, with k = floor(t) - half + 1 + j
    const u = d / half;
    let v = 0;
    if (u > -1 && u < 1) {
      const w = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const arg = 2 * fc * d;
      v = 2 * fc * (arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg)) * w;
    }
    h[j] = v;
    sum += v;
  }
  for (let j = 0; j < h.length; j++) h[j] /= sum; // unity DC gain
  return h;
}

export function resample(x, inRate, outRate = OUT_RATE) {
  if (inRate === outRate) return Float32Array.from(x);
  const ratio = inRate / outRate;
  const fc = 0.95 * 0.5 * Math.min(1, outRate / inRate); // cycles per input sample
  const half = Math.ceil(16 / (2 * fc) / 2) * 2; // half-width in input samples
  const nOut = Math.floor(x.length / ratio);
  const y = new Float32Array(nOut);
  const integer = Number.isInteger(ratio);
  const table = integer ? [kernel(0, half, fc)] : Array.from({ length: PHASES }, (_, p) => kernel(p / PHASES, half, fc));
  const L = 2 * half;
  for (let n = 0; n < nOut; n++) {
    const t = n * ratio;
    const base = Math.floor(t);
    const h = integer ? table[0] : table[Math.min(PHASES - 1, Math.round((t - base) * PHASES))];
    const k0 = base - half + 1;
    let acc = 0;
    if (k0 >= 0 && k0 + L <= x.length) {
      for (let j = 0; j < L; j++) acc += x[k0 + j] * h[j];
    } else {
      for (let j = 0; j < L; j++) { const k = k0 + j; if (k >= 0 && k < x.length) acc += x[k] * h[j]; }
    }
    y[n] = acc;
  }
  return y;
}

// ---------- WAV (16-bit PCM, mono) ----------

export function encodeWav(x, rate = OUT_RATE) {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + x.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return new Uint8Array(buf);
}

export function decodeWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = v.getUint32(24, true);
  const n = v.getUint32(40, true) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = v.getInt16(44 + i * 2, true);
    x[i] = s < 0 ? s / 32768 : s / 32767;
  }
  return { rate, samples: x };
}

// ---------- ZIP (store, no compression: WAV barely compresses) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{name, data: Uint8Array}] -> Uint8Array (a valid .zip)
export function makeZip(files, date = new Date()) {
  const enc = new TextEncoder();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, day, true);
    local.setUint32(14, crc, true); local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true); cd.setUint16(12, time, true);
    cd.setUint16(14, day, true); cd.setUint32(16, crc, true); cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true); cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// Minimal reader for tests and the review screen: [{name, data}]
export function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i++) {
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = v.getUint16(local + 26, true);
    const lExtra = v.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtra;
    out.push({ name, data: bytes.subarray(start, start + size), crc: v.getUint32(p + 16, true) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

// ---------- quality flags ----------

export const LIMITS = {
  roomNoisyDb: -50, // W0 RMS above this: too noisy for whispers
  clippedDb: -1, // peak at or above this: clipped
  minSpeechOverFloorDb: 6, // active level must clear the room floor by this much
  minSeconds: 1.0,
  whisperLouderThanNormalDb: -3, // a "whisper" within 3 dB of normal speech is suspicious
};

export function clipFlags({ seconds, peakDb, activeLevelDb }, { voice, floorDb, normalDb }) {
  const flags = [];
  if (seconds < LIMITS.minSeconds) flags.push("too short");
  if (peakDb >= LIMITS.clippedDb) flags.push("clipped");
  if (floorDb != null && activeLevelDb - floorDb < LIMITS.minSpeechOverFloorDb) flags.push("too quiet");
  if (voice === "whisper" && normalDb != null && activeLevelDb - normalDb > LIMITS.whisperLouderThanNormalDb)
    flags.push("as loud as normal speech: was it a whisper?");
  return flags;
}

// Seconds a far-take sentence stays on screen: reading pace at a distance plus a gap.
export function farSeconds(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.round((2.0 + words * 0.45) * 10) / 10;
}
