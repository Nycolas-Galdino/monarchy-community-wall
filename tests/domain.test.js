import { describe, expect, it, vi } from "vitest";
import {
  allowedOrigin,
  decodeAndValidateAvatar,
  hashPassword,
  normalizePlainText,
  slugifyProfileName,
  validateDucksUrl,
  validateLetterInput,
  validateModeratorInput,
  validateProfileInput,
  validateProfileVisibilityInput,
  verifyPassword
} from "../worker/domain.js";
import { buildProfileShareUrl, validateDraft, validateProfileDraft, wrapStoryText } from "../public/model.js";
import { WallApi } from "../public/api.js";

describe("validation and security helpers", () => {
  it("normalizes control characters without interpreting HTML", () => {
    expect(normalizePlainText("  oi\u0000 <b>amiga</b>\r\n\r\n\r\n  ")).toBe("oi <b>amiga</b>");
  });

  it("rejects missing recipient and oversized letters on both boundaries", () => {
    expect(validateLetterInput({ recipient: "", body: "olá" }).ok).toBe(false);
    expect(validateLetterInput({ recipient: "kisuke", body: "x".repeat(601) }).ok).toBe(false);
    expect(validateDraft("kisuke", "x".repeat(601))).toMatch(/600/);
    expect(validateLetterInput({ recipient: "kisuke", body: "Tudo de bom!" }).ok).toBe(true);
  });

  it("requires strong-enough moderator credentials", () => {
    expect(validateModeratorInput({ username: "mod", displayName: "Mod", password: "curta" }).ok).toBe(false);
    expect(validateModeratorInput({ username: "mod.ana", displayName: "Ana", password: "uma-senha-com-12" }).ok).toBe(true);
  });

  it("hashes passwords with salt and verifies without storing plaintext", async () => {
    const first = await hashPassword("senha-de-teste-segura");
    const second = await hashPassword("senha-de-teste-segura");
    expect(first.split("$")[1]).toBe("100000");
    expect(first).not.toBe(second);
    expect(first).not.toContain("senha-de-teste-segura");
    await expect(verifyPassword("senha-de-teste-segura", first)).resolves.toBe(true);
    await expect(verifyPassword("senha-errada", first)).resolves.toBe(false);
    await expect(hashPassword("senha-de-teste-segura", 100001)).rejects.toThrow("unsupported_password_iterations");
  });

  it("allows only explicitly configured browser origins", () => {
    expect(allowedOrigin("https://grupo.github.io", "https://grupo.github.io, http://localhost:8080")).toBe("https://grupo.github.io");
    expect(allowedOrigin("https://evil.example", "https://grupo.github.io")).toBeNull();
  });

  it("normalizes profile slugs and accepts only configured Ducks HTTPS hosts", () => {
    expect(slugifyProfileName("  Líla da Monarchy!  ")).toBe("lila-da-monarchy");
    expect(validateDucksUrl("https://app.duckapps.com.br/Monarchy").ok).toBe(true);
    expect(validateDucksUrl("http://app.duckapps.com.br/Monarchy").ok).toBe(false);
    expect(validateDucksUrl("https://app.duckapps.com.br.evil.example/Monarchy").ok).toBe(false);
    expect(validateDucksUrl("https://duckpps.com/c/Monarchy").ok).toBe(false);
  });

  it("validates profile fields and checks avatar bytes instead of trusting MIME", () => {
    const png = { mediaType: "image/png", data: "iVBORw0KGgo=" };
    const defaultVisibility = validateProfileInput({ displayName: "Lila", description: "Meu mural", ducksUrl: "https://app.duckapps.com.br/lila", avatar: png });
    expect(defaultVisibility.ok).toBe(true);
    expect(defaultVisibility.value.visibility).toBe("public");
    expect(validateProfileInput({ displayName: "Lila", description: "Meu mural", visibility: "private" }).value.visibility).toBe("private");
    expect(validateProfileInput({ displayName: "Lila", description: "Meu mural", visibility: "secret" }).ok).toBe(false);
    expect(validateProfileVisibilityInput({ visibility: "private" })).toEqual({ ok: true, value: { visibility: "private" } });
    expect(validateProfileVisibilityInput({ visibility: "secret" }).ok).toBe(false);
    expect([...decodeAndValidateAvatar(png)].slice(0, 8)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() => decodeAndValidateAvatar({ mediaType: "image/jpeg", data: png.data })).toThrow("invalid_avatar");
    expect(validateProfileInput({ displayName: "X", description: "" }).ok).toBe(false);
  });

  it("builds GitHub Pages compatible share links and wraps story copy", () => {
    expect(buildProfileShareUrl({ href: "https://grupo.github.io/Monarchy/?old=1#x" }, "lila-abc")).toBe("https://grupo.github.io/Monarchy/?profile=lila-abc");
    expect(wrapStoryText("uma cartinha curta e bonita", 12)).toEqual(["uma cartinha", "curta e", "bonita"]);
    expect(validateProfileDraft({ displayName: "Lila", description: "", ducksUrl: "https://app.duckapps.com.br/lila" })).toBeNull();
    expect(validateProfileDraft({ displayName: "Lila", description: "", visibility: "private" })).toBeNull();
    expect(validateProfileDraft({ displayName: "Lila", description: "", visibility: "secret" })).toMatch(/público ou privado/);
    expect(validateProfileDraft({ displayName: "Lila", description: "", ducksUrl: "http://app.duckapps.com.br/lila" })).toMatch(/HTTPS/);
    expect(validateProfileDraft({ displayName: "Lila", description: "", ducksUrl: "https://duckpps.com/c/lila" })).toMatch(/app\.duckapps\.com\.br/);
  });

  it("stops waiting and reports a timeout when the API hangs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    try {
      const expectation = expect(new WallApi("https://wall.test").recipients()).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(12_000);
      await expectation;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
