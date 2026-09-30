export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class WallApi {
  #baseUrl;
  #token = null;

  constructor(baseUrl) {
    this.#baseUrl = String(baseUrl ?? "").replace(/\/$/, "");
  }

  setToken(token) {
    this.#token = token || null;
  }

  assetUrl(path) { return `${this.#baseUrl}/api${path}`; }

  async request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (this.#token) headers.set("authorization", `Bearer ${this.#token}`);
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      response = await fetch(`${this.#baseUrl}/api${path}`, { ...options, headers, signal: options.signal ?? controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError("O servidor demorou demais para responder. Tente novamente em instantes.", 0, "timeout");
      throw new ApiError("Não foi possível falar com o servidor. Verifique sua conexão.", 0, "network_error");
    } finally {
      clearTimeout(timeout);
    }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(data?.error?.message ?? "A operação não pôde ser concluída.", response.status, data?.error?.code);
    return data;
  }

  recipients() { return this.request("/recipients", { cache: "no-store" }); }
  letters({ page = 1, recipient = "" } = {}) {
    const query = new URLSearchParams({ page: String(page), limit: "24" });
    if (recipient) query.set("recipient", recipient);
    return this.request(`/letters?${query}`, { cache: "no-store" });
  }
  createLetter(payload, idempotencyKey) {
    return this.request("/letters", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(payload) });
  }
  profile(slug) { return this.request(`/profiles/${encodeURIComponent(slug)}`, { cache: "no-store" }); }
  profileLetters(slug, page = 1) { return this.request(`/profiles/${encodeURIComponent(slug)}/letters?page=${page}&limit=24`, { cache: "no-store" }); }
  createProfile(payload, idempotencyKey) { return this.request("/profiles", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(payload) }); }
  createProfileLetter(slug, body, idempotencyKey) { return this.request(`/profiles/${encodeURIComponent(slug)}/letters`, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify({ body }) }); }
  profileAvatarUrl(slug) { return this.assetUrl(`/profiles/${encodeURIComponent(slug)}/avatar`); }
  react(letterId) { return this.request(`/letters/${letterId}/reactions`, { method: "POST" }); }
  report(letterId, reason) { return this.request(`/letters/${letterId}/reports`, { method: "POST", body: JSON.stringify({ reason }) }); }
  login(username, password) { return this.request("/admin/login", { method: "POST", body: JSON.stringify({ username, password }) }); }
  logout() { return this.request("/admin/logout", { method: "POST" }); }
  adminLetters(status = "all") { return this.request(`/admin/letters?status=${encodeURIComponent(status)}`); }
  moderate(letterId, status, note) { return this.request(`/admin/letters/${letterId}`, { method: "PATCH", body: JSON.stringify({ status, note }) }); }
  adminProfiles(status = "all") { return this.request(`/admin/profiles?status=${encodeURIComponent(status)}`); }
  moderateProfile(profileId, status, note) { return this.request(`/admin/profiles/${profileId}`, { method: "PATCH", body: JSON.stringify({ status, note }) }); }
  setProfileVisibility(profileId, visibility) { return this.request(`/admin/profiles/${profileId}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility }) }); }
  moderators() { return this.request("/admin/moderators"); }
  createModerator(payload) { return this.request("/admin/moderators", { method: "POST", body: JSON.stringify(payload) }); }
  setModeratorActive(id, active) { return this.request(`/admin/moderators/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }); }
  audit() { return this.request("/admin/audit"); }
}
