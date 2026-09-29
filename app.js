import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, push, set, update, onValue, onChildAdded,
  query, limitToLast, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { sfx } from "./sfx.js";

/* ============ Constantes ============ */
const NAME_KEY = "livechat:name";
const MAX_MSG = 500;
const NAME_RE = /^[\p{L}\p{N} _.\-]{2,20}$/u;
const MIN_INTERVAL = 1000;   // 1 message / seconde max
const BURST_MAX = 5;         // 5 messages…
const BURST_WINDOW = 10000;  // …par fenêtre de 10 s
const DUP_WINDOW = 30000;    // pas 2 fois le même message en 30 s
const EMOJIS = ["😀","😂","😍","😎","🤔","😅","😭","😡","🥳","🙌","👍","👎","👏","🙏","💪","🔥",
                "✨","💯","❤️","💜","🎉","🚀","👀","😴","🤝","😬","🤯","😇","🙃","😉","😋","🤗",
                "😢","🤟","😌","💬","🎧","🎮","☕","🍕","🌍","⭐","🌈","🎂"];

/* ============ DOM ============ */
const $ = (id) => document.getElementById(id);
const el = {
  login: $("login"), loginForm: $("login-form"), loginName: $("login-name"),
  loginError: $("login-error"), loginCancel: $("login-cancel"),
  app: $("app"), messages: $("messages"), empty: $("empty"), jump: $("jump"),
  composer: $("composer"), input: $("input"), send: $("send"), counter: $("counter"),
  status: $("status"), onlineBtn: $("online-btn"), onlineCount: $("online-count"),
  onlinePanel: $("online-panel"), onlineList: $("online-list"),
  renameBtn: $("rename-btn"), meName: $("me-name"), toast: $("toast"),
  soundBtn: $("sound-btn"), emojiBtn: $("emoji-btn"),
  emojiPanel: $("emoji-panel"), emojiGrid: $("emoji-grid"),
};

/* ============ État ============ */
let db = null;
let uid = null;
let myName = "";
let chatStarted = false;
let historyLoaded = false;
let authPromise = null;
let lastDay = null;
let hasMessages = false;
let unread = 0;
const baseTitle = document.title;
const recent = []; // {t, text} des messages que j'ai envoyés

/* ============ Utilitaires ============ */
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};

const cleanName = (s) => s.replace(/\s+/g, " ").trim();

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

function dayLabel(ts) {
  const d = new Date(ts), today = new Date(), y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === y.toDateString()) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

function hueOf(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 360;
}

const initialOf = (s) => (Array.from(s.trim())[0] || "?").toUpperCase();

let toastTimer;
function showToast(msg, isError = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle("error", isError);
  el.toast.classList.add("show");
  if (isError) sfx.play("error");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 3200);
}

const showLoginError = (m) => { el.loginError.textContent = m; el.loginError.hidden = false; };
const hideLoginError = () => { el.loginError.hidden = true; };

/* ============ Firebase ============ */
function configIsMissing(c) {
  return !c.apiKey || /COLLE_ICI|TON-PROJET/.test(JSON.stringify(c));
}

if (configIsMissing(firebaseConfig)) {
  showLoginError("Configuration Firebase manquante : édite le fichier firebase-config.js.");
  el.loginForm.querySelector("button[type=submit]").disabled = true;
} else {
  const fbApp = initializeApp(firebaseConfig);
  db = getDatabase(fbApp);
  authPromise = signInAnonymously(getAuth(fbApp)).then((cred) => { uid = cred.user.uid; });
  authPromise.catch((e) => console.error("Auth anonyme :", e));
}

/* ============ Bouton son ============ */
function renderSound() {
  const on = sfx.enabled;
  el.soundBtn.querySelector(".ic-on").hidden = !on;
  el.soundBtn.querySelector(".ic-off").hidden = on;
  el.soundBtn.setAttribute("aria-pressed", String(on));
  el.soundBtn.title = on ? "Couper les sons" : "Activer les sons";
}
el.soundBtn.addEventListener("click", () => { sfx.toggle(); renderSound(); });
renderSound();

/* ============ Pseudo / connexion ============ */
el.loginName.value = store.get(NAME_KEY) || "";

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  sfx.unlock();
  const name = cleanName(el.loginName.value);
  if (!NAME_RE.test(name)) {
    sfx.play("error");
    return showLoginError("Pseudo invalide : 2 à 20 caractères (lettres, chiffres, espace, _ . -).");
  }
  hideLoginError();
  try {
    await authPromise;
  } catch {
    sfx.play("error");
    return showLoginError("Connexion impossible. Vérifie que la connexion anonyme est activée dans Firebase.");
  }
  myName = name;
  store.set(NAME_KEY, name);
  el.meName.textContent = name;
  el.login.hidden = true;
  el.app.hidden = false;
  el.loginCancel.hidden = false;
  if (!chatStarted) { sfx.play("welcome"); startChat(); }
  else { sfx.play("click"); publishPresence(); }
  el.input.focus();
});

el.renameBtn.addEventListener("click", () => {
  sfx.play("click");
  el.loginName.value = myName;
  hideLoginError();
  el.login.hidden = false;
  el.loginName.focus();
  el.loginName.select();
});
el.loginCancel.addEventListener("click", () => { sfx.play("click"); el.login.hidden = true; });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && chatStarted) {
    el.login.hidden = true; el.onlinePanel.hidden = true; el.emojiPanel.hidden = true;
  }
});

/* ============ Démarrage du chat ============ */
function startChat() {
  chatStarted = true;

  onValue(ref(db, ".info/connected"), (snap) => {
    const on = snap.val() === true;
    el.status.textContent = on ? "En ligne" : "Reconnexion…";
    el.status.dataset.on = String(on);
    if (on) {
      onDisconnect(ref(db, `presence/${uid}`)).remove()
        .then(publishPresence)
        .catch((err) => console.error("Présence :", err));
    }
  });

  watchPresence();
  watchMessages();
}

function publishPresence() {
  return set(ref(db, `presence/${uid}`), { name: myName, ts: serverTimestamp() })
    .catch((err) => console.error("Présence :", err));
}

/* ============ Présence : compteur, liste, notifications ============ */
let prevUsers = null;

function watchPresence() {
  onValue(ref(db, "presence"), (snap) => {
    const val = snap.val() || {};
    const users = Object.entries(val).filter(([, u]) => u && typeof u.name === "string");

    el.onlineCount.textContent = users.length;
    el.onlineList.replaceChildren(...users.map(([id, u]) => {
      const li = document.createElement("li");
      const d = document.createElement("span");
      d.className = "dot";
      const t = document.createElement("span");
      t.textContent = u.name + (id === uid ? " (toi)" : ""); // textContent : pas de HTML interprété
      li.append(d, t);
      return li;
    }));

    if (prevUsers) {
      for (const [id, u] of users) {
        if (id === uid) continue;
        if (!prevUsers[id]) { addSystem(`${u.name} est en ligne`); sfx.play("join"); }
        else if (prevUsers[id].name !== u.name) addSystem(`${prevUsers[id].name} est maintenant ${u.name}`);
      }
      for (const id of Object.keys(prevUsers)) {
        if (id !== uid && !val[id]) { addSystem(`${prevUsers[id].name} s'est déconnecté`); sfx.play("leave"); }
      }
    }
    prevUsers = Object.fromEntries(users.map(([id, u]) => [id, { name: u.name }]));
  }, (err) => console.error("Présence :", err));
}

el.onlineBtn.addEventListener("click", () => {
  el.onlinePanel.hidden = !el.onlinePanel.hidden;
  sfx.play("click");
});
document.addEventListener("click", (e) => {
  if (!el.onlinePanel.hidden && !el.onlinePanel.contains(e.target) && !el.onlineBtn.contains(e.target)) {
    el.onlinePanel.hidden = true;
  }
  if (!el.emojiPanel.hidden && !el.emojiPanel.contains(e.target) && !el.emojiBtn.contains(e.target)) {
    el.emojiPanel.hidden = true;
  }
});

/* ============ Messages : réception ============ */
function watchMessages() {
  const q = query(ref(db, "messages"), limitToLast(100));
  const seen = new Set();

  onChildAdded(q, (snap) => {
    if (seen.has(snap.key)) return;
    seen.add(snap.key);
    addMessage(snap.val());
  }, (err) => {
    console.error("Lecture messages :", err);
    showToast("Lecture impossible : vérifie les règles de sécurité Firebase.", true);
  });

  // Se déclenche une fois l'historique initial entièrement reçu
  onValue(q, () => {
    historyLoaded = true;
    if (!hasMessages) el.empty.textContent = "Aucun message pour l'instant. Lance la conversation 👋";
    scrollToBottom(false);
  }, { onlyOnce: true });
}

/* ============ Rendu ============ */
function isNearBottom() {
  const m = el.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
}

function scrollToBottom(smooth = true) {
  el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  el.jump.hidden = true;
}

function append(node, forceScroll = false) {
  const stick = isNearBottom() || forceScroll;
  el.messages.appendChild(node);
  if (!historyLoaded) return; // l'historique est scrollé une seule fois à la fin
  if (stick) scrollToBottom(true); else el.jump.hidden = false;
}

function addSystem(text) {
  const d = document.createElement("div");
  d.className = "sys";
  d.textContent = text;
  append(d);
}

function addMessage(m) {
  if (!m || typeof m.text !== "string" || typeof m.name !== "string") return;
  const ts = Number(m.ts) || Date.now();
  const mine = m.uid === uid;
  const hue = hueOf(m.name);

  if (!hasMessages) { hasMessages = true; el.empty.remove(); }

  const day = new Date(ts).toDateString();
  if (day !== lastDay) { lastDay = day; addSystem(dayLabel(ts)); }

  const row = document.createElement("div");
  row.className = `row ${mine ? "me" : "other"}${historyLoaded ? " pop" : ""}`;

  if (!mine) {
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = initialOf(m.name);                         // ← protection XSS
    av.style.background = `linear-gradient(135deg, hsl(${hue} 75% 58%), hsl(${(hue + 45) % 360} 75% 48%))`;
    row.append(av);
  }

  const col = document.createElement("div");
  col.className = "col";

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = m.name;                                    // ← protection XSS
  name.style.color = `hsl(${hue} 80% 74%)`;
  const time = document.createElement("time");
  time.textContent = fmtTime(ts);
  meta.append(name, time);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = m.text;                                  // ← protection XSS

  col.append(meta, bubble);
  row.append(col);
  append(row, mine);

  // Son + compteur de non-lus pour les messages des autres (hors historique)
  if (!mine && historyLoaded) {
    sfx.play("receive");
    if (document.hidden) { unread++; document.title = `(${unread}) ${baseTitle}`; }
  }
}

el.messages.addEventListener("scroll", () => { if (isNearBottom()) el.jump.hidden = true; });
el.jump.addEventListener("click", () => { sfx.play("click"); scrollToBottom(true); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { unread = 0; document.title = baseTitle; }
});

/* ============ Emojis ============ */
el.emojiGrid.replaceChildren(...EMOJIS.map((emo) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = emo;
  b.setAttribute("aria-label", emo);
  b.addEventListener("click", () => { insertAtCursor(emo); sfx.play("pop"); });
  return b;
}));

el.emojiBtn.addEventListener("click", () => {
  el.emojiPanel.hidden = !el.emojiPanel.hidden;
  sfx.play("click");
});

function insertAtCursor(txt) {
  const i = el.input;
  const s = i.selectionStart ?? i.value.length;
  const e = i.selectionEnd ?? s;
  const next = i.value.slice(0, s) + txt + i.value.slice(e);
  if (next.length > MAX_MSG) return;
  i.value = next;
  const p = s + txt.length;
  i.setSelectionRange(p, p);
  syncComposer();
  i.focus();
}

/* ============ Saisie : compteur + bouton ============ */
function syncComposer() {
  const left = MAX_MSG - el.input.value.length;
  el.send.disabled = el.input.value.trim() === "";
  el.counter.hidden = left > 100;
  el.counter.textContent = left;
  el.counter.classList.toggle("warn", left <= 20);
}
el.input.addEventListener("input", syncComposer);

/* ============ Envoi + anti-spam ============ */
function checkSpam(text) {
  const now = Date.now();
  while (recent.length && now - recent[0].t > DUP_WINDOW) recent.shift();
  const last = recent[recent.length - 1];
  if (last && now - last.t < MIN_INTERVAL) return "Doucement ! Attends une seconde entre deux messages.";
  if (recent.filter((m) => now - m.t < BURST_WINDOW).length >= BURST_MAX) return "Trop de messages d'affilée. Patiente quelques secondes.";
  if (recent.some((m) => m.text === text)) return "Tu as déjà envoyé ce message récemment.";
  return null;
}

el.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!db || !uid) return;
  const text = el.input.value.trim().slice(0, MAX_MSG);
  if (!text) return;

  const problem = checkSpam(text);
  if (problem) return showToast(problem, true);

  recent.push({ t: Date.now(), text });
  el.input.value = "";
  syncComposer();
  el.emojiPanel.hidden = true;
  el.input.focus(); // garde le clavier ouvert sur mobile
  sfx.play("send");

  try {
    const key = push(ref(db, "messages")).key;
    // Écriture atomique : le message + l'horodatage serveur du dernier envoi
    // (utilisé par les règles pour limiter la cadence côté serveur).
    await update(ref(db), {
      [`messages/${key}`]: { uid, name: myName, text, ts: serverTimestamp() },
      [`lastSent/${uid}`]: serverTimestamp(),
    });
  } catch (err) {
    console.error("Envoi :", err);
    if (!el.input.value) { el.input.value = text; syncComposer(); }
    showToast("Message refusé (trop rapide ou problème de connexion).", true);
  }
});
