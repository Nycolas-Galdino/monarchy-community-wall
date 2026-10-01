import {
  REPORT_REASONS,
  allowedOrigin,
  decodeAndValidateAvatar,
  hashPassword,
  normalizePlainText,
  parsePositiveInt,
  publicLetter,
  randomToken,
  sha256,
  textLength,
  validateLetterInput,
  validateModerationInput,
  validateModeratorInput,
  validateProfileInput,
  validateProfileLetterVisibilityInput,
  validateProfileModerationInput,
  validateProfilePasswordInput,
  validateProfileVisibilityInput,
  slugifyProfileName,
  verifyPassword
} from "./domain.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DUMMY_PASSWORD_HASH = "pbkdf2_sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$4xu9zyUhIT1-X1c3WzYqkFpmoegrbv5v-CWWppWKatw";

function securityHeaders(origin, env) {
  const headers = {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
  const acceptedOrigin = allowedOrigin(origin, env.ALLOWED_ORIGINS);
  if (acceptedOrigin) {
    headers["access-control-allow-origin"] = acceptedOrigin;
    headers.vary = "Origin";
  }
  return headers;
}

function json(data, status, request, env, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...securityHeaders(request.headers.get("origin"), env), ...extraHeaders }
  });
}

function fail(message, status, request, env, code = "request_error") {
  return json({ error: { code, message } }, status, request, env);
}

async function readJson(request, maximumBytes = 16_384) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maximumBytes) throw new Error("payload_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error("payload_too_large");
  return JSON.parse(text);
}

async function safeEqual(left, right) {
  const leftHash = await sha256(String(left ?? ""));
  const rightHash = await sha256(String(right ?? ""));
  let mismatch = leftHash.length ^ rightHash.length;
  for (let index = 0; index < Math.min(leftHash.length, rightHash.length); index += 1) {
    mismatch |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return mismatch === 0;
}

function requestIp(request) {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

async function fingerprint(request, env) {
  if (!env.IP_HASH_SECRET) throw new Error("IP_HASH_SECRET is not configured");
  return sha256(`${env.IP_HASH_SECRET}:${requestIp(request)}`);
}

async function enforceRateLimit(request, env, route, limit, windowSeconds) {
  const identity = await fingerprint(request, env);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const bucketNumber = Math.floor(nowSeconds / windowSeconds);
  const bucket = String(bucketNumber);
  const expiresAt = new Date((bucketNumber + 1) * windowSeconds * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(new Date().toISOString()),
    env.DB.prepare(`
      INSERT INTO rate_limits (fingerprint, route, bucket, request_count, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(fingerprint, route, bucket)
      DO UPDATE SET request_count = request_count + 1
    `).bind(identity, route, bucket, expiresAt)
  ]);
  const row = await env.DB.prepare(
    "SELECT request_count FROM rate_limits WHERE fingerprint = ? AND route = ? AND bucket = ?"
  ).bind(identity, route, bucket).first();
  if (Number(row?.request_count ?? 0) > limit) {
    const retryAfter = (bucketNumber + 1) * windowSeconds - nowSeconds;
    return { allowed: false, retryAfter };
  }
  return { allowed: true, fingerprint: identity };
}

async function authenticate(request, env) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare(`
    SELECT m.id, m.username, m.display_name
    FROM sessions s
    JOIN moderators m ON m.id = s.moderator_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND m.active = 1
  `).bind(tokenHash, new Date().toISOString()).first();
}

async function requireModerator(request, env) {
  const moderator = await authenticate(request, env);
  if (!moderator) return { response: fail("Sessão ausente ou expirada.", 401, request, env, "unauthorized") };
  return { moderator };
}

async function listRecipients(request, env) {
  const result = await env.DB.prepare(`
    SELECT slug, name, accent, kind, has_avatar
    FROM (
      SELECT r.slug, r.display_name AS name, r.accent, 'community' AS kind,
             0 AS has_avatar,
             CASE r.slug WHEN 'moderacao' THEN 0 WHEN 'comunidade' THEN 1 ELSE 2 END AS position
      FROM recipients r
      WHERE r.active = 1 AND r.kind = 'community'
      UNION ALL
      SELECT p.slug, p.display_name AS name, r.accent, 'profile' AS kind,
             CASE WHEN p.avatar_blob IS NULL THEN 0 ELSE 1 END AS has_avatar,
             3 AS position
      FROM profiles p
      JOIN recipients r ON r.id = p.recipient_id
      WHERE p.status = 'active' AND p.visibility = 'public' AND r.active = 1
    ) directory
    ORDER BY position, name COLLATE NOCASE
  `).all();
  const recipients = (result.results ?? []).map((recipient) => ({
    slug: recipient.slug,
    name: recipient.name,
    accent: recipient.accent,
    kind: recipient.kind,
    hasAvatar: Boolean(recipient.has_avatar)
  }));
  return json({ recipients }, 200, request, env, { "cache-control": "no-store" });
}

async function listPublicLetters(request, env, url) {
  const limit = parsePositiveInt(url.searchParams.get("limit"), 24, 50);
  const page = parsePositiveInt(url.searchParams.get("page"), 1, 1000);
  const recipient = String(url.searchParams.get("recipient") ?? "").trim().toLowerCase();
  const offset = (page - 1) * limit;
  const conditions = ["l.status = 'published'", "r.kind = 'community'"];
  const bindings = [];
  if (recipient) {
    conditions.push("r.slug = ?");
    bindings.push(recipient);
  }
  const result = await env.DB.prepare(`
    SELECT l.id, l.body, l.created_at, l.report_count, l.reaction_count,
           r.slug AS recipient_slug, r.display_name AS recipient_name, r.accent AS recipient_accent
    FROM letters l JOIN recipients r ON r.id = l.recipient_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, limit + 1, offset).all();
  const rows = result.results ?? [];
  return json({ letters: rows.slice(0, limit).map(publicLetter), page, hasMore: rows.length > limit }, 200, request, env, {
    "cache-control": "public, max-age=15"
  });
}

function profileJson(row) {
  return {
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    ducksUrl: row.ducks_url,
    visibility: row.visibility,
    letterVisibility: row.letter_visibility,
    passwordConfigured: Boolean(row.letter_password_hash),
    hasAvatar: Boolean(row.avatar_media_type),
    createdAt: row.created_at
  };
}

async function getActiveProfile(env, slug) {
  return env.DB.prepare(`
    SELECT p.id, p.slug, p.display_name, p.description, p.ducks_url, p.visibility,
           p.letter_visibility, p.letter_password_hash, p.avatar_media_type,
           p.created_at, p.recipient_id, r.slug AS recipient_slug
    FROM profiles p JOIN recipients r ON r.id = p.recipient_id
    WHERE p.slug = ? AND p.status = 'active'
  `).bind(slug).first();
}

async function getProfile(request, env, slug) {
  const profile = await getActiveProfile(env, slug);
  if (!profile) return fail("Perfil não encontrado.", 404, request, env, "profile_not_found");
  return json({ profile: profileJson(profile) }, 200, request, env, { "cache-control": "no-store" });
}

async function getProfileAvatar(request, env, slug) {
  const row = await env.DB.prepare(`
    SELECT p.id, p.avatar_media_type, p.avatar_blob
    FROM profiles p WHERE p.slug = ? AND p.status = 'active' AND p.avatar_blob IS NOT NULL
  `).bind(slug).first();
  if (!row) return fail("Foto não encontrada.", 404, request, env, "avatar_not_found");
  // D1 devolve BLOB como ArrayBuffer; a conversão explícita evita respostas
  // vazias em runtimes que não o reconhecem diretamente como BodyInit.
  return new Response(new Uint8Array(row.avatar_blob), {
    status: 200,
    headers: {
      ...securityHeaders(request.headers.get("origin"), env),
      "content-type": row.avatar_media_type,
      "cache-control": "public, max-age=86400, immutable",
      etag: `\"${row.id}\"`
    }
  });
}

async function createProfile(request, env) {
  const rate = await enforceRateLimit(request, env, "create-profile", 3, 3600);
  if (!rate.allowed) return json({ error: { code: "rate_limited", message: "Muitos perfis criados em pouco tempo. Tente novamente mais tarde." } }, 429, request, env, { "retry-after": String(rate.retryAfter) });
  const validation = validateProfileInput(await readJson(request, 525_000), env.DUCKS_ALLOWED_HOSTS);
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) return fail("A chave de idempotência está ausente ou inválida.", 400, request, env, "invalid_idempotency_key");
  const requestHash = await sha256(JSON.stringify(validation.value));
  const existing = await env.DB.prepare("SELECT slug, request_hash FROM profiles WHERE idempotency_key = ?").bind(idempotencyKey).first();
  if (existing) {
    if (existing.request_hash !== requestHash) return fail("Essa chave já foi usada para outro perfil.", 409, request, env, "idempotency_conflict");
    return json({ slug: existing.slug, created: false }, 200, request, env);
  }
  let avatarBytes = null;
  try { avatarBytes = decodeAndValidateAvatar(validation.value.avatar); }
  catch { return fail("A foto enviada não corresponde a um JPEG, PNG ou WebP válido.", 422, request, env, "invalid_avatar"); }
  const letterPasswordHash = validation.value.password ? await hashPassword(validation.value.password) : null;

  const id = crypto.randomUUID();
  const slug = `${slugifyProfileName(validation.value.displayName)}-${randomToken(9).toLowerCase().replace(/_/g, "-")}`;
  const recipientSlug = `profile-${randomToken(12).toLowerCase().replace(/_/g, "-")}`;
  const accent = ["violet", "coral", "cyan"][new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)))[0] % 3];
  const avatarBuffer = avatarBytes ? avatarBytes.buffer.slice(avatarBytes.byteOffset, avatarBytes.byteOffset + avatarBytes.byteLength) : null;
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO recipients (slug, display_name, accent, kind) VALUES (?, ?, ?, 'profile')
      `).bind(recipientSlug, validation.value.displayName, accent),
      env.DB.prepare(`
        INSERT INTO profiles (
          id, recipient_id, slug, display_name, description, ducks_url, visibility, letter_visibility, letter_password_hash, avatar_media_type,
          avatar_blob, idempotency_key, request_hash
        )
        SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM recipients WHERE slug = ?
      `).bind(
        id, slug, validation.value.displayName, validation.value.description, validation.value.ducksUrl,
        validation.value.visibility, validation.value.letterVisibility, letterPasswordHash, validation.value.avatar?.mediaType ?? null,
        avatarBuffer, idempotencyKey, requestHash, recipientSlug
      )
    ]);
  } catch (error) {
    const raced = await env.DB.prepare("SELECT slug, request_hash FROM profiles WHERE idempotency_key = ?").bind(idempotencyKey).first();
    if (raced?.request_hash === requestHash) return json({ slug: raced.slug, created: false }, 200, request, env);
    throw error;
  }
  return json({ slug, created: true }, 201, request, env);
}

async function listProfileLetters(request, env, url, slug) {
  const profile = await getActiveProfile(env, slug);
  if (!profile) return fail("Perfil não encontrado.", 404, request, env, "profile_not_found");
  if (profile.letter_visibility === "protected") {
    const accessToken = request.headers.get("x-profile-access-token")?.trim() ?? "";
    if (!accessToken) return fail("Digite a senha deste perfil para ver os recados.", 401, request, env, "profile_locked");
    const tokenHash = await sha256(accessToken);
    const access = await env.DB.prepare(`
      SELECT token_hash FROM profile_access_tokens
      WHERE token_hash = ? AND profile_id = ? AND expires_at > ?
    `).bind(tokenHash, profile.id, new Date().toISOString()).first();
    if (!access) return fail("O acesso salvo expirou. Digite a senha novamente.", 401, request, env, "profile_access_expired");
  }
  const limit = parsePositiveInt(url.searchParams.get("limit"), 24, 50);
  const page = parsePositiveInt(url.searchParams.get("page"), 1, 1000);
  const offset = (page - 1) * limit;
  const result = await env.DB.prepare(`
    SELECT l.id, l.body, l.created_at, l.report_count, l.reaction_count,
           r.slug AS recipient_slug, r.display_name AS recipient_name, r.accent AS recipient_accent
    FROM letters l JOIN recipients r ON r.id = l.recipient_id
    WHERE l.status = 'published' AND l.recipient_id = ?
    ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?
  `).bind(profile.recipient_id, limit + 1, offset).all();
  const rows = result.results ?? [];
  const cacheControl = profile.letter_visibility === "public" ? "public, max-age=15" : "no-store";
  return json({ profile: profileJson(profile), letters: rows.slice(0, limit).map(publicLetter), page, hasMore: rows.length > limit }, 200, request, env, { "cache-control": cacheControl });
}

async function unlockProfile(request, env, slug) {
  // Uma chave de rota fixa evita que slugs inventados criem buckets ilimitados no D1.
  const rate = await enforceRateLimit(request, env, "profile-unlock", 10, 900);
  if (!rate.allowed) return json({ error: { code: "rate_limited", message: "Muitas tentativas. Aguarde um pouco antes de tentar novamente." } }, 429, request, env, { "retry-after": String(rate.retryAfter) });
  const validation = validateProfilePasswordInput(await readJson(request));
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const profile = await getActiveProfile(env, slug);
  if (!profile) return fail("Perfil não encontrado.", 404, request, env, "profile_not_found");
  if (profile.letter_visibility !== "protected") return fail("Este perfil não exige senha.", 409, request, env, "profile_not_protected");
  if (!profile.letter_password_hash) return fail("A Staff ainda não definiu a senha deste perfil.", 409, request, env, "profile_password_unconfigured");
  if (!(await verifyPassword(validation.value.password, profile.letter_password_hash))) {
    return fail("Senha incorreta.", 401, request, env, "invalid_profile_password");
  }
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const configuredDays = Number.parseInt(env.PROFILE_ACCESS_TTL_DAYS ?? "365", 10);
  const ttlDays = Number.isFinite(configuredDays) ? Math.min(Math.max(configuredDays, 1), 730) : 365;
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM profile_access_tokens WHERE expires_at <= ?").bind(new Date().toISOString()),
    env.DB.prepare(`
      INSERT INTO profile_access_tokens (token_hash, profile_id, expires_at) VALUES (?, ?, ?)
    `).bind(tokenHash, profile.id, expiresAt)
  ]);
  return json({ token, expiresAt }, 200, request, env);
}

async function createProfileLetter(request, env, slug) {
  const rate = await enforceRateLimit(request, env, "create-profile-letter", 5, 600);
  if (!rate.allowed) return json({ error: { code: "rate_limited", message: "Muitos recados em pouco tempo. Tente novamente mais tarde." } }, 429, request, env, { "retry-after": String(rate.retryAfter) });
  const profile = await getActiveProfile(env, slug);
  if (!profile) return fail("Perfil não encontrado.", 404, request, env, "profile_not_found");
  const validation = validateLetterInput({ ...(await readJson(request)), recipient: profile.recipient_slug });
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) return fail("A chave de idempotência está ausente ou inválida.", 400, request, env, "invalid_idempotency_key");
  const requestHash = await sha256(JSON.stringify({ profile: slug, body: validation.value.body }));
  const existing = await env.DB.prepare("SELECT id, request_hash FROM letters WHERE idempotency_key = ?").bind(idempotencyKey).first();
  if (existing) {
    if (existing.request_hash !== requestHash) return fail("Essa chave já foi usada para outro recado.", 409, request, env, "idempotency_conflict");
    return json({ id: existing.id, created: false }, 200, request, env);
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`
      INSERT INTO letters (id, recipient_id, body, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?)
    `).bind(id, profile.recipient_id, validation.value.body, idempotencyKey, requestHash).run();
  } catch (error) {
    const raced = await env.DB.prepare("SELECT id, request_hash FROM letters WHERE idempotency_key = ?").bind(idempotencyKey).first();
    if (raced?.request_hash === requestHash) return json({ id: raced.id, created: false }, 200, request, env);
    throw error;
  }
  return json({ id, created: true }, 201, request, env);
}

async function createLetter(request, env) {
  const rate = await enforceRateLimit(request, env, "create-letter", 5, 600);
  if (!rate.allowed) return json({ error: { code: "rate_limited", message: "Muitos recados em pouco tempo. Tente novamente mais tarde." } }, 429, request, env, { "retry-after": String(rate.retryAfter) });
  const validation = validateLetterInput(await readJson(request));
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
    return fail("A chave de idempotência está ausente ou inválida.", 400, request, env, "invalid_idempotency_key");
  }
  const requestHash = await sha256(JSON.stringify(validation.value));
  const existing = await env.DB.prepare("SELECT id, request_hash FROM letters WHERE idempotency_key = ?").bind(idempotencyKey).first();
  if (existing) {
    if (existing.request_hash !== requestHash) return fail("Essa chave já foi usada para outro recado.", 409, request, env, "idempotency_conflict");
    return json({ id: existing.id, created: false }, 200, request, env);
  }
  const recipient = await env.DB.prepare(`
    SELECT r.id, r.kind
    FROM recipients r
    LEFT JOIN profiles p ON p.recipient_id = r.id
    WHERE r.active = 1
      AND ((r.kind = 'community' AND r.slug = ?)
        OR (r.kind = 'profile' AND p.slug = ? AND p.status = 'active' AND p.visibility = 'public'))
    LIMIT 1
  `).bind(validation.value.recipient, validation.value.recipient).first();
  if (!recipient) return fail("Destinatário não encontrado.", 404, request, env, "recipient_not_found");
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`
      INSERT INTO letters (id, recipient_id, body, idempotency_key, request_hash)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, recipient.id, validation.value.body, idempotencyKey, requestHash).run();
  } catch (error) {
    const raced = await env.DB.prepare("SELECT id, request_hash FROM letters WHERE idempotency_key = ?").bind(idempotencyKey).first();
    if (raced?.request_hash === requestHash) return json({ id: raced.id, created: false }, 200, request, env);
    throw error;
  }
  return json({ id, created: true }, 201, request, env);
}

async function reportLetter(request, env, letterId) {
  const rate = await enforceRateLimit(request, env, "report-letter", 8, 3600);
  if (!rate.allowed) return json({ error: { code: "rate_limited", message: "Limite de denúncias atingido. Tente novamente mais tarde." } }, 429, request, env, { "retry-after": String(rate.retryAfter) });
  const body = await readJson(request);
  const reason = String(body?.reason ?? "");
  if (!REPORT_REASONS.has(reason)) return fail("Motivo de denúncia inválido.", 422, request, env, "validation_error");
  const letter = await env.DB.prepare(`
    SELECT l.id, l.status FROM letters l
    JOIN recipients r ON r.id = l.recipient_id
    LEFT JOIN profiles p ON p.recipient_id = r.id
    WHERE l.id = ? AND (r.kind = 'community' OR p.status = 'active')
  `).bind(letterId).first();
  if (!letter || letter.status === "deleted") return fail("Cartinha não encontrada.", 404, request, env, "not_found");
  const reportId = crypto.randomUUID();
  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO reports (id, letter_id, reason, reporter_fingerprint)
    VALUES (?, ?, ?, ?)
  `).bind(reportId, letterId, reason, rate.fingerprint).run();
  if (!inserted.meta?.changes) return json({ reported: false, duplicate: true }, 200, request, env);
  await env.DB.prepare("UPDATE letters SET report_count = report_count + 1 WHERE id = ?").bind(letterId).run();
  const threshold = parsePositiveInt(env.REPORT_AUTO_FLAG_THRESHOLD, 3, 20);
  const updated = await env.DB.prepare("SELECT report_count FROM letters WHERE id = ?").bind(letterId).first();
  if (Number(updated.report_count) >= threshold) {
    await env.DB.prepare("UPDATE letters SET status = 'hidden', moderation_note = 'Ocultada automaticamente por denúncias' WHERE id = ? AND status = 'published'").bind(letterId).run();
  }
  return json({ reported: true }, 201, request, env);
}

async function reactToLetter(request, env, letterId) {
  const rate = await enforceRateLimit(request, env, "react-letter", 30, 3600);
  if (!rate.allowed) return json({ error: { code: "rate_limited", message: "Muitos brilhos em pouco tempo. Tente novamente mais tarde." } }, 429, request, env, { "retry-after": String(rate.retryAfter) });
  const letter = await env.DB.prepare(`
    SELECT l.id FROM letters l
    JOIN recipients r ON r.id = l.recipient_id
    LEFT JOIN profiles p ON p.recipient_id = r.id
    WHERE l.id = ? AND l.status = 'published' AND (r.kind = 'community' OR p.status = 'active')
  `).bind(letterId).first();
  if (!letter) return fail("Cartinha não encontrada.", 404, request, env, "not_found");
  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO reactions (letter_id, reactor_fingerprint) VALUES (?, ?)
  `).bind(letterId, rate.fingerprint).run();
  if (inserted.meta?.changes) {
    await env.DB.prepare("UPDATE letters SET reaction_count = reaction_count + 1 WHERE id = ?").bind(letterId).run();
  }
  const updated = await env.DB.prepare("SELECT reaction_count FROM letters WHERE id = ?").bind(letterId).first();
  return json({ reacted: Boolean(inserted.meta?.changes), reactions: Number(updated?.reaction_count ?? 0) }, inserted.meta?.changes ? 201 : 200, request, env);
}

async function bootstrapModerator(request, env) {
  if (!env.BOOTSTRAP_TOKEN || String(env.BOOTSTRAP_TOKEN).length < 32) {
    return fail("Bootstrap não configurado com segurança.", 503, request, env, "bootstrap_unavailable");
  }
  if (!(await safeEqual(request.headers.get("x-bootstrap-token"), env.BOOTSTRAP_TOKEN))) {
    return fail("Token de bootstrap inválido.", 401, request, env, "unauthorized");
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM moderators").first();
  if (Number(count?.count ?? 0) > 0) return fail("O primeiro moderador já foi criado.", 409, request, env, "already_bootstrapped");
  return insertModerator(request, env, await readJson(request), null, "bootstrap");
}

async function insertModerator(request, env, input, actor, action = "moderator.create") {
  const validation = validateModeratorInput(input);
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(validation.value.password);
  try {
    await env.DB.prepare(`
      INSERT INTO moderators (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)
    `).bind(id, validation.value.username, validation.value.displayName, passwordHash).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return fail("Esse usuário já existe.", 409, request, env, "username_conflict");
    throw error;
  }
  await env.DB.prepare(`
    INSERT INTO audit_log (moderator_id, action, target_type, target_id, details) VALUES (?, ?, 'moderator', ?, ?)
  `).bind(actor?.id ?? id, action, id, JSON.stringify({ username: validation.value.username })).run();
  return json({ moderator: { id, username: validation.value.username, displayName: validation.value.displayName, active: true } }, 201, request, env);
}

async function login(request, env) {
  const rate = await enforceRateLimit(request, env, "login", 10, 900);
  if (!rate.allowed) return json({ error: { code: "rate_limited", message: "Muitas tentativas de acesso. Aguarde antes de tentar novamente." } }, 429, request, env, { "retry-after": String(rate.retryAfter) });
  const body = await readJson(request);
  const username = String(body?.username ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  const moderator = await env.DB.prepare(
    "SELECT id, username, display_name, password_hash FROM moderators WHERE username = ? AND active = 1"
  ).bind(username).first();
  const passwordMatches = await verifyPassword(password, moderator?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!moderator || !passwordMatches) {
    return fail("Usuário ou senha inválidos.", 401, request, env, "invalid_credentials");
  }
  const token = randomToken();
  const tokenHash = await sha256(token);
  const ttlHours = parsePositiveInt(env.SESSION_TTL_HOURS, 8, 24);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()),
    env.DB.prepare("INSERT INTO sessions (token_hash, moderator_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, moderator.id, expiresAt)
  ]);
  return json({ token, expiresAt, moderator: { id: moderator.id, username: moderator.username, displayName: moderator.display_name } }, 200, request, env);
}

async function logout(request, env, moderator) {
  const token = request.headers.get("authorization").slice(7).trim();
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  await env.DB.prepare("INSERT INTO audit_log (moderator_id, action, target_type, target_id) VALUES (?, 'session.logout', 'moderator', ?)").bind(moderator.id, moderator.id).run();
  return new Response(null, { status: 204, headers: securityHeaders(request.headers.get("origin"), env) });
}

async function listAdminLetters(request, env, url) {
  const status = String(url.searchParams.get("status") ?? "all");
  const bindings = [];
  let where = "1 = 1";
  if (["published", "hidden", "deleted"].includes(status)) {
    where = "l.status = ?";
    bindings.push(status);
  }
  const result = await env.DB.prepare(`
    SELECT l.id, l.body, l.status, l.report_count, l.reaction_count, l.created_at, l.moderated_at, l.moderation_note,
           r.slug AS recipient_slug, r.display_name AS recipient_name, r.accent AS recipient_accent,
           p.slug AS profile_slug,
           m.display_name AS moderated_by_name
    FROM letters l
    JOIN recipients r ON r.id = l.recipient_id
    LEFT JOIN profiles p ON p.recipient_id = r.id
    LEFT JOIN moderators m ON m.id = l.moderated_by
    WHERE ${where}
    ORDER BY CASE WHEN l.report_count > 0 THEN 0 ELSE 1 END, l.created_at DESC
    LIMIT 200
  `).bind(...bindings).all();
  return json({ letters: result.results ?? [] }, 200, request, env);
}

async function moderateLetter(request, env, letterId, moderator) {
  const validation = validateModerationInput(await readJson(request));
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const result = await env.DB.prepare(`
    UPDATE letters SET status = ?, moderation_note = ?, moderated_at = ?, moderated_by = ? WHERE id = ?
  `).bind(validation.value.status, validation.value.note || null, new Date().toISOString(), moderator.id, letterId).run();
  if (!result.meta?.changes) return fail("Cartinha não encontrada.", 404, request, env, "not_found");
  await env.DB.prepare(`
    INSERT INTO audit_log (moderator_id, action, target_type, target_id, details) VALUES (?, 'letter.moderate', 'letter', ?, ?)
  `).bind(moderator.id, letterId, JSON.stringify(validation.value)).run();
  return json({ updated: true, status: validation.value.status }, 200, request, env);
}

async function listAdminProfiles(request, env, url) {
  const status = String(url.searchParams.get("status") ?? "all");
  const bindings = [];
  let where = "1 = 1";
  if (["active", "hidden", "deleted"].includes(status)) {
    where = "p.status = ?";
    bindings.push(status);
  }
  const result = await env.DB.prepare(`
    SELECT p.id, p.slug, p.display_name, p.description, p.ducks_url, p.visibility, p.letter_visibility,
           CASE WHEN p.letter_password_hash IS NULL THEN 0 ELSE 1 END AS password_configured, p.avatar_media_type,
           p.status, p.created_at, p.moderated_at, p.moderation_note,
           COUNT(l.id) AS letter_count, m.display_name AS moderated_by_name
    FROM profiles p
    LEFT JOIN letters l ON l.recipient_id = p.recipient_id
    LEFT JOIN moderators m ON m.id = p.moderated_by
    WHERE ${where}
    GROUP BY p.id
    ORDER BY p.created_at DESC LIMIT 200
  `).bind(...bindings).all();
  return json({ profiles: result.results ?? [] }, 200, request, env);
}

async function moderateProfile(request, env, profileId, moderator) {
  const validation = validateProfileModerationInput(await readJson(request));
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const result = await env.DB.prepare(`
    UPDATE profiles SET status = ?, moderation_note = ?, moderated_at = ?, moderated_by = ? WHERE id = ?
  `).bind(validation.value.status, validation.value.note || null, new Date().toISOString(), moderator.id, profileId).run();
  if (!result.meta?.changes) return fail("Perfil não encontrado.", 404, request, env, "not_found");
  await env.DB.prepare(`
    INSERT INTO audit_log (moderator_id, action, target_type, target_id, details) VALUES (?, 'profile.moderate', 'profile', ?, ?)
  `).bind(moderator.id, profileId, JSON.stringify(validation.value)).run();
  return json({ updated: true, status: validation.value.status }, 200, request, env);
}

async function setProfileVisibility(request, env, profileId, moderator) {
  const validation = validateProfileVisibilityInput(await readJson(request));
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const result = await env.DB.prepare(
    "UPDATE profiles SET visibility = ? WHERE id = ?"
  ).bind(validation.value.visibility, profileId).run();
  if (!result.meta?.changes) return fail("Perfil não encontrado.", 404, request, env, "not_found");
  await env.DB.prepare(`
    INSERT INTO audit_log (moderator_id, action, target_type, target_id, details) VALUES (?, 'profile.visibility', 'profile', ?, ?)
  `).bind(moderator.id, profileId, JSON.stringify(validation.value)).run();
  return json({ updated: true, visibility: validation.value.visibility }, 200, request, env);
}

async function setProfileLetterVisibility(request, env, profileId, moderator) {
  const validation = validateProfileLetterVisibilityInput(await readJson(request));
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const result = await env.DB.prepare(
    "UPDATE profiles SET letter_visibility = ? WHERE id = ?"
  ).bind(validation.value.letterVisibility, profileId).run();
  if (!result.meta?.changes) return fail("Perfil não encontrado.", 404, request, env, "not_found");
  await env.DB.prepare(`
    INSERT INTO audit_log (moderator_id, action, target_type, target_id, details)
    VALUES (?, 'profile.letter_visibility', 'profile', ?, ?)
  `).bind(moderator.id, profileId, JSON.stringify(validation.value)).run();
  return json({ updated: true, letterVisibility: validation.value.letterVisibility }, 200, request, env);
}

async function setProfilePassword(request, env, profileId, moderator) {
  const validation = validateProfilePasswordInput(await readJson(request));
  if (!validation.ok) return fail(validation.error, 422, request, env, "validation_error");
  const profile = await env.DB.prepare("SELECT id FROM profiles WHERE id = ?").bind(profileId).first();
  if (!profile) return fail("Perfil não encontrado.", 404, request, env, "not_found");
  const passwordHash = await hashPassword(validation.value.password);
  await env.DB.batch([
    env.DB.prepare("UPDATE profiles SET letter_password_hash = ?, letter_visibility = 'protected' WHERE id = ?").bind(passwordHash, profileId),
    env.DB.prepare("DELETE FROM profile_access_tokens WHERE profile_id = ?").bind(profileId),
    env.DB.prepare(`
      INSERT INTO audit_log (moderator_id, action, target_type, target_id, details)
      VALUES (?, 'profile.password_reset', 'profile', ?, ?)
    `).bind(moderator.id, profileId, JSON.stringify({ passwordConfigured: true, tokensRevoked: true }))
  ]);
  return json({ updated: true, letterVisibility: "protected", passwordConfigured: true }, 200, request, env);
}

async function listModerators(request, env) {
  const result = await env.DB.prepare(
    "SELECT id, username, display_name, active, created_at FROM moderators ORDER BY display_name"
  ).all();
  return json({ moderators: (result.results ?? []).map((row) => ({ ...row, active: Boolean(row.active) })) }, 200, request, env);
}

async function setModeratorActive(request, env, targetId, moderator) {
  if (targetId === moderator.id) return fail("Você não pode desativar a própria conta.", 409, request, env, "self_deactivation");
  const body = await readJson(request);
  if (typeof body?.active !== "boolean") return fail("Informe o estado ativo como verdadeiro ou falso.", 422, request, env, "validation_error");
  const result = await env.DB.prepare("UPDATE moderators SET active = ?, updated_at = ? WHERE id = ?").bind(body.active ? 1 : 0, new Date().toISOString(), targetId).run();
  if (!result.meta?.changes) return fail("Moderador não encontrado.", 404, request, env, "not_found");
  if (!body.active) await env.DB.prepare("DELETE FROM sessions WHERE moderator_id = ?").bind(targetId).run();
  await env.DB.prepare(`
    INSERT INTO audit_log (moderator_id, action, target_type, target_id, details) VALUES (?, 'moderator.active', 'moderator', ?, ?)
  `).bind(moderator.id, targetId, JSON.stringify({ active: body.active })).run();
  return json({ updated: true, active: body.active }, 200, request, env);
}

async function listAudit(request, env) {
  const result = await env.DB.prepare(`
    SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.created_at,
           m.display_name AS moderator_name
    FROM audit_log a LEFT JOIN moderators m ON m.id = a.moderator_id
    ORDER BY a.created_at DESC LIMIT 100
  `).all();
  return json({ entries: result.results ?? [] }, 200, request, env);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  if (request.method === "OPTIONS") {
    const origin = allowedOrigin(request.headers.get("origin"), env.ALLOWED_ORIGINS);
    if (!origin) return new Response(null, { status: 403, headers: securityHeaders(null, env) });
    return new Response(null, { status: 204, headers: {
      ...securityHeaders(origin, env),
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key, X-Bootstrap-Token, X-Profile-Access-Token",
      "access-control-max-age": "86400"
    } });
  }
  if (request.method === "GET" && path === "/health") return json({ ok: true }, 200, request, env, { "cache-control": "public, max-age=60" });
  if (request.method === "GET" && path === "/recipients") return listRecipients(request, env);
  if (request.method === "POST" && path === "/profiles") return createProfile(request, env);
  const profileAvatarMatch = path.match(/^\/profiles\/([a-z0-9-]{3,80})\/avatar$/);
  if (request.method === "GET" && profileAvatarMatch) return getProfileAvatar(request, env, profileAvatarMatch[1]);
  const profileLettersMatch = path.match(/^\/profiles\/([a-z0-9-]{3,80})\/letters$/);
  if (request.method === "GET" && profileLettersMatch) return listProfileLetters(request, env, url, profileLettersMatch[1]);
  if (request.method === "POST" && profileLettersMatch) return createProfileLetter(request, env, profileLettersMatch[1]);
  const profileUnlockMatch = path.match(/^\/profiles\/([a-z0-9-]{3,80})\/unlock$/);
  if (request.method === "POST" && profileUnlockMatch) return unlockProfile(request, env, profileUnlockMatch[1]);
  const profileMatch = path.match(/^\/profiles\/([a-z0-9-]{3,80})$/);
  if (request.method === "GET" && profileMatch) return getProfile(request, env, profileMatch[1]);
  if (request.method === "GET" && path === "/letters") return listPublicLetters(request, env, url);
  if (request.method === "POST" && path === "/letters") return createLetter(request, env);
  const reportMatch = path.match(/^\/letters\/([0-9a-f-]+)\/reports$/i);
  if (request.method === "POST" && reportMatch) return reportLetter(request, env, reportMatch[1]);
  const reactionMatch = path.match(/^\/letters\/([0-9a-f-]+)\/reactions$/i);
  if (request.method === "POST" && reactionMatch) return reactToLetter(request, env, reactionMatch[1]);
  if (request.method === "POST" && path === "/admin/bootstrap") return bootstrapModerator(request, env);
  if (request.method === "POST" && path === "/admin/login") return login(request, env);

  if (path.startsWith("/admin/")) {
    const authentication = await requireModerator(request, env);
    if (authentication.response) return authentication.response;
    const moderator = authentication.moderator;
    if (request.method === "GET" && path === "/admin/me") return json({ moderator: { id: moderator.id, username: moderator.username, displayName: moderator.display_name } }, 200, request, env);
    if (request.method === "POST" && path === "/admin/logout") return logout(request, env, moderator);
    if (request.method === "GET" && path === "/admin/letters") return listAdminLetters(request, env, url);
    const letterMatch = path.match(/^\/admin\/letters\/([0-9a-f-]+)$/i);
    if (request.method === "PATCH" && letterMatch) return moderateLetter(request, env, letterMatch[1], moderator);
    if (request.method === "GET" && path === "/admin/profiles") return listAdminProfiles(request, env, url);
    const profileVisibilityMatch = path.match(/^\/admin\/profiles\/([0-9a-f-]+)\/visibility$/i);
    if (request.method === "PATCH" && profileVisibilityMatch) return setProfileVisibility(request, env, profileVisibilityMatch[1], moderator);
    const profileLetterVisibilityMatch = path.match(/^\/admin\/profiles\/([0-9a-f-]+)\/letter-visibility$/i);
    if (request.method === "PATCH" && profileLetterVisibilityMatch) return setProfileLetterVisibility(request, env, profileLetterVisibilityMatch[1], moderator);
    const profilePasswordMatch = path.match(/^\/admin\/profiles\/([0-9a-f-]+)\/letter-password$/i);
    if (request.method === "PUT" && profilePasswordMatch) return setProfilePassword(request, env, profilePasswordMatch[1], moderator);
    const adminProfileMatch = path.match(/^\/admin\/profiles\/([0-9a-f-]+)$/i);
    if (request.method === "PATCH" && adminProfileMatch) return moderateProfile(request, env, adminProfileMatch[1], moderator);
    if (request.method === "GET" && path === "/admin/moderators") return listModerators(request, env);
    if (request.method === "POST" && path === "/admin/moderators") return insertModerator(request, env, await readJson(request), moderator);
    const moderatorMatch = path.match(/^\/admin\/moderators\/([0-9a-f-]+)$/i);
    if (request.method === "PATCH" && moderatorMatch) return setModeratorActive(request, env, moderatorMatch[1], moderator);
    if (request.method === "GET" && path === "/admin/audit") return listAudit(request, env);
  }
  return fail("Rota não encontrada.", 404, request, env, "not_found");
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof SyntaxError) return fail("JSON inválido.", 400, request, env, "invalid_json");
      if (error?.message === "payload_too_large") return fail("Requisição grande demais.", 413, request, env, "payload_too_large");
      console.error("Unhandled worker error", error);
      return fail("Não foi possível concluir a operação.", 500, request, env, "internal_error");
    }
  }
};
