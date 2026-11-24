/**
 * The part of an account the player chooses: what they are called, and the
 * picture next to it.
 *
 * Kept apart from the identity the provider gave us. Google says the name on
 * the Google account; this is the name they picked for Keyvoria, the way a
 * gamertag is not your legal name. Signing in again refreshes the former and
 * must never overwrite the latter.
 */

export const MAX_DISPLAY_NAME = 24;
export const MIN_DISPLAY_NAME = 2;

/**
 * Avatars are stored as data URLs, so the ceiling is a real one: the app
 * downscales to a small square before sending, and anything above this is
 * refused rather than quietly filling a column with a 4MB phone photo.
 *
 * This MUST stay comfortably under the HTTP layer's own body limit once
 * base64 has added its third. At 48KB the encoded form was 64KB — exactly the
 * body cap — so a legal maximum-size avatar was rejected as an oversized
 * REQUEST before this validator ever ran, and the player got an unexplained
 * 413 instead of "that image is too large". 32KB encodes to about 44KB and
 * leaves room for the rest of the JSON.
 *
 * It is also generous: the app sends a 160px square, which is normally 6–12KB.
 */
export const MAX_AVATAR_BYTES = 32 * 1024;

/** Only real raster images. */
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * An avatar can also be one of a fixed set of pictures the app draws itself.
 * Those are stored as a bare id — there is no point shipping the same eight
 * images into every row, and a stored id is a few bytes rather than kilobytes.
 *
 * The ids live here as well as in the app because the server must not take an
 * arbitrary string: this column is rendered in other players' browsers, so
 * what goes into it is an allowlist, never "whatever the client sent".
 */
export const AVATAR_PRESET_IDS = Object.freeze([
  "keys", "note", "star", "fire", "heart", "rocket", "cat", "wave",
]);

/**
 * Names are displayed to other players in a room, so they are checked rather
 * than trusted. Control characters and the invisible direction-override marks
 * are stripped: the latter can reverse how text renders and are a standard way
 * to spoof somebody else's name in a player list.
 */
export function cleanDisplayName(input) {
  const raw = String(input ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")        // control characters
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "") // zero-width & bidi
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME);
  return raw;
}

export function validateDisplayName(input) {
  const name = cleanDisplayName(input);
  if (name.length < MIN_DISPLAY_NAME) {
    return { ok: false, reason: "too_short", message: `At least ${MIN_DISPLAY_NAME} characters.` };
  }
  return { ok: true, name };
}

/** @returns {{ok:true, avatar:string|null}|{ok:false, reason:string, message:string}} */
export function validateAvatar(input) {
  if (input === null || input === undefined || input === "") return { ok: true, avatar: null };
  const v = String(input);
  if (AVATAR_PRESET_IDS.includes(v)) return { ok: true, avatar: v, preset: true };
  if (!AVATAR_RE.test(v)) {
    return { ok: false, reason: "bad_avatar", message: "Avatars must be a PNG, JPEG or WebP image." };
  }
  // Byte length of the decoded image, not of the string.
  const b64 = v.slice(v.indexOf(",") + 1);
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_AVATAR_BYTES) {
    return { ok: false, reason: "avatar_too_large",
             message: `That image is too large — ${Math.round(MAX_AVATAR_BYTES / 1024)}KB is the limit.` };
  }
  return { ok: true, avatar: v, bytes };
}

/**
 * What the app shows for someone. The chosen name wins; the provider's name is
 * only the starting point, for an account that has not picked one yet.
 */
export function displayNameFor(user) {
  return (user?.display_name && user.display_name.trim())
      || (user?.name && user.name.trim())
      || "Keyvoria player";
}
