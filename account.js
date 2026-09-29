// Comptes : connexion obligatoire, création de compte, vérification email, profil + photo.
import {
  GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { ref, get, update, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const NAME_RE = /^[\p{L}\p{N} _.\-]{2,20}$/u;
const EMAIL_KEY = "livechat:emailForSignIn";
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* indisponible */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* indisponible */ } },
};
const ERRORS = {
  "auth/invalid-credential": "Email ou mot de passe incorrect.",
  "auth/wrong-password": "Email ou mot de passe incorrect.",
  "auth/user-not-found": "Email ou mot de passe incorrect.",
  "auth/email-already-in-use": "Un compte existe déjà avec cet email : connecte-toi.",
  "auth/weak-password": "Mot de passe trop faible (6 caractères minimum).",
  "auth/invalid-email": "Adresse email invalide.",
  "auth/too-many-requests": "Trop de tentatives. Réessaie dans quelques minutes.",
  "auth/network-request-failed": "Problème de connexion réseau.",
  "auth/operation-not-allowed": "Cette méthode n'est pas activée dans la console Firebase.",
  "auth/unauthorized-domain": "Domaine non autorisé : ajoute-le dans Firebase > Authentication > Paramètres > Domaines autorisés.",
  "auth/popup-blocked": "Le navigateur a bloqué la fenêtre de connexion : autorise les pop-ups.",
  "auth/account-exists-with-different-credential": "Un compte existe déjà avec cet email via une autre méthode.",
  "auth/invalid-action-code": "Ce lien a expiré ou a déjà été utilisé.",
};
const SILENT = ["auth/popup-closed-by-user", "auth/cancelled-popup-request"];

let auth, db, onSession, user = null, profile = null, poll = null, draftPhoto = null, mode = "login", flash = "";
const cache = new Map(), watched = new Set();

/* ---------- Utilitaires ---------- */
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; };
const keyOf = (n) => encodeURIComponent(n.toLowerCase()).replace(/\./g, "%2E");

function paint(d, name, photo) {
  const h = hue(name);
  d.replaceChildren();
  if (photo) {
    const i = new Image();
    i.referrerPolicy = "no-referrer"; i.alt = ""; i.src = photo;
    d.style.background = "none"; d.append(i);
  } else {
    d.textContent = (Array.from(name.trim())[0] || "?").toUpperCase();
    d.style.background = `linear-gradient(135deg, hsl(${h} 75% 58%), hsl(${(h + 45) % 360} 75% 48%))`;
  }
}

// Avatar mis à jour en direct dès que la personne change sa photo.
export function avatarNode(uid, name = "?") {
  const d = document.createElement("span");
  d.className = "avatar"; d.dataset.uid = uid; d.dataset.name = name;
  paint(d, name, cache.get(uid)?.photo);
  if (db && !watched.has(uid)) {
    watched.add(uid);
    onValue(ref(db, `users/${uid}`), (s) => {
      const p = s.val(); cache.set(uid, p);
      document.querySelectorAll(`.avatar[data-uid="${uid}"]`).forEach((n) => paint(n, n.dataset.name, p?.photo));
    });
  }
  return d;
}

// Redimensionne + compresse une image en JPEG (data URL). square > 0 : recadrage carré (avatar).
export async function compressImage(file, { max = 1280, square = 0, quality = 0.78 } = {}) {
  if (!file.type.startsWith("image/")) throw { message: "Ce fichier n'est pas une image." };
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw { message: "Image illisible (format non supporté)." }; }
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height, w, h;
  if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; w = h = square; }
  else { const k = Math.min(1, max / Math.max(sw, sh)); w = Math.round(sw * k); h = Math.round(sh * k); }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close?.();
  let data;
  for (const q of [quality, 0.6, 0.45]) { data = c.toDataURL("image/jpeg", q); if (data.length < 550000) break; }
  if (data.length >= 650000) throw { message: "Image trop lourde, même compressée." };
  return { data, w, h };
}

/* ---------- Interface de connexion ---------- */
const gate = document.createElement("div");
gate.className = "login";
gate.innerHTML = '<div class="login-card"></div>';
document.body.append(gate);
const card = gate.firstElementChild;
const $ = (s) => card.querySelector(s);
const MSG = '<p class="error" id="ge" hidden></p><p class="ok-msg" id="gi" hidden></p>';

function say(text = "", ok = false) {
  const e = $("#ge"), i = $("#gi");
  if (!e) return;
  e.hidden = ok || !text; i.hidden = !ok || !text;
  (ok ? i : e).textContent = text;
}

async function run(fn) {
  say(); card.classList.add("busy");
  try { await fn(); }
  catch (e) {
    if (SILENT.includes(e?.code)) return;
    console.error(e);
    say(ERRORS[e?.code] || (/PERMISSION_DENIED/.test(e?.message || "")
      ? "Enregistrement refusé : pseudo déjà pris, ou règles Firebase pas encore publiées."
      : e?.message || "Une erreur est survenue."));
  } finally { card.classList.remove("busy"); }
}

function viewAuth(m = "login") {
  mode = m;
  const su = m === "signup";
  card.innerHTML = `
    <div class="logo">💬</div><h1>Chat mondial</h1>
    <p class="subtitle">${su ? "Crée ton compte pour rejoindre la conversation." : "Connecte-toi pour rejoindre la conversation."}</p>
    <div class="tabs">
      <button type="button" data-m="login" class="${su ? "" : "on"}">Connexion</button>
      <button type="button" data-m="signup" class="${su ? "on" : ""}">Créer un compte</button>
    </div>
    <div class="providers">
      <button type="button" class="btn ghost" data-p="google">Continuer avec Google</button>
      <button type="button" class="btn ghost" data-p="apple">Continuer avec Apple</button>
    </div>
    <div class="sep"><span>ou avec ton email</span></div>
    <form id="af" class="stack">
      <input id="em" type="email" placeholder="Adresse email" autocomplete="email" required>
      <input id="pw" type="password" placeholder="Mot de passe" minlength="6" required autocomplete="${su ? "new-password" : "current-password"}">
      <button class="btn primary" type="submit">${su ? "Créer mon compte" : "Se connecter"}</button>
    </form>
    <div class="links">
      <button type="button" data-a="link">Recevoir un lien de connexion par email</button>
      ${su ? "" : '<button type="button" data-a="reset">Mot de passe oublié ?</button>'}
    </div>${MSG}`;
  if (flash) { say(flash); flash = ""; }
}

function viewVerify() {
  card.innerHTML = `
    <div class="logo">📬</div><h1>Vérifie ton email</h1>
    <p class="subtitle">Un lien de confirmation a été envoyé à <b id="ve"></b>. Clique dessus, puis reviens ici.</p>
    <div class="stack">
      <button type="button" class="btn primary" data-a="checked">J'ai vérifié mon email</button>
      <button type="button" class="btn ghost" data-a="resend">Renvoyer l'email</button>
    </div>
    <div class="links"><button type="button" data-a="logout">Utiliser un autre compte</button></div>${MSG}`;
  $("#ve").textContent = user.email;
  poll = setInterval(() => refreshVerified().catch(() => {}), 4000);
}

function viewProfile(first) {
  draftPhoto = profile?.photo ?? user.photoURL ?? null;
  const guess = (user.displayName || (user.email || "").split("@")[0] || "").replace(/[^\p{L}\p{N} _.\-]/gu, "").slice(0, 20);
  const hasPw = user.providerData.some((p) => p.providerId === "password");
  card.innerHTML = `
    <h1>${first ? "Bienvenue 👋" : "Mon profil"}</h1>
    <p class="subtitle">${first ? "Choisis ton pseudo et ta photo de profil." : "Change ton pseudo ou ta photo."}</p>
    <button type="button" class="pick" data-a="pick" title="Changer la photo"><span id="pv" class="avatar"></span><i>📷</i></button>
    <input id="file" type="file" accept="image/*" hidden>
    <form id="pf" class="stack">
      <input id="pn" type="text" maxlength="20" placeholder="Ton pseudo" required autocomplete="off" spellcheck="false">
      <div class="login-actions">
        ${first ? "" : '<button type="button" class="btn ghost" data-a="close">Annuler</button>'}
        <button class="btn primary" type="submit">Enregistrer</button>
      </div>
    </form>
    <div class="links">
      ${!first && hasPw ? '<button type="button" data-a="reset-me">Changer mon mot de passe (par email)</button>' : ""}
      <button type="button" data-a="logout">Se déconnecter</button>
    </div>${MSG}`;
  $("#pn").value = profile?.name || guess;
  paintPreview();
}
const paintPreview = () => paint($("#pv"), $("#pn").value.trim() || "?", draftPhoto);

/* ---------- Actions ---------- */
const provider = (p) => {
  if (p === "google") return new GoogleAuthProvider();
  const a = new OAuthProvider("apple.com"); a.addScope("email"); a.addScope("name"); return a;
};
const email = () => {
  const i = $("#em");
  if (!i || !i.value || !i.checkValidity()) throw { message: "Entre une adresse email valide." };
  return i.value.trim();
};
async function refreshVerified() { await user.reload(); if (user.emailVerified) route(user); }

const actions = {
  link: () => run(async () => {
    const em = email();
    await sendSignInLinkToEmail(auth, em, { url: location.origin + location.pathname, handleCodeInApp: true });
    ls.set(EMAIL_KEY, em);
    say("Lien envoyé ! Ouvre-le depuis cet appareil pour te connecter (ça crée aussi ton compte).", true);
  }),
  reset: () => run(async () => { await sendPasswordResetEmail(auth, email()); say("Email de réinitialisation envoyé.", true); }),
  "reset-me": () => run(async () => { await sendPasswordResetEmail(auth, user.email); say("Email de réinitialisation envoyé.", true); }),
  resend: () => run(async () => { await sendEmailVerification(user); say("Email renvoyé.", true); }),
  checked: () => run(async () => { await refreshVerified(); if (!user.emailVerified) say("Pas encore vérifié : clique d'abord sur le lien reçu par email."); }),
  pick: () => $("#file").click(),
  close: () => { gate.hidden = true; },
  logout: async () => { clearInterval(poll); await signOut(auth); location.reload(); },
};

card.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const { m, p, a } = b.dataset;
  if (m) { const v = $("#em").value; viewAuth(m); $("#em").value = v; }
  else if (p) run(() => signInWithPopup(auth, provider(p)));
  else if (a) actions[a]?.();
});

card.addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "af") {
    run(async () => {
      const em = $("#em").value.trim(), pw = $("#pw").value;
      if (mode === "signup") { const c = await createUserWithEmailAndPassword(auth, em, pw); await sendEmailVerification(c.user); }
      else await signInWithEmailAndPassword(auth, em, pw);
    });
  } else {
    run(async () => {
      const name = $("#pn").value.replace(/\s+/g, " ").trim();
      if (!NAME_RE.test(name)) throw { message: "Pseudo invalide : 2 à 20 caractères (lettres, chiffres, espace, _ . -)." };
      await saveProfile(name, draftPhoto);
      finish();
    });
  }
});

card.addEventListener("change", (e) => {
  if (e.target.id !== "file" || !e.target.files[0]) return;
  const f = e.target.files[0];
  e.target.value = "";
  run(async () => { draftPhoto = (await compressImage(f, { square: 192, quality: 0.85 })).data; paintPreview(); });
});
card.addEventListener("input", (e) => { if (e.target.id === "pn" && !draftPhoto) paintPreview(); });

/* ---------- Profil + routage ---------- */
async function saveProfile(name, photo) {
  const up = {}, k = keyOf(name), old = profile && keyOf(profile.name);
  if (k !== old) {
    const s = await get(ref(db, `usernames/${k}`));
    if (s.exists() && s.val() !== user.uid) throw { message: "Ce pseudo est déjà pris." };
    up[`usernames/${k}`] = user.uid;
    if (old) up[`usernames/${old}`] = null;
  }
  const next = { name, createdAt: profile?.createdAt || Date.now(), ...(photo && { photo }) };
  up[`users/${user.uid}`] = next;
  await update(ref(db), up); // atomique : pseudo réservé + profil, ou rien
  profile = next;
}

function finish() { gate.hidden = true; onSession(user, profile); }

async function route(u) {
  clearInterval(poll);
  user = u;
  if (u?.isAnonymous) { await signOut(auth); return; } // les anciennes sessions anonymes ne suffisent plus
  if (!u) { gate.hidden = false; return viewAuth(); }
  if (!u.emailVerified) { gate.hidden = false; return viewVerify(); }
  try {
    await u.getIdToken(true); // rafraîchit la claim email_verified utilisée par les règles
    profile = (await get(ref(db, `users/${u.uid}`))).val();
  } catch (err) {
    console.error(err);
    flash = "Lecture du profil impossible : publie les règles de sécurité Firebase (database.rules.json).";
    await signOut(auth);
    return;
  }
  if (profile) finish(); else { gate.hidden = false; viewProfile(true); }
}

export function openProfile() { if (user && profile) { gate.hidden = false; viewProfile(false); } }

export function initAccount(a, d, cb) {
  auth = a; db = d; onSession = cb;
  card.innerHTML = '<div class="logo">💬</div><p class="subtitle">Connexion…</p>';
  onAuthStateChanged(auth, route);
  if (isSignInWithEmailLink(auth, location.href)) {
    const em = ls.get(EMAIL_KEY) || prompt("Confirme ton adresse email pour terminer la connexion :") || "";
    signInWithEmailLink(auth, em, location.href)
      .then(() => ls.del(EMAIL_KEY))
      .catch((e) => { flash = ERRORS[e.code] || "Lien de connexion invalide."; viewAuth(); })
      .finally(() => history.replaceState(null, "", location.pathname));
  }
}
