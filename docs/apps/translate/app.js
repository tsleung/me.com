// app.js — translate chat app.
//
// Responsibilities:
//   - Load/save config in localStorage
//   - Call Gemini Flash for forward + round-trip translation (preview only)
//   - Open a WebRTC peer connection via our Cloudflare Worker (or PeerJS fallback)
//   - Send/receive JSON messages over a data channel
//   - Render bubbles, presence, preview
//   - Optionally append to encrypted vault

import * as vault from "./vault.js";

const GEMINI_MODEL = "gemini-3-flash-preview";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const DEFAULT_SIGNALING_URL = "wss://translate-signaling.tsleung.workers.dev";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const $ = (id) => document.getElementById(id);

// ---- Config --------------------------------------------------------------

const CFG_KEYS = [
  "apiKey", "myLang", "partnerLang", "roomCode", "displayName",
  "partnerName", "sigMode", "sigUrl", "historyOn",
];

function loadCfg() {
  const raw = localStorage.getItem("translate.cfg");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function saveCfg(cfg) {
  localStorage.setItem("translate.cfg", JSON.stringify(cfg));
}

function genRoomCode() {
  // time-seeded + random suffix so two people picking "generate" at the
  // same second still diverge. base36 keeps it URL/clipboard friendly.
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const ts = Date.now().toString(36);
  const buf = crypto.getRandomValues(new Uint8Array(4));
  const rand = Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
  return `${ts}-${rand}`;
}

// ---- Gemini --------------------------------------------------------------

async function translate(text, from, to, apiKey) {
  const prompt =
    `Translate from ${from} to ${to}. ` +
    `Preserve tone (casual, affectionate, playful are ok). ` +
    `Output only the translation, no commentary or quotes.\n\n${text}`;
  const r = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 },
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`gemini ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return out.trim();
}

// ---- Rendering -----------------------------------------------------------

const chatEl = $("chat");

function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderSystem(text) {
  const b = document.createElement("div");
  b.className = "bubble sys";
  b.textContent = text;
  chatEl.appendChild(b);
  scrollBottom();
}

function renderMessage(msg, direction) {
  const b = document.createElement("div");
  b.className = `bubble ${direction === "out" ? "out" : "in"}`;
  const primary = document.createElement("div");
  primary.className = "primary";
  primary.textContent = direction === "out" ? msg.original : msg.translation;
  const secondary = document.createElement("div");
  secondary.className = "secondary";
  secondary.textContent = direction === "out" ? msg.translation : msg.original;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${msg.from_lang} \u2192 ${msg.to_lang}`;
  b.append(primary, secondary, meta);
  chatEl.appendChild(b);
  scrollBottom();
  transcript.push({ msg, direction });
}

function formatTranscript() {
  if (transcript.length === 0) return "";
  const me = cfg?.displayName || "Me";
  const partner = cfg?.partnerName || "Partner";
  const lines = [];
  for (const { msg, direction } of transcript) {
    const who = direction === "out" ? me : partner;
    const when = new Date(msg.ts).toLocaleString();
    lines.push(`[${when}] ${who} (${msg.from_lang} \u2192 ${msg.to_lang})`);
    lines.push(`  ${msg.original}`);
    lines.push(`  \u2192 ${msg.translation}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function copyTranscript(btn) {
  const text = formatTranscript();
  if (!text) { flashButton(btn, "nothing to copy"); return; }
  try {
    await navigator.clipboard.writeText(text);
    flashButton(btn, "copied \u2713");
  } catch {
    // Fallback: select a hidden textarea and execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); flashButton(btn, "copied \u2713"); }
    catch { flashButton(btn, "copy failed"); }
    finally { ta.remove(); }
  }
}

function flashButton(btn, label) {
  const prev = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = prev; }, 1400);
}

function clearConversation() {
  transcript.length = 0;
  chatEl.innerHTML = "";
}

function setPresence(state) {
  $("presence").dataset.state = state;
  $("presence").title =
    state === "on" ? "connected" : state === "wait" ? "waiting for peer" : "disconnected";
}

function renderRoomChip() {
  const chip = $("room-chip");
  if (!cfg?.roomCode) { chip.hidden = true; return; }
  chip.hidden = false;
  $("room-chip-code").textContent = cfg.roomCode;
  $("psk-chip").hidden = !cfg.psk;
}

async function copyRoomCode(btn) {
  if (!cfg?.roomCode) return;
  try {
    await navigator.clipboard.writeText(cfg.roomCode);
    btn.classList.add("room-chip-copied");
    const label = btn.querySelector(".room-chip-label");
    const prev = label.textContent;
    label.textContent = "copied";
    setTimeout(() => {
      btn.classList.remove("room-chip-copied");
      label.textContent = prev;
    }, 1200);
  } catch {
    alert(`room code: ${cfg.roomCode}`);
  }
}

// ---- Transport: our Cloudflare Worker ------------------------------------

class WorkerTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.ws = null;
    this.pc = null;
    this.dc = null;
    this.onMessage = () => {};
    this.onStateChange = () => {};
  }

  async connect() {
    const url = new URL(this.cfg.sigUrl);
    url.searchParams.set("room", this.cfg.roomCode);
    this.ws = new WebSocket(url.toString());
    this.ws.addEventListener("open", () => this._onWsOpen());
    this.ws.addEventListener("message", (e) => this._onWsMessage(e));
    this.ws.addEventListener("close", () => this._teardown("signaling closed"));
    this.ws.addEventListener("error", () => this._teardown("signaling error"));
  }

  _onWsOpen() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this._wsSend({ type: "ice", candidate: e.candidate.toJSON() });
    };
    this.pc.ondatachannel = (e) => this._wireDataChannel(e.channel);
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "connected") this.onStateChange("on");
      else if (s === "disconnected" || s === "failed" || s === "closed") this.onStateChange("off");
    };
    this._wsSend({ type: "hello", name: this.cfg.displayName });
    this.onStateChange("wait");
  }

  async _onWsMessage(e) {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case "hello":
        if (!this.dc) {
          // We go first (initiator).
          this.dc = this.pc.createDataChannel("chat");
          this._wireDataChannel(this.dc);
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this._wsSend({ type: "offer", sdp: offer.sdp });
        }
        break;
      case "offer": {
        await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const ans = await this.pc.createAnswer();
        await this.pc.setLocalDescription(ans);
        this._wsSend({ type: "answer", sdp: ans.sdp });
        break;
      }
      case "answer":
        await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        break;
      case "ice":
        try { await this.pc.addIceCandidate(msg.candidate); } catch {}
        break;
      case "peer-gone":
        this.onStateChange("wait");
        break;
    }
  }

  _wireDataChannel(dc) {
    this.dc = dc;
    dc.onopen = () => this.onStateChange("on");
    dc.onclose = () => this.onStateChange("wait");
    dc.onmessage = (e) => {
      try { this.onMessage(JSON.parse(e.data)); } catch {}
    };
  }

  _wsSend(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  send(msg) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  _teardown(reason) {
    this.onStateChange("off");
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    try { this.ws?.close(); } catch {}
  }

  close() { this._teardown("closed"); }
}

// ---- Transport: PeerJS fallback ------------------------------------------

class PeerJsTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.peer = null;
    this.conn = null;
    this.onMessage = () => {};
    this.onStateChange = () => {};
  }

  async connect() {
    await ensurePeerJsLoaded();
    const Peer = window.Peer;
    const myId = `${this.cfg.roomCode}-${this.cfg.displayName}`;
    const partnerId = `${this.cfg.roomCode}-${this.cfg.partnerName}`;
    this.peer = new Peer(myId);
    this.peer.on("open", () => {
      this.onStateChange("wait");
      const c = this.peer.connect(partnerId, { reliable: true });
      this._wire(c);
    });
    this.peer.on("connection", (c) => this._wire(c));
    this.peer.on("error", (err) => {
      if (err.type === "peer-unavailable") return; // partner not online yet
      this.onStateChange("off");
    });
  }

  _wire(conn) {
    this.conn = conn;
    conn.on("open", () => this.onStateChange("on"));
    conn.on("close", () => this.onStateChange("wait"));
    conn.on("data", (d) => {
      try { this.onMessage(typeof d === "string" ? JSON.parse(d) : d); } catch {}
    });
  }

  send(msg) {
    if (this.conn && this.conn.open) {
      this.conn.send(msg);
      return true;
    }
    return false;
  }

  close() {
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.onStateChange("off");
  }
}

function ensurePeerJsLoaded() {
  if (window.Peer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("failed to load peerjs"));
    document.head.appendChild(s);
  });
}

// ---- App wiring ----------------------------------------------------------

let cfg = loadCfg();
let transport = null;
let lastPreview = null; // { text, forward }
let pskKey = null;      // AES-GCM key derived from cfg.psk (null if no PSK set)
const transcript = []; // in-memory, session only, for copy-out

// ---- PSK (pre-shared key) layer -----------------------------------------
//
// If cfg.psk is set, messages are AES-GCM encrypted in the browser before
// being handed to the WebRTC data channel. This protects even against a
// compromised signaling path: a MITM would see DTLS ciphertext wrapping
// PSK ciphertext; without the PSK, they still can't read anything.
//
// Key derivation: PBKDF2-SHA256 (200k iters) over the passphrase with a
// salt derived from the room code, so two peers in the same room with the
// same passphrase derive the same AES-GCM key deterministically.

async function derivePskKey(psk, roomCode) {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(psk),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(`translate-psk:${roomCode}`),
      iterations: 200_000,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function refreshPskKey() {
  if (cfg?.psk && cfg?.roomCode) {
    pskKey = await derivePskKey(cfg.psk, cfg.roomCode);
  } else {
    pskKey = null;
  }
}

function b64enc(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64dec(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function encryptForWire(msg) {
  if (!pskKey) return msg;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(msg));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, pskKey, pt)
  );
  return { kind: "chat-e2e", iv: b64enc(iv), ct: b64enc(ct) };
}

async function decryptFromWire(wire) {
  if (wire?.kind !== "chat-e2e") return { ok: true, msg: wire };
  if (!pskKey) {
    return {
      ok: false,
      reason: "your partner sent an encrypted message, but you don't have a shared key set",
    };
  }
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64dec(wire.iv) },
      pskKey,
      b64dec(wire.ct)
    );
    return { ok: true, msg: JSON.parse(new TextDecoder().decode(pt)) };
  } catch {
    return {
      ok: false,
      reason: "received an encrypted message but your shared key doesn't decrypt it — check with your partner that you both typed the same passphrase",
    };
  }
}

function openSettings(initial = false) {
  const dlg = $("settings");
  if (cfg) {
    $("cfg-apikey").value      = cfg.apiKey || "";
    $("cfg-mylang").value      = cfg.myLang || "";
    $("cfg-partnerlang").value = cfg.partnerLang || "";
    $("cfg-room").value        = cfg.roomCode || "";
    $("cfg-name").value        = cfg.displayName || "";
    $("cfg-partnername").value = cfg.partnerName || "";
    $("cfg-sigmode").value     = cfg.sigMode || "worker";
    $("cfg-sigurl").value      = cfg.sigUrl || DEFAULT_SIGNALING_URL;
    $("cfg-history").checked   = !!cfg.historyOn;
    $("cfg-psk").value         = cfg.psk || "";
  } else {
    $("cfg-room").value    = genRoomCode();
    $("cfg-sigurl").value  = DEFAULT_SIGNALING_URL;
    $("cfg-sigmode").value = "worker";
  }
  dlg.showModal();
}

async function handleSettingsSave() {
  const next = {
    apiKey:      $("cfg-apikey").value.trim(),
    myLang:      $("cfg-mylang").value.trim(),
    partnerLang: $("cfg-partnerlang").value.trim(),
    roomCode:    $("cfg-room").value.trim(),
    displayName: $("cfg-name").value.trim() || "Me",
    partnerName: $("cfg-partnername").value.trim() || "Partner",
    sigMode:     $("cfg-sigmode").value,
    sigUrl:      $("cfg-sigurl").value.trim() || DEFAULT_SIGNALING_URL,
    historyOn:   $("cfg-history").checked,
    psk:         $("cfg-psk").value.trim(),
  };
  if (next.roomCode.length < 8) { alert("room code must be at least 8 chars"); return false; }

  if (next.historyOn) {
    const pass = $("cfg-passphrase").value;
    if (!pass) { alert("passphrase required when history is on"); return false; }
    const ok = await vault.unlock(pass);
    if (!ok) { alert("wrong passphrase for existing vault"); return false; }
  } else {
    vault.lock();
  }

  cfg = next;
  saveCfg(cfg);
  renderRoomChip();
  await refreshPskKey();
  await restartTransport();
  if (cfg.historyOn && vault.isUnlocked()) await restoreHistory();
  return true;
}

async function restoreHistory() {
  if (!cfg?.roomCode) return;
  const recs = await vault.readRecent(cfg.roomCode, 200);
  chatEl.innerHTML = "";
  for (const r of recs) renderMessage(r.msg, r.direction);
  renderSystem(
    recs.length === 0
      ? `no saved messages for room ${cfg.roomCode}`
      : `restored ${recs.length} messages for room ${cfg.roomCode}`
  );
}

async function restartTransport() {
  if (transport) { transport.close(); transport = null; }
  setPresence("off");
  if (!cfg) return;
  transport = cfg.sigMode === "peerjs" ? new PeerJsTransport(cfg) : new WorkerTransport(cfg);
  transport.onStateChange = setPresence;
  transport.onMessage = async (wire) => {
    const result = await decryptFromWire(wire);
    if (!result.ok) { renderSystem(result.reason); return; }
    const msg = result.msg;
    if (msg?.kind !== "chat") return;
    renderMessage(msg, "in");
    if (cfg.historyOn && vault.isUnlocked()) {
      try { await vault.append(msg, "in", cfg.roomCode); } catch {}
    }
  };
  await transport.connect();
}

async function doPreview() {
  if (!cfg) return openSettings(true);
  const text = $("input").value.trim();
  if (!text) return;
  $("preview-btn").disabled = true;
  $("preview-forward").textContent = "...";
  $("preview-back").textContent = "...";
  $("preview-box").hidden = false;
  try {
    const forward = await translate(text, cfg.myLang, cfg.partnerLang, cfg.apiKey);
    $("preview-forward").textContent = forward;
    const back = await translate(forward, cfg.partnerLang, cfg.myLang, cfg.apiKey);
    $("preview-back").textContent = back;
    lastPreview = { text, forward };
  } catch (e) {
    $("preview-forward").textContent = "";
    $("preview-back").textContent = `error: ${e.message}`;
    lastPreview = null;
  } finally {
    $("preview-btn").disabled = false;
  }
}

async function doSend() {
  if (!cfg) return openSettings(true);
  const text = $("input").value.trim();
  if (!text) return;
  let forward;
  if (lastPreview && lastPreview.text === text) {
    forward = lastPreview.forward;
  } else {
    try {
      forward = await translate(text, cfg.myLang, cfg.partnerLang, cfg.apiKey);
    } catch (e) {
      renderSystem(`translate failed: ${e.message}`);
      return;
    }
  }
  const msg = {
    kind: "chat",
    id: crypto.randomUUID(),
    ts: Date.now(),
    original: text,
    translation: forward,
    from_lang: cfg.myLang,
    to_lang: cfg.partnerLang,
  };
  const wire = await encryptForWire(msg);
  const ok = transport && transport.send(wire);
  if (!ok) {
    renderSystem("not connected — message not sent");
    return;
  }
  renderMessage(msg, "out");
  if (cfg.historyOn && vault.isUnlocked()) {
    try { await vault.append(msg, "out", cfg.roomCode); } catch {}
  }
  $("input").value = "";
  $("preview-box").hidden = true;
  lastPreview = null;
}

// ---- Event wiring --------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  $("settings-btn").addEventListener("click", () => openSettings(false));
  $("room-chip").addEventListener("click", (e) => copyRoomCode(e.currentTarget));
  $("copy-btn").addEventListener("click", (e) => copyTranscript(e.currentTarget));
  $("clear-btn").addEventListener("click", () => {
    if (transcript.length === 0) return;
    if (!confirm("clear the conversation on this screen? messages already delivered to your partner stay on their side.")) return;
    clearConversation();
  });
  $("cfg-room-gen").addEventListener("click", () => {
    $("cfg-room").value = genRoomCode();
  });
  $("cfg-clear-history").addEventListener("click", async () => {
    if (!confirm("clear all stored messages on this device? this cannot be undone.")) return;
    await vault.clearAll();
    chatEl.innerHTML = "";
    renderSystem("history cleared");
  });
  $("settings").addEventListener("close", async () => {
    if ($("settings").returnValue === "save") {
      const ok = await handleSettingsSave();
      if (!ok) openSettings(false);
    }
  });
  $("cfg-save").addEventListener("click", (e) => {
    // Let the form close with returnValue "save". Actual save happens in the close handler
    // so async validation can re-open the dialog on failure.
  });

  $("preview-btn").addEventListener("click", doPreview);
  $("send-btn").addEventListener("click", doSend);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); }
  });

  renderRoomChip();
  if (!cfg) {
    openSettings(true);
  } else {
    await refreshPskKey();
    if (cfg.historyOn) {
      renderSystem("history is on — enter passphrase in settings to unlock");
    }
    if (cfg.psk) {
      renderSystem("shared key is active — messages you send are also encrypted with your passphrase");
    }
    await restartTransport();
  }
});
