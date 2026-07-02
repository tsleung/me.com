// share-merge.js — pure logic for combining a saved `cfg` with an
// incoming share-link payload. Extracted so app.js's DOM-coupled
// settings code stays untestable-by-design, but the decision of
// "which value wins where" is unit-testable in plain node.
//
// Rule: an inbound share link is an *invitation*. The room-shape
// fields (which room are we in, what languages, what names, what
// signaling endpoint) should follow the invitation. Personal fields
// (API key, history-on flag, PSK passphrase, dictation language)
// stay with the existing user — those aren't the inviter's to
// override.

// Fields that the share link is authoritative on when present.
const SHARE_AUTHORITATIVE = [
  "roomCode",
  "myLang",
  "partnerLang",
  "displayName",
  "partnerName",
  "uiLang",
  "sigMode",
  "sigUrl",
];

// Fields the share link must NEVER touch — they're personal.
// Listed for clarity; the merge logic just never reads from shareParams
// for these.
export const PERSONAL_FIELDS = ["apiKey", "historyOn", "psk", "dictationLang"];

/**
 * Decide what values should populate the settings dialog given:
 *   - cfg:         the user's saved settings, or null
 *   - shareParams: the parsed share-link hash, or null
 *
 * Returns an object with the values to render. Empty-string share-link
 * fields are treated as "not specified" (the share link won't blank out
 * the user's existing lang pair, etc.). Caller is responsible for
 * filling in any UI-only defaults (e.g. DEFAULT_SIGNALING_URL) when
 * both sources are silent.
 *
 * The bug this fixes: when `cfg` already has a roomCode, opening a new
 * share link previously showed `cfg.roomCode` in the dialog because
 * openSettings populated everything from cfg first and only fell
 * through to shareParams when no cfg existed. The new room was
 * silently ignored. With this merge, share-link fields win for the
 * room-shape group whenever present.
 */
export function mergeShareIntoCfg(cfg, shareParams) {
  const out = { ...(cfg || {}) };
  if (!shareParams) return out;
  for (const k of SHARE_AUTHORITATIVE) {
    const v = shareParams[k];
    if (typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * True when an arriving share link disagrees with the saved cfg on the
 * room code. This is the signal that "the user clicked a fresh
 * invitation and we should prompt them to confirm switching rooms."
 */
export function shareLinkOverridesRoom(cfg, shareParams) {
  if (!shareParams || typeof shareParams.roomCode !== "string") return false;
  if (!shareParams.roomCode) return false;
  if (!cfg || !cfg.roomCode) return false;
  return cfg.roomCode !== shareParams.roomCode;
}
