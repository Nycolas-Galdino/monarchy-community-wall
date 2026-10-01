import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const origin = "http://localhost:8080";

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  return exports.default.fetch(`https://wall.test/api${path}`, {
    method,
    headers: {
      origin,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

describe("community wall API", () => {
  it("persists, deduplicates, moderates and audits a complete flow", async () => {
    const recipientsResponse = await request("/recipients");
    expect(recipientsResponse.status).toBe(200);
    const initialRecipients = (await recipientsResponse.json()).recipients;
    expect(initialRecipients.map((item) => item.slug)).toEqual(["moderacao", "comunidade"]);
    expect(initialRecipients.find((item) => item.slug === "moderacao")?.name).toBe("Staff");
    expect(initialRecipients.some((item) => item.slug === "kisuke")).toBe(false);

    const idempotencyKey = "test_letter_key_123456789";
    const created = await request("/letters", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey, "cf-connecting-ip": "192.0.2.10" },
      body: { recipient: "moderacao", body: "Você torna a comunidade mais acolhedora!" }
    });
    expect(created.status).toBe(201);
    const letterId = (await created.json()).id;

    const duplicate = await request("/letters", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey, "cf-connecting-ip": "192.0.2.10" },
      body: { recipient: "moderacao", body: "Você torna a comunidade mais acolhedora!" }
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).created).toBe(false);

    const publicList = await request("/letters");
    const publicLetter = (await publicList.json()).letters[0];
    expect(publicLetter.body).toContain("acolhedora");

    const reaction = await request(`/letters/${letterId}/reactions`, { method: "POST", headers: { "cf-connecting-ip": "192.0.2.20" } });
    expect(reaction.status).toBe(201);
    expect((await reaction.json()).reactions).toBe(1);
    const duplicateReaction = await request(`/letters/${letterId}/reactions`, { method: "POST", headers: { "cf-connecting-ip": "192.0.2.20" } });
    expect((await duplicateReaction.json()).reacted).toBe(false);

    const report = await request(`/letters/${letterId}/reports`, { method: "POST", headers: { "cf-connecting-ip": "192.0.2.30" }, body: { reason: "other" } });
    expect(report.status).toBe(201);

    const bootstrap = await request("/admin/bootstrap", {
      method: "POST",
      headers: { "x-bootstrap-token": "bootstrap-token-with-at-least-32-characters" },
      body: { username: "admin", displayName: "Admin Principal", password: "senha-inicial-muito-segura" }
    });
    expect(bootstrap.status).toBe(201);
    const secondBootstrap = await request("/admin/bootstrap", {
      method: "POST",
      headers: { "x-bootstrap-token": "bootstrap-token-with-at-least-32-characters" },
      body: { username: "outro", displayName: "Outro", password: "outra-senha-muito-segura" }
    });
    expect(secondBootstrap.status).toBe(409);

    const login = await request("/admin/login", { method: "POST", headers: { "cf-connecting-ip": "192.0.2.40" }, body: { username: "admin", password: "senha-inicial-muito-segura" } });
    expect(login.status).toBe(200);
    const loginBody = await login.json();
    expect(loginBody).not.toHaveProperty("password_hash");
    const token = loginBody.token;
    expect(token.length).toBeGreaterThan(30);

    const profileKey = "test_profile_key_123456789";
    const avatarData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const profileCreated = await request("/profiles", {
      method: "POST",
      headers: { "idempotency-key": profileKey, "cf-connecting-ip": "192.0.2.60" },
      body: {
        displayName: "Lila Monarchy",
        description: "Pergunte anonimamente.",
        ducksUrl: "https://app.duckapps.com.br/lila#bio",
        avatar: { mediaType: "image/png", data: avatarData }
      }
    });
    expect(profileCreated.status).toBe(201);
    const profileSlug = (await profileCreated.json()).slug;
    expect(profileSlug).toMatch(/^lila-monarchy-[a-z0-9-]+$/);

    const profileDuplicate = await request("/profiles", {
      method: "POST",
      headers: { "idempotency-key": profileKey, "cf-connecting-ip": "192.0.2.60" },
      body: {
        displayName: "Lila Monarchy",
        description: "Pergunte anonimamente.",
        ducksUrl: "https://app.duckapps.com.br/lila#bio",
        avatar: { mediaType: "image/png", data: avatarData }
      }
    });
    expect(profileDuplicate.status).toBe(200);
    expect((await profileDuplicate.json()).created).toBe(false);

    const profileResponse = await request(`/profiles/${profileSlug}`);
    expect(profileResponse.status).toBe(200);
    const profile = (await profileResponse.json()).profile;
    expect(profile.displayName).toBe("Lila Monarchy");
    expect(profile.ducksUrl).toBe("https://app.duckapps.com.br/lila");
    expect(profile.visibility).toBe("public");
    expect(profile.hasAvatar).toBe(true);

    const recipientsWithProfile = (await (await request("/recipients")).json()).recipients;
    const profileRecipient = recipientsWithProfile.find((item) => item.slug === profileSlug);
    expect(profileRecipient).toMatchObject({ name: "Lila Monarchy", kind: "profile", hasAvatar: true });

    const avatarResponse = await request(`/profiles/${profileSlug}/avatar`);
    expect(avatarResponse.status).toBe(200);
    expect(avatarResponse.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await avatarResponse.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const profileLetter = await request("/letters", {
      method: "POST",
      headers: { "idempotency-key": "test_profile_letter_123456789", "cf-connecting-ip": "192.0.2.61" },
      body: { recipient: profileSlug, body: "Esse recado aparece somente no mural pessoal." }
    });
    expect(profileLetter.status).toBe(201);
    const profileList = await request(`/profiles/${profileSlug}/letters`);
    expect((await profileList.json()).letters[0].body).toContain("somente no mural pessoal");
    const globalAfterProfile = await request("/letters");
    expect((await globalAfterProfile.json()).letters.some((item) => item.body.includes("somente no mural pessoal"))).toBe(false);

    const privateCreated = await request("/profiles", {
      method: "POST",
      headers: { "idempotency-key": "test_private_profile_key_123456789", "cf-connecting-ip": "192.0.2.70" },
      body: { displayName: "Mural Reservado", description: "Somente pelo link.", visibility: "private" }
    });
    expect(privateCreated.status).toBe(201);
    const privateSlug = (await privateCreated.json()).slug;
    const privateProfileResponse = await request(`/profiles/${privateSlug}`);
    expect(privateProfileResponse.status).toBe(200);
    expect((await privateProfileResponse.json()).profile.visibility).toBe("private");
    expect((await (await request("/recipients")).json()).recipients.some((item) => item.slug === privateSlug)).toBe(false);

    const privateOutsideLink = await request("/letters", {
      method: "POST",
      headers: { "idempotency-key": "test_private_outside_key_123456789", "cf-connecting-ip": "192.0.2.71" },
      body: { recipient: privateSlug, body: "Tentativa fora do link privado." }
    });
    expect(privateOutsideLink.status).toBe(404);
    const privateInsideLink = await request(`/profiles/${privateSlug}/letters`, {
      method: "POST",
      headers: { "idempotency-key": "test_private_inside_key_123456789", "cf-connecting-ip": "192.0.2.71" },
      body: { body: "Cartinha entregue pelo link privado." }
    });
    expect(privateInsideLink.status).toBe(201);
    expect((await (await request(`/profiles/${privateSlug}/letters`)).json()).letters[0].body).toContain("link privado");
    expect((await (await request("/letters")).json()).letters.some((item) => item.body.includes("link privado"))).toBe(false);

    const protectedCreated = await request("/profiles", {
      method: "POST",
      headers: { "idempotency-key": "test_protected_profile_123456", "cf-connecting-ip": "192.0.2.80" },
      body: { displayName: "Mural Protegido", letterVisibility: "protected", password: "senha-inicial-do-perfil" }
    });
    expect(protectedCreated.status).toBe(201);
    const protectedSlug = (await protectedCreated.json()).slug;
    const protectedMetadata = (await (await request(`/profiles/${protectedSlug}`)).json()).profile;
    expect(protectedMetadata).toMatchObject({ letterVisibility: "protected", passwordConfigured: true });
    expect(protectedMetadata).not.toHaveProperty("letter_password_hash");
    const protectedLetter = await request(`/profiles/${protectedSlug}/letters`, {
      method: "POST",
      headers: { "idempotency-key": "protected_letter_key_123456", "cf-connecting-ip": "192.0.2.81" },
      body: { body: "Este recado exige o acesso do perfil para leitura." }
    });
    expect(protectedLetter.status).toBe(201);
    expect((await request(`/profiles/${protectedSlug}/letters`)).status).toBe(401);

    const profilesAdmin = await request("/admin/profiles", { token });
    const protectedAdmin = (await profilesAdmin.clone().json()).profiles.find((item) => item.slug === protectedSlug);
    expect(protectedAdmin).toMatchObject({ letter_visibility: "protected", password_configured: 1 });
    expect(protectedAdmin).not.toHaveProperty("letter_password_hash");
    expect(protectedAdmin).not.toHaveProperty("password");
    expect((await request(`/admin/profiles/${protectedAdmin.id}/letter-password`, { method: "PUT", token, body: { password: "curta" } })).status).toBe(422);
    const protectedAfterPassword = (await (await request(`/profiles/${protectedSlug}`)).json()).profile;
    expect(protectedAfterPassword.passwordConfigured).toBe(true);
    expect(protectedAfterPassword).not.toHaveProperty("letterPasswordHash");
    const wrongUnlock = await request(`/profiles/${protectedSlug}/unlock`, { method: "POST", headers: { "cf-connecting-ip": "192.0.2.82" }, body: { password: "senha-totalmente-errada" } });
    expect(wrongUnlock.status).toBe(401);
    const unlock = await request(`/profiles/${protectedSlug}/unlock`, { method: "POST", headers: { "cf-connecting-ip": "192.0.2.83" }, body: { password: "senha-inicial-do-perfil" } });
    expect(unlock.status).toBe(200);
    const access = await unlock.json();
    expect(access.token.length).toBeGreaterThan(30);
    const unlockedLetters = await request(`/profiles/${protectedSlug}/letters`, { headers: { "x-profile-access-token": access.token } });
    expect(unlockedLetters.status).toBe(200);
    expect((await unlockedLetters.json()).letters[0].body).toContain("exige o acesso");
    const passwordReset = await request(`/admin/profiles/${protectedAdmin.id}/letter-password`, { method: "PUT", token, body: { password: "senha-nova-do-perfil" } });
    expect(passwordReset.status).toBe(200);
    expect((await request(`/profiles/${protectedSlug}/letters`, { headers: { "x-profile-access-token": access.token } })).status).toBe(401);
    expect((await request(`/profiles/${protectedSlug}/unlock`, { method: "POST", headers: { "cf-connecting-ip": "192.0.2.84" }, body: { password: "senha-inicial-do-perfil" } })).status).toBe(401);
    const newUnlock = await request(`/profiles/${protectedSlug}/unlock`, { method: "POST", headers: { "cf-connecting-ip": "192.0.2.85" }, body: { password: "senha-nova-do-perfil" } });
    expect(newUnlock.status).toBe(200);
    const openLetters = await request(`/admin/profiles/${protectedAdmin.id}/letter-visibility`, { method: "PATCH", token, body: { letterVisibility: "public" } });
    expect(openLetters.status).toBe(200);
    expect((await request(`/profiles/${protectedSlug}/letters`)).status).toBe(200);
    expect((await request(`/admin/profiles/${protectedAdmin.id}/letter-visibility`, { method: "PATCH", body: { letterVisibility: "protected" } })).status).toBe(401);
    expect((await request(`/admin/profiles/${protectedAdmin.id}/letter-visibility`, { method: "PATCH", token, body: { letterVisibility: "secret" } })).status).toBe(422);
    expect((await request(`/admin/profiles/${protectedAdmin.id}/letter-visibility`, { method: "PATCH", token, body: { letterVisibility: "protected" } })).status).toBe(200);
    let profileRateLimited;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      profileRateLimited = await request(`/profiles/${protectedSlug}/unlock`, { method: "POST", headers: { "cf-connecting-ip": "192.0.2.86" }, body: { password: "senha-incorreta-longa" } });
    }
    expect(profileRateLimited.status).toBe(429);
    expect(profileRateLimited.headers.get("retry-after")).toMatch(/^\d+$/);

    const adminProfile = (await profilesAdmin.json()).profiles.find((item) => item.slug === profileSlug);
    expect(adminProfile.letter_count).toBe(1);
    expect(adminProfile.visibility).toBe("public");
    expect(adminProfile.created_at).toBeTruthy();
    expect(adminProfile).not.toHaveProperty("avatar_blob");
    expect(adminProfile).not.toHaveProperty("idempotency_key");
    expect(adminProfile).not.toHaveProperty("request_hash");
    const unauthenticatedVisibility = await request(`/admin/profiles/${adminProfile.id}/visibility`, { method: "PATCH", body: { visibility: "private" } });
    expect(unauthenticatedVisibility.status).toBe(401);
    const invalidVisibility = await request(`/admin/profiles/${adminProfile.id}/visibility`, { method: "PATCH", token, body: { visibility: "secret" } });
    expect(invalidVisibility.status).toBe(422);
    const makePrivate = await request(`/admin/profiles/${adminProfile.id}/visibility`, { method: "PATCH", token, body: { visibility: "private" } });
    expect(makePrivate.status).toBe(200);
    expect((await (await request(`/profiles/${profileSlug}`)).json()).profile.visibility).toBe("private");
    expect((await (await request("/recipients")).json()).recipients.some((item) => item.slug === profileSlug)).toBe(false);
    const makePublic = await request(`/admin/profiles/${adminProfile.id}/visibility`, { method: "PATCH", token, body: { visibility: "public" } });
    expect(makePublic.status).toBe(200);
    expect((await (await request("/recipients")).json()).recipients.some((item) => item.slug === profileSlug)).toBe(true);
    const hiddenProfile = await request(`/admin/profiles/${adminProfile.id}`, { method: "PATCH", token, body: { status: "hidden", note: "Revisão manual" } });
    expect(hiddenProfile.status).toBe(200);
    expect((await request(`/profiles/${profileSlug}`)).status).toBe(404);
    expect((await (await request("/recipients")).json()).recipients.some((item) => item.slug === profileSlug)).toBe(false);
    const profileHistory = await request("/admin/profiles?status=all", { token });
    expect((await profileHistory.json()).profiles.find((item) => item.slug === profileSlug)?.status).toBe("hidden");

    const newModerator = await request("/admin/moderators", { method: "POST", token, body: { username: "mod.lia", displayName: "Lia", password: "senha-temporaria-segura" } });
    expect(newModerator.status).toBe(201);

    const hidden = await request(`/admin/letters/${letterId}`, { method: "PATCH", token, body: { status: "hidden", note: "Revisão manual" } });
    expect(hidden.status).toBe(200);
    const listAfterHide = await request("/letters");
    expect((await listAfterHide.json()).letters).toHaveLength(0);

    const audit = await request("/admin/audit", { token });
    expect(audit.status).toBe(200);
    expect((await audit.json()).entries.some((entry) => entry.action === "letter.moderate")).toBe(true);
    expect((await request("/admin/audit", { token }).then((response) => response.json())).entries.some((entry) => entry.action === "profile.moderate")).toBe(true);
    expect((await request("/admin/audit", { token }).then((response) => response.json())).entries.some((entry) => entry.action === "profile.visibility")).toBe(true);
    expect((await request("/admin/audit", { token }).then((response) => response.json())).entries.some((entry) => entry.action === "profile.letter_visibility")).toBe(true);
    const auditEntries = (await (await request("/admin/audit", { token })).json()).entries;
    expect(auditEntries.some((entry) => entry.action === "profile.password_reset")).toBe(true);
    expect(JSON.stringify(auditEntries)).not.toContain("senha-inicial-do-perfil");
  });

  it("rejects disallowed CORS preflights and invalid content", async () => {
    const cors = await exports.default.fetch("https://wall.test/api/letters", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(cors.status).toBe(403);
    const invalid = await request("/letters", { method: "POST", headers: { "idempotency-key": "valid_key_123456789", "cf-connecting-ip": "192.0.2.50" }, body: { recipient: "kisuke", body: "x" } });
    expect(invalid.status).toBe(422);

    const fakeImage = await request("/profiles", {
      method: "POST",
      headers: { "idempotency-key": "invalid_avatar_key_123456", "cf-connecting-ip": "192.0.2.51" },
      body: { displayName: "Imagem falsa", avatar: { mediaType: "image/png", data: btoa("not a png") } }
    });
    expect(fakeImage.status).toBe(422);
    const protectedWithoutPassword = await request("/profiles", {
      method: "POST",
      headers: { "idempotency-key": "missing_profile_password_1234", "cf-connecting-ip": "192.0.2.52" },
      body: { displayName: "Sem senha", letterVisibility: "protected" }
    });
    expect(protectedWithoutPassword.status).toBe(422);
  });

  it("returns generic credentials errors and rate-limits brute force", async () => {
    const missing = await request("/admin/login", { method: "POST", headers: { "cf-connecting-ip": "192.0.2.70" }, body: { username: "nao-existe", password: "senha-errada" } });
    const wrong = await request("/admin/login", { method: "POST", headers: { "cf-connecting-ip": "192.0.2.71" }, body: { username: "admin", password: "senha-errada" } });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual(await wrong.json());

    let response;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      response = await request("/admin/login", { method: "POST", headers: { "cf-connecting-ip": "192.0.2.72" }, body: { username: "admin", password: "senha-errada" } });
    }
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
