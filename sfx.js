// Effets sonores synthétisés avec la Web Audio API : aucun fichier audio requis.
const KEY = "livechat:sound";

let ctx = null;
let master = null;
let noiseBuf = null;
let unlocked = false;
let enabled = readPref() !== "off";
const lastPlayed = {};

function readPref() { try { return localStorage.getItem(KEY); } catch { return null; } }
function writePref(v) { try { localStorage.setItem(KEY, v); } catch { /* ignoré */ } }

/* ---------- Contexte audio (créé après un geste utilisateur) ---------- */
function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.6;
    const comp = ctx.createDynamicsCompressor(); // évite les saturations
    master.connect(comp);
    comp.connect(ctx.destination);

    // Bruit blanc pré-calculé pour les "whoosh"
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

const GESTURES = ["pointerdown", "keydown", "touchend"];
function unlock() {
  if (unlocked) return;
  if (!ensure()) return;
  unlocked = true;
  GESTURES.forEach((ev) => window.removeEventListener(ev, unlock));
}
GESTURES.forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));

/* ---------- Briques de base ---------- */
function tone({ freq, to = null, start = 0, dur = 0.15, type = "sine", vol = 0.2, attack = 0.006 }) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function whoosh({ start = 0, dur = 0.16, vol = 0.1, from = 700, to = 3200, q = 1.1 }) {
  const t0 = ctx.currentTime + start;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t0);
  f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.03);
}

/* ---------- Catalogue de sons ---------- */
const SOUNDS = {
  // Message envoyé : petit whoosh montant
  send() {
    whoosh({ dur: 0.17, vol: 0.09, from: 600, to: 3400 });
    tone({ freq: 520, to: 980, dur: 0.13, vol: 0.1, type: "sine" });
  },
  // Message reçu : carillon à deux notes
  receive() {
    tone({ freq: 784, dur: 0.22, vol: 0.16 });                         // sol5
    tone({ freq: 1175, start: 0.09, dur: 0.32, vol: 0.13 });           // ré6
    tone({ freq: 2349, start: 0.09, dur: 0.18, vol: 0.03 });           // harmonique
  },
  // Un utilisateur arrive : trois notes montantes
  join() {
    [523, 659, 784].forEach((f, i) => tone({ freq: f, start: i * 0.08, dur: 0.16, vol: 0.09, type: "triangle" }));
  },
  // Un utilisateur part : deux notes descendantes
  leave() {
    tone({ freq: 659, dur: 0.14, vol: 0.08, type: "triangle" });
    tone({ freq: 440, start: 0.09, dur: 0.2, vol: 0.08, type: "triangle" });
  },
  // Erreur / refus : petit "bonk" grave
  error() {
    tone({ freq: 220, to: 120, dur: 0.24, vol: 0.2, type: "triangle" });
    tone({ freq: 165, to: 100, start: 0.05, dur: 0.22, vol: 0.1, type: "sine" });
  },
  // Clic d'interface
  click() {
    tone({ freq: 900, to: 700, dur: 0.05, vol: 0.07, type: "triangle", attack: 0.003 });
  },
  // Sélection d'emoji
  pop() {
    tone({ freq: 500, to: 1300, dur: 0.07, vol: 0.09, type: "sine", attack: 0.003 });
  },
  // Entrée dans le chat : arpège lumineux
  welcome() {
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, start: i * 0.07, dur: 0.32, vol: 0.09 }));
    whoosh({ dur: 0.3, vol: 0.05, from: 400, to: 2600 });
  },
};

// Délai minimum entre deux lectures d'un même son (anti-mitraillette)
const MIN_GAP = { receive: 150, join: 500, leave: 500, error: 300, click: 40, pop: 30 };

export const sfx = {
  get enabled() { return enabled; },

  play(name) {
    if (!enabled || !unlocked || !ctx || ctx.state === "closed") return;
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < (MIN_GAP[name] || 0)) return;
    lastPlayed[name] = now;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    try { SOUNDS[name]?.(); } catch (e) { console.warn("SFX :", e); }
  },

  setEnabled(on) {
    enabled = !!on;
    writePref(enabled ? "on" : "off");
    if (enabled) { unlock(); ensure(); this.play("click"); }
  },

  toggle() { this.setEnabled(!enabled); return enabled; },

  unlock,
};
