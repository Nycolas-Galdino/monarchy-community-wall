export const LETTER_MAX_LENGTH = 600;
export const PROFILE_NAME_MAX_LENGTH = 60;
export const PROFILE_DESCRIPTION_MAX_LENGTH = 240;
export const AVATAR_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
export const DUCKS_ALLOWED_HOST = "app.duckapps.com.br";

export function normalizeDraft(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

export function validateDraft(recipient, body) {
  const normalized = normalizeDraft(body);
  const length = Array.from(normalized).length;
  if (!recipient) return "Escolha para quem vai a cartinha.";
  if (length < 3) return "Escreva pelo menos 3 caracteres.";
  if (length > LETTER_MAX_LENGTH) return `Use no máximo ${LETTER_MAX_LENGTH} caracteres.`;
  return null;
}

export function formatDate(value, locale = "pt-BR") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "agora há pouco";
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

export function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

export function validateProfileDraft({ displayName, description, ducksUrl, visibility = "public", avatarFile }) {
  const nameLength = Array.from(normalizeDraft(displayName)).length;
  const descriptionLength = Array.from(normalizeDraft(description)).length;
  if (nameLength < 2 || nameLength > PROFILE_NAME_MAX_LENGTH) return "O nome do perfil deve ter entre 2 e 60 caracteres.";
  if (descriptionLength > PROFILE_DESCRIPTION_MAX_LENGTH) return "A descrição deve ter até 240 caracteres.";
  if (!["public", "private"].includes(visibility)) return "Escolha se o perfil será público ou privado.";
  if (ducksUrl) {
    try {
      const url = new URL(ducksUrl);
      if (url.protocol !== "https:") return "O link do Ducks precisa usar HTTPS.";
      if (url.hostname.toLowerCase() !== DUCKS_ALLOWED_HOST) {
        return `O link do Ducks precisa pertencer ao domínio ${DUCKS_ALLOWED_HOST}.`;
      }
    } catch { return "Informe um link do Ducks válido."; }
  }
  if (avatarFile && (!avatarFile.type.startsWith("image/") || avatarFile.size > AVATAR_SOURCE_MAX_BYTES)) {
    return "A foto original deve ser uma imagem de até 5 MB.";
  }
  return null;
}

export function buildProfileShareUrl(locationLike, slug) {
  const url = new URL(locationLike.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("profile", slug);
  return url.toString();
}

export function wrapStoryText(text, maximumCharacters = 28) {
  const words = normalizeDraft(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maximumCharacters || !current) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}
