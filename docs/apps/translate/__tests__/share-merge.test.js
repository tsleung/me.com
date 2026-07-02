// Tests for share-merge.js — the pure logic that decides what values
// populate the settings dialog when a saved cfg meets an incoming share
// link. Anchors the regression for the "share link silently ignored
// when cfg already has a roomCode" bug observed 2026-05-21.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeShareIntoCfg,
  shareLinkOverridesRoom,
  PERSONAL_FIELDS,
} from "../share-merge.js";

const baseCfg = {
  apiKey: "AIzaSAVED",
  myLang: "english",
  partnerLang: "mandarin",
  roomCode: "old-room-abc",
  displayName: "alice",
  partnerName: "bob",
  sigMode: "worker",
  sigUrl: "wss://saved-host/",
  historyOn: true,
  psk: "saved-psk",
  uiLang: "en",
  dictationLang: "en-US",
};

const inviteFromBob = {
  roomCode: "new-room-xyz",
  myLang: "mandarin",     // flipped by the sender
  partnerLang: "english", // flipped by the sender
  displayName: "alice",
  partnerName: "bob",
  uiLang: "zh-Hans",
  sigMode: "worker",
  sigUrl: "",             // share link omits when it matches the default
};

test("null cfg + null share → empty object", () => {
  assert.deepEqual(mergeShareIntoCfg(null, null), {});
});

test("cfg-only → cfg passes through unchanged", () => {
  const out = mergeShareIntoCfg(baseCfg, null);
  assert.deepEqual(out, baseCfg);
});

test("share-only (no cfg) → share fields populate", () => {
  const out = mergeShareIntoCfg(null, inviteFromBob);
  assert.equal(out.roomCode, "new-room-xyz");
  assert.equal(out.myLang, "mandarin");
  assert.equal(out.partnerLang, "english");
  assert.equal(out.uiLang, "zh-Hans");
  // Empty share-link fields don't bleed in as empty strings.
  assert.equal(out.sigUrl, undefined);
});

test("share + cfg with DIFFERENT room → share wins on room (the bug)", () => {
  // This is the regression test for the bug observed 2026-05-21:
  // openSettings was reading from cfg first, so a fresh share link
  // never overrode the saved room.
  const out = mergeShareIntoCfg(baseCfg, inviteFromBob);
  assert.equal(out.roomCode, "new-room-xyz", "incoming share room must win");
  assert.equal(out.myLang, "mandarin");
  assert.equal(out.partnerLang, "english");
  assert.equal(out.uiLang, "zh-Hans");
});

test("share + cfg → personal fields stay from cfg (never inviter's)", () => {
  const out = mergeShareIntoCfg(baseCfg, inviteFromBob);
  for (const k of PERSONAL_FIELDS) {
    assert.equal(out[k], baseCfg[k], `personal field ${k} must come from cfg`);
  }
});

test("share with empty string for a field → cfg value preserved", () => {
  // Share links omit fields that equal the default; the parser fills
  // them with "" anyway. Merge must treat empty as "not specified".
  const out = mergeShareIntoCfg(baseCfg, { ...inviteFromBob, sigUrl: "" });
  assert.equal(out.sigUrl, baseCfg.sigUrl, "empty share field must not blank cfg");
});

test("share + cfg with SAME room → idempotent except for share-authoritative overrides", () => {
  const sameRoom = { ...inviteFromBob, roomCode: baseCfg.roomCode };
  const out = mergeShareIntoCfg(baseCfg, sameRoom);
  assert.equal(out.roomCode, baseCfg.roomCode);
  // Language pair still flips to the invitation's perspective, which is
  // correct: a returning invitee may want the latest invitation shape.
  assert.equal(out.myLang, "mandarin");
});

test("shareLinkOverridesRoom: only true when both rooms exist and differ", () => {
  assert.equal(shareLinkOverridesRoom(null, null), false);
  assert.equal(shareLinkOverridesRoom(baseCfg, null), false);
  assert.equal(shareLinkOverridesRoom(null, inviteFromBob), false, "no cfg yet → not an override");
  assert.equal(
    shareLinkOverridesRoom({ ...baseCfg, roomCode: "" }, inviteFromBob),
    false,
    "cfg with empty room → invitation is initial setup, not an override",
  );
  assert.equal(
    shareLinkOverridesRoom(baseCfg, { ...inviteFromBob, roomCode: baseCfg.roomCode }),
    false,
    "same room → no override",
  );
  assert.equal(shareLinkOverridesRoom(baseCfg, inviteFromBob), true);
});
