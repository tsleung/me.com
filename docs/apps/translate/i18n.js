// UI localization — separate from the chat-content translation (that's
// Gemini's job). This is just for the app's own strings: labels,
// buttons, system messages. Supported: English, Mandarin, Japanese,
// French, Spanish. Default picked from navigator.language, overrideable
// in settings.

const DICT = {
  en: {
    "app.title": "translate",
    "topbar.roomLabel": "room",
    "topbar.roomChipTitle": "room code — click to copy and share with your partner",
    "topbar.pskChipTitle": "shared key is active — messages are end-to-end encrypted with your passphrase",
    "topbar.copy": "copy",
    "topbar.copyAria": "copy conversation",
    "topbar.clear": "clear",
    "topbar.clearAria": "clear conversation",
    "topbar.settingsAria": "settings",
    "topbar.backAria": "home",
    "presence.on": "connected",
    "presence.wait": "waiting for peer",
    "presence.off": "disconnected",
    "composer.placeholder": "write in your native language",
    "composer.preview": "preview",
    "composer.send": "send",
    "preview.willSend": "will send",
    "preview.readsBack": "reads back",
    "bubble.translating": "translating\u2026",
    "bubble.readsBackPrefix": "reads back: ",
    "settings.title": "settings",
    "settings.uiLangLegend": "interface language",
    "settings.uiLangLabel": "language",
    "settings.uiLang.en": "english",
    "settings.uiLang.zh": "\u4e2d\u6587 (mandarin)",
    "settings.langLegend": "languages",
    "settings.myLang": "your native language",
    "settings.myLangPlaceholder": "e.g. en, english",
    "settings.partnerLang": "partner's native language",
    "settings.partnerLangPlaceholder": "e.g. zh, mandarin",
    "settings.swapLang": "\u21c5 swap",
    "settings.swapLangTitle": "swap your language and partner's language",
    "settings.roomLegend": "room",
    "settings.roomCode": "room code",
    "settings.roomCodeHint": "(10+ chars, share out-of-band)",
    "settings.generate": "generate",
    "settings.myName": "your display name",
    "settings.myNameHint": "(optional, defaults to \"Me\")",
    "settings.myNamePlaceholder": "e.g. Lorem",
    "settings.partnerName": "partner's display name",
    "settings.partnerNameHint": "(optional, defaults to \"Partner\")",
    "settings.partnerNamePlaceholder": "e.g. Ipsum",
    "settings.signalingLegend": "signaling",
    "settings.signalingMode": "mode",
    "settings.signalingWorker": "our cloudflare worker (recommended)",
    "settings.signalingPeerjs": "peerjs fallback (public broker)",
    "settings.signalingUrl": "worker url",
    "settings.workerUrlPlaceholder": "wss://translate-signaling.example.workers.dev",
    "settings.pskLegend": "shared key",
    "settings.pskHint": "(optional, defense-in-depth)",
    "settings.passphrase": "passphrase",
    "settings.pskPlaceholder": "e.g. a private word only you two know",
    "settings.pskDesc": "if set, messages are AES-GCM encrypted in the browser with a key derived from this passphrase before being sent. your partner must enter the same passphrase to read them. share it over a different channel (not through this app).",
    "settings.geminiLegend": "gemini",
    "settings.geminiKey": "api key",
    "settings.geminiKeyHint": "(stored only on this device)",
    "settings.geminiGetKey": "get one at",
    "settings.historyLegend": "history",
    "settings.historyLegendHint": "(optional, encrypted at rest)",
    "settings.historyEnable": "save messages on this device",
    "settings.historyPassphrase": "passphrase",
    "settings.historyPassphraseHint": "(required if history is on)",
    "settings.clearHistory": "clear history",
    "settings.cancel": "cancel",
    "settings.save": "save",
    "system.connected": "connected to partner",
    "system.partnerGone": "partner disconnected \u2014 waiting to reconnect",
    "system.sigDown": "signaling disconnected \u2014 attempting to reconnect",
    "system.historyOnHint": "history is on \u2014 enter passphrase in settings to unlock",
    "system.pskActive": "shared key is active \u2014 messages you send are also encrypted with your passphrase",
    "system.translateFailed": "translate failed",
    "system.notSent": "not connected \u2014 message not sent",
    "system.notConnectedWait": "not connected \u2014 wait for the green dot, then try again",
    "system.historyCleared": "history cleared",
    "system.noSaved": "no saved messages for room",
    "system.restored": "restored {n} messages for room",
    "system.confirmClearScreen": "clear the conversation on this screen? messages already delivered to your partner stay on their side.",
    "system.confirmClearHistory": "clear all stored messages on this device? this cannot be undone.",
    "system.copied": "copied \u2713",
    "system.copyFailed": "copy failed",
    "system.nothingToCopy": "nothing to copy",
    "system.roomCodeAlert": "room code:",
    "system.roomCodeTooShort": "room code must be at least 8 chars",
    "system.historyPassRequired": "passphrase required when history is on",
    "system.wrongPassphrase": "wrong passphrase for existing vault",
  },
  zh: {
    "app.title": "\u7ffb\u8bd1",
    "topbar.roomLabel": "\u623f\u95f4",
    "topbar.roomChipTitle": "\u623f\u95f4\u4ee3\u7801 \u2014 \u70b9\u51fb\u590d\u5236\u5e76\u5206\u4eab\u7ed9\u4f34\u4fa3",
    "topbar.pskChipTitle": "\u5171\u4eab\u5bc6\u94a5\u5df2\u542f\u7528 \u2014 \u6d88\u606f\u4f7f\u7528\u60a8\u7684\u5bc6\u7801\u7aef\u5230\u7aef\u52a0\u5bc6",
    "topbar.copy": "\u590d\u5236",
    "topbar.copyAria": "\u590d\u5236\u5bf9\u8bdd",
    "topbar.clear": "\u6e05\u9664",
    "topbar.clearAria": "\u6e05\u9664\u5bf9\u8bdd",
    "topbar.settingsAria": "\u8bbe\u7f6e",
    "topbar.backAria": "\u9996\u9875",
    "presence.on": "\u5df2\u8fde\u63a5",
    "presence.wait": "\u7b49\u5f85\u4f34\u4fa3",
    "presence.off": "\u5df2\u65ad\u5f00",
    "composer.placeholder": "\u8bf7\u7528\u60a8\u7684\u6bcd\u8bed\u4e66\u5199",
    "composer.preview": "\u9884\u89c8",
    "composer.send": "\u53d1\u9001",
    "preview.willSend": "\u5c06\u53d1\u9001",
    "preview.readsBack": "\u56de\u8bd1\u4e3a",
    "bubble.translating": "\u7ffb\u8bd1\u4e2d\u2026",
    "bubble.readsBackPrefix": "\u56de\u8bd1\uff1a",
    "settings.title": "\u8bbe\u7f6e",
    "settings.uiLangLegend": "\u754c\u9762\u8bed\u8a00",
    "settings.uiLangLabel": "\u8bed\u8a00",
    "settings.uiLang.en": "english",
    "settings.uiLang.zh": "\u4e2d\u6587",
    "settings.langLegend": "\u8bed\u8a00",
    "settings.myLang": "\u60a8\u7684\u6bcd\u8bed",
    "settings.myLangPlaceholder": "\u4f8b\u5982\uff1aen, english",
    "settings.partnerLang": "\u4f34\u4fa3\u7684\u6bcd\u8bed",
    "settings.partnerLangPlaceholder": "\u4f8b\u5982\uff1azh, mandarin",
    "settings.swapLang": "\u21c5 \u4e92\u6362",
    "settings.swapLangTitle": "\u4e92\u6362\u60a8\u548c\u4f34\u4fa3\u7684\u8bed\u8a00",
    "settings.roomLegend": "\u623f\u95f4",
    "settings.roomCode": "\u623f\u95f4\u4ee3\u7801",
    "settings.roomCodeHint": "\uff08\u81f3\u5c118\u4e2a\u5b57\u7b26\uff0c\u901a\u8fc7\u53e6\u4e00\u6e20\u9053\u5206\u4eab\uff09",
    "settings.generate": "\u751f\u6210",
    "settings.myName": "\u60a8\u7684\u663e\u793a\u540d",
    "settings.myNameHint": "\uff08\u53ef\u9009\uff0c\u9ed8\u8ba4\u4e3a\u201cMe\u201d\uff09",
    "settings.myNamePlaceholder": "\u4f8b\u5982\uff1aLorem",
    "settings.partnerName": "\u4f34\u4fa3\u7684\u663e\u793a\u540d",
    "settings.partnerNameHint": "\uff08\u53ef\u9009\uff0c\u9ed8\u8ba4\u4e3a\u201cPartner\u201d\uff09",
    "settings.partnerNamePlaceholder": "\u4f8b\u5982\uff1aIpsum",
    "settings.signalingLegend": "\u4fe1\u4ee4",
    "settings.signalingMode": "\u6a21\u5f0f",
    "settings.signalingWorker": "\u6211\u4eec\u7684 Cloudflare Worker\uff08\u63a8\u8350\uff09",
    "settings.signalingPeerjs": "PeerJS \u5907\u7528\uff08\u516c\u5171\u4e2d\u7ee7\uff09",
    "settings.signalingUrl": "Worker \u5730\u5740",
    "settings.workerUrlPlaceholder": "wss://translate-signaling.example.workers.dev",
    "settings.pskLegend": "\u5171\u4eab\u5bc6\u94a5",
    "settings.pskHint": "\uff08\u53ef\u9009\uff0c\u6df1\u5ea6\u9632\u5fa1\uff09",
    "settings.passphrase": "\u5bc6\u7801",
    "settings.pskPlaceholder": "\u4f8b\u5982\uff1a\u53ea\u6709\u4f60\u4eec\u4e24\u4eba\u77e5\u9053\u7684\u8bcd",
    "settings.pskDesc": "\u8bbe\u7f6e\u540e\uff0c\u6d88\u606f\u5728\u53d1\u9001\u524d\u4f1a\u5728\u6d4f\u89c8\u5668\u4e2d\u7528\u8be5\u5bc6\u7801\u6d3e\u751f\u7684\u5bc6\u94a5\u8fdb\u884c AES-GCM \u52a0\u5bc6\u3002\u4f34\u4fa3\u9700\u8981\u8f93\u5165\u76f8\u540c\u7684\u5bc6\u7801\u624d\u80fd\u8bfb\u53d6\u3002\u8bf7\u901a\u8fc7\u53e6\u4e00\u4e2a\u6e20\u9053\u5206\u4eab\uff08\u4e0d\u8981\u901a\u8fc7\u672c\u5e94\u7528\uff09\u3002",
    "settings.geminiLegend": "Gemini",
    "settings.geminiKey": "API \u5bc6\u94a5",
    "settings.geminiKeyHint": "\uff08\u4ec5\u4fdd\u5b58\u5728\u672c\u8bbe\u5907\uff09",
    "settings.geminiGetKey": "\u83b7\u53d6\u5730\u5740\uff1a",
    "settings.historyLegend": "\u5386\u53f2\u8bb0\u5f55",
    "settings.historyLegendHint": "\uff08\u53ef\u9009\uff0c\u52a0\u5bc6\u5b58\u50a8\uff09",
    "settings.historyEnable": "\u5c06\u6d88\u606f\u4fdd\u5b58\u5728\u672c\u8bbe\u5907",
    "settings.historyPassphrase": "\u5bc6\u7801",
    "settings.historyPassphraseHint": "\uff08\u5f00\u542f\u5386\u53f2\u8bb0\u5f55\u65f6\u5fc5\u586b\uff09",
    "settings.clearHistory": "\u6e05\u9664\u5386\u53f2",
    "settings.cancel": "\u53d6\u6d88",
    "settings.save": "\u4fdd\u5b58",
    "system.connected": "\u5df2\u4e0e\u4f34\u4fa3\u8fde\u63a5",
    "system.partnerGone": "\u4f34\u4fa3\u5df2\u65ad\u5f00 \u2014 \u7b49\u5f85\u91cd\u65b0\u8fde\u63a5",
    "system.sigDown": "\u4fe1\u4ee4\u5df2\u65ad\u5f00 \u2014 \u6b63\u5728\u5c1d\u8bd5\u91cd\u8fde",
    "system.historyOnHint": "\u5386\u53f2\u8bb0\u5f55\u5df2\u5f00\u542f \u2014 \u8bf7\u5728\u8bbe\u7f6e\u4e2d\u8f93\u5165\u5bc6\u7801\u89e3\u9501",
    "system.pskActive": "\u5171\u4eab\u5bc6\u94a5\u5df2\u542f\u7528 \u2014 \u60a8\u53d1\u9001\u7684\u6d88\u606f\u4e5f\u5c06\u7528\u60a8\u7684\u5bc6\u7801\u52a0\u5bc6",
    "system.translateFailed": "\u7ffb\u8bd1\u5931\u8d25",
    "system.notSent": "\u672a\u8fde\u63a5 \u2014 \u6d88\u606f\u672a\u53d1\u9001",
    "system.notConnectedWait": "\u672a\u8fde\u63a5 \u2014 \u8bf7\u7b49\u5f85\u7eff\u8272\u6307\u793a\u70b9\u540e\u91cd\u8bd5",
    "system.historyCleared": "\u5386\u53f2\u5df2\u6e05\u9664",
    "system.noSaved": "\u623f\u95f4\u6ca1\u6709\u4fdd\u5b58\u7684\u6d88\u606f\uff1a",
    "system.restored": "\u5df2\u6062\u590d {n} \u6761\u6d88\u606f\uff0c\u623f\u95f4\uff1a",
    "system.confirmClearScreen": "\u6e05\u9664\u672c\u5c4f\u5e55\u7684\u5bf9\u8bdd\uff1f\u5df2\u9001\u8fbe\u4f34\u4fa3\u7684\u6d88\u606f\u4ecd\u5728\u4ed6\u4eec\u90a3\u8fb9\u3002",
    "system.confirmClearHistory": "\u6e05\u9664\u672c\u8bbe\u5907\u4e0a\u6240\u6709\u4fdd\u5b58\u7684\u6d88\u606f\uff1f\u6b64\u64cd\u4f5c\u65e0\u6cd5\u64a4\u9500\u3002",
    "system.copied": "\u5df2\u590d\u5236 \u2713",
    "system.copyFailed": "\u590d\u5236\u5931\u8d25",
    "system.nothingToCopy": "\u6ca1\u6709\u53ef\u590d\u5236\u7684\u5185\u5bb9",
    "system.roomCodeAlert": "\u623f\u95f4\u4ee3\u7801\uff1a",
    "system.roomCodeTooShort": "\u623f\u95f4\u4ee3\u7801\u81f3\u5c11\u9700\u89818\u4e2a\u5b57\u7b26",
    "system.historyPassRequired": "\u5f00\u542f\u5386\u53f2\u8bb0\u5f55\u9700\u8981\u5bc6\u7801",
    "system.wrongPassphrase": "\u73b0\u6709\u5b58\u50a8\u7684\u5bc6\u7801\u9519\u8bef",
  },
};

// v1.1 ships en + zh. Planned: ja, fr, es — to be filled in via an
// LLM pass over the en dictionary. Once added, extend this array and
// the <select> options in index.html; no call sites need to change.
export const SUPPORTED_UI_LANGS = ["en", "zh"];

let currentLang = "en";

export function setUiLang(lang) {
  currentLang = DICT[lang] ? lang : "en";
}

export function getUiLang() {
  return currentLang;
}

export function t(key, params) {
  const s = DICT[currentLang]?.[key] ?? DICT.en[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }
  document.documentElement.lang = currentLang;
}

export function detectDefaultUiLang() {
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return DICT[nav] ? nav : "en";
}
