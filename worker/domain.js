export const LETTER_MIN_LENGTH = 3;
export const LETTER_MAX_LENGTH = 600;
export const DISPLAY_NAME_MAX_LENGTH = 60;
export const MODERATION_NOTE_MAX_LENGTH = 240;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PROFILE_NAME_MAX_LENGTH = 60;
export const PROFILE_DESCRIPTION_MAX_LENGTH = 240;
export const AVATAR_MAX_BYTES = 350 * 1024;
export const REPORT_REASONS = new Set(["abuse", "privacy", "spam", "other"]);
export const LETTER_STATUSES = new Set(["published", "hidden", "deleted"]);
export const PROFILE_STATUSES = new Set(["active", "hidden", "deleted"]);
export const PROFILE_VISIBILITIES = new Set(["public", "private"]);
export const AVATAR_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function normalizePlainText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function textLength(value) {
  return Array.from(value).length;
}

export function validateLetterInput(input) {
  const body = normalizePlainText(input?.body);
  const recipient = String(input?.recipient ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(recipient)) {
    return { ok: false, error: "Escolha um destinatário válido." };
  }
  const length = textLength(body);
  if (length < LETTER_MIN_LENGTH || length > LETTER_MAX_LENGTH) {
    return { ok: false, error: `A cartinha deve ter entre ${LETTER_MIN_LENGTH} e ${LETTER_MAX_LENGTH} caracteres.` };
  }
  return { ok: true, value: { body, recipient } };
}

export function validateModeratorInput(input) {
  const username = String(input?.username ?? "").trim().toLowerCase();
  const displayName = normalizePlainText(input?.displayName);
  const password = String(input?.password ?? "");
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    return { ok: false, error: "O usuário deve ter de 3 a 40 caracteres simples." };
  }
  if (!displayName || textLength(displayName) > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, error: "Informe um nome de exibição com até 60 caracteres." };
  }
  if (textLength(password) < PASSWORD_MIN_LENGTH || textLength(password) > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `A senha deve ter entre ${PASSWORD_MIN_LENGTH} e ${PASSWORD_MAX_LENGTH} caracteres.` };
  }
  return { ok: true, value: { username, displayName, password } };
}

export function validateModerationInput(input) {
  const status = String(input?.status ?? "");
  const note = normalizePlainText(input?.note);
  if (!LETTER_STATUSES.has(status)) return { ok: false, error: "Status de moderação inválido." };
  if (textLength(note) > MODERATION_NOTE_MAX_LENGTH) return { ok: false, error: "A nota deve ter até 240 caracteres." };
  return { ok: true, value: { status, note } };
}

export function slugifyProfileName(value) {
  const slug = normalizePlainText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    .replace(/-$/g, "");
  return slug || "perfil";
}

export function validateDucksUrl(value, configuredHosts = "app.duckapps.com.br") {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: true, value: null };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, error: "Informe um link Ducks válido." }; }
  const allowedHosts = String(configuredHosts).split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname.toLowerCase())) {
    return { ok: false, error: "O link precisa usar HTTPS e pertencer ao domínio Ducks permitido." };
  }
  url.hash = "";
  return { ok: true, value: url.toString() };
}

export function validateProfileInput(input, configuredHosts) {
  const displayName = normalizePlainText(input?.displayName);
  const description = normalizePlainText(input?.description);
  const visibility = String(input?.visibility ?? "public").trim().toLowerCase();
  const ducksUrl = validateDucksUrl(input?.ducksUrl, configuredHosts);
  if (textLength(displayName) < 2 || textLength(displayName) > PROFILE_NAME_MAX_LENGTH) {
    return { ok: false, error: "O nome do perfil deve ter entre 2 e 60 caracteres." };
  }
  if (textLength(description) > PROFILE_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: "A descrição deve ter até 240 caracteres." };
  }
  if (!ducksUrl.ok) return ducksUrl;
  if (!PROFILE_VISIBILITIES.has(visibility)) {
    return { ok: false, error: "Escolha se o perfil será público ou privado." };
  }
  const avatar = input?.avatar ?? null;
  if (avatar !== null) {
    if (!AVATAR_MEDIA_TYPES.has(avatar?.mediaType) || typeof avatar?.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(avatar.data)) {
      return { ok: false, error: "A foto deve ser JPEG, PNG ou WebP válida." };
    }
    if (Math.ceil(avatar.data.length * 3 / 4) > AVATAR_MAX_BYTES + 2) {
      return { ok: false, error: "A foto deve ter no máximo 350 KB após otimização." };
    }
  }
  return { ok: true, value: { displayName, description: description || null, ducksUrl: ducksUrl.value, visibility, avatar } };
}

export function decodeAndValidateAvatar(avatar) {
  if (!avatar) return null;
  let bytes;
  try {
    const binary = atob(avatar.data);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { throw new Error("invalid_avatar"); }
  if (!bytes.length || bytes.length > AVATAR_MAX_BYTES) throw new Error("invalid_avatar");
  const isJpeg = avatar.mediaType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = avatar.mediaType === "image/png" && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  const isWebp = avatar.mediaType === "image/webp" && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new Error("invalid_avatar");
  return bytes;
}

export function validateProfileModerationInput(input) {
  const status = String(input?.status ?? "");
  const note = normalizePlainText(input?.note);
  if (!PROFILE_STATUSES.has(status)) return { ok: false, error: "Status de perfil inválido." };
  if (textLength(note) > MODERATION_NOTE_MAX_LENGTH) return { ok: false, error: "A nota deve ter até 240 caracteres." };
  return { ok: true, value: { status, note } };
}

export function validateProfileVisibilityInput(input) {
  const visibility = String(input?.visibility ?? "").trim().toLowerCase();
  if (!PROFILE_VISIBILITIES.has(visibility)) {
    return { ok: false, error: "A visibilidade deve ser pública ou privada." };
  }
  return { ok: true, value: { visibility } };
}

export function parsePositiveInt(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function allowedOrigin(origin, configuredOrigins) {
  if (!origin) return null;
  const allowed = String(configuredOrigins ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashPassword(password, iterations = 210000, saltBytes) {
  const salt = saltBytes ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return `pbkdf2_sha256$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, iterationText, saltText, expectedText] = String(encoded).split("$");
  if (algorithm !== "pbkdf2_sha256" || !iterationText || !saltText || !expectedText) return false;
  const candidate = await hashPassword(password, Number(iterationText), base64UrlToBytes(saltText));
  const candidateBytes = new TextEncoder().encode(candidate);
  const expectedBytes = new TextEncoder().encode(encoded);
  if (candidateBytes.length !== expectedBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < candidateBytes.length; index += 1) mismatch |= candidateBytes[index] ^ expectedBytes[index];
  return mismatch === 0;
}

export function publicLetter(row) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    recipient: {
      slug: row.recipient_slug,
      name: row.recipient_name,
      accent: row.recipient_accent
    },
    reports: Number(row.report_count ?? 0),
    reactions: Number(row.reaction_count ?? 0)
  };
}
