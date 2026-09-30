import { WallApi } from "./api.js";
import {
  LETTER_MAX_LENGTH,
  PROFILE_DESCRIPTION_MAX_LENGTH,
  buildProfileShareUrl,
  createIdempotencyKey,
  formatDate,
  validateDraft,
  validateProfileDraft
} from "./model.js?v=20260930-admin-visibility";
const config = window.MONARCHY_WALL_CONFIG ?? {};
const api = new WallApi(config.apiBaseUrl || window.location.origin);
const profileSlug = new URL(window.location.href).searchParams.get("profile")?.trim() ?? "";
const adminRequested = new URL(window.location.href).searchParams.get("admin") === "1";
let storyToolsPromise;
const state = {
  recipients: [], letters: [], page: 1, hasMore: false, filter: "", moderator: null,
  adminTab: "letters", profile: null, profileSlug, profileKey: createIdempotencyKey(),
  avatarPreviewUrl: null, storyUrl: null
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function loadStoryTools() {
  storyToolsPromise ??= import("./story.js");
  return storyToolsPromise;
}

function setMessage(element, message = "", type = "") {
  element.textContent = message;
  element.className = `form-message${type ? ` ${type}` : ""}`;
}

function setBusy(button, busy, busyText) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

async function copyText(value, button) {
  const previous = button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Link copiado!";
  } catch {
    const input = document.createElement("textarea");
    input.value = value; input.readOnly = true; input.style.position = "fixed"; input.style.opacity = "0";
    document.body.append(input); input.select(); document.execCommand("copy"); input.remove();
    button.textContent = "Link copiado!";
  }
  setTimeout(() => { button.textContent = previous; }, 1600);
}

function selectRecipient(slug = "") {
  $("#recipient").value = slug;
  $$(".recipient-option").forEach((option) => {
    const selected = option.dataset.recipient === slug;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
  });
}

function fillRecipientChoices() {
  const choices = $("#recipient-options");
  const filter = $("#recipient-filter");
  choices.replaceChildren();
  filter.replaceChildren(new Option("Todo mundo", ""));
  for (const recipient of state.recipients) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `recipient-option accent-${recipient.accent}`;
    option.dataset.recipient = recipient.slug;
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", "false");

    const avatar = document.createElement("span");
    avatar.className = "recipient-option-avatar";
    const fallback = document.createElement("span");
    fallback.className = "recipient-option-fallback";
    fallback.textContent = recipient.kind === "community" && recipient.slug === "moderacao" ? "✦" : recipient.name.slice(0, 1).toUpperCase();
    avatar.append(fallback);
    if (recipient.kind === "profile" && recipient.hasAvatar) {
      const image = new Image();
      image.src = api.profileAvatarUrl(recipient.slug);
      image.alt = "";
      image.addEventListener("load", () => { fallback.hidden = true; });
      image.addEventListener("error", () => { image.remove(); fallback.hidden = false; });
      avatar.append(image);
    }

    const copy = document.createElement("span");
    copy.className = "recipient-option-copy";
    const name = document.createElement("strong");
    name.textContent = recipient.name;
    const kind = document.createElement("small");
    kind.textContent = recipient.kind === "profile" ? "Perfil da comunidade" : recipient.slug === "moderacao" ? "Equipe responsável" : "Mural coletivo";
    copy.append(name, kind);
    const mark = document.createElement("span");
    mark.className = "recipient-option-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "✓";
    option.append(avatar, copy, mark);
    option.addEventListener("click", () => { selectRecipient(recipient.slug); setMessage($("#letter-message")); });
    choices.append(option);
    if (recipient.kind === "community") filter.add(new Option(recipient.name, recipient.slug));
  }
  selectRecipient();
}

async function loadRecipients() {
  const data = await api.recipients();
  state.recipients = data.recipients;
  fillRecipientChoices();
}

function configureProfile(profile) {
  state.profile = profile;
  document.title = `Cartinhas para ${profile.displayName} · Monarchy`;
  $("#profile-identity").hidden = false;
  $("#profile-name").textContent = profile.displayName;
  $("#profile-avatar-fallback").textContent = profile.displayName.slice(0, 1).toUpperCase();
  if (profile.hasAvatar) {
    const avatar = $("#profile-avatar");
    avatar.src = api.profileAvatarUrl(profile.slug);
    avatar.alt = `Foto de ${profile.displayName}`;
    avatar.hidden = false;
    $("#profile-avatar-fallback").hidden = true;
  }
  if (profile.description) { $("#profile-description").textContent = profile.description; $("#profile-description").hidden = false; }
  $("#profile-links").hidden = false;
  if (profile.ducksUrl) { $("#profile-ducks-link").href = profile.ducksUrl; $("#profile-ducks-link").hidden = false; }
  $("#hero-title").innerHTML = `Tem algo para ${escapeHtml(profile.displayName)}?<br><em>Deixe virar cartinha.</em>`;
  $(".hero-intro").textContent = `Este é o mural de ${profile.displayName}. Escreva com carinho e publique sem revelar seu nome.`;
  $("#criar-perfil").hidden = true;
  $("#create-profile-nav").hidden = true;
  $("#recipient-field").hidden = true;
  $("#fixed-recipient").hidden = false;
  $("#fixed-recipient-name").textContent = profile.displayName;
  $("#recipient-filter-label").hidden = true;
  $("#wall-title").textContent = `Cartinhas para ${profile.displayName}`;
}

function escapeHtml(value) {
  const span = document.createElement("span"); span.textContent = value; return span.innerHTML;
}

function renderLetters() {
  const grid = $("#letter-grid");
  grid.replaceChildren();
  if (!state.letters.length) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    const icon = document.createElement("span"); icon.textContent = "✉";
    const copy = document.createElement("p");
    copy.textContent = state.profile ? `O mural de ${state.profile.displayName} espera a primeira cartinha.` : state.filter ? "Ainda não há cartinhas para essa pessoa." : "O mural está esperando a primeira cartinha.";
    empty.append(icon, copy); grid.append(empty);
  }
  const template = $("#letter-template");
  for (const letter of state.letters) {
    const fragment = template.content.cloneNode(true);
    const card = $(".letter-card", fragment);
    const accent = ["gold", "violet", "mint", "coral", "cyan"].includes(letter.recipient.accent) ? letter.recipient.accent : "violet";
    card.classList.add(`accent-${accent}`);
    $(".recipient-pill", card).textContent = `Para ${letter.recipient.name}`;
    $(".letter-body", card).textContent = letter.body;
    $("time", card).textContent = formatDate(letter.createdAt);
    $("time", card).dateTime = letter.createdAt;
    const reaction = $(".reaction-button", card);
    $("b", reaction).textContent = letter.reactions;
    reaction.addEventListener("click", () => react(letter.id, reaction));
    $(".report-button", card).addEventListener("click", () => openReport(letter.id));
    $(".story-button", card).addEventListener("click", () => openStory(letter));
    grid.append(fragment);
  }
  $("#load-more").hidden = !state.hasMore;
}

async function loadPublic({ append = false } = {}) {
  const status = $("#wall-status");
  if (!append) status.textContent = "Abrindo as cartas…";
  try {
    const data = state.profileSlug ? await api.profileLetters(state.profileSlug, state.page) : await api.letters({ page: state.page, recipient: state.filter });
    if (data.profile && !state.profile) configureProfile(data.profile);
    state.letters = append ? [...state.letters, ...data.letters] : data.letters;
    state.hasMore = data.hasMore;
    renderLetters();
    status.textContent = "";
  } catch (error) {
    if (!append) { state.letters = []; renderLetters(); }
    status.textContent = state.profileSlug && error.status === 404 ? "Este mural não existe ou não está disponível." : `Não conseguimos abrir o mural: ${error.message}`;
  }
}

async function react(letterId, button) {
  const count = $("b", button); button.disabled = true;
  try {
    const data = await api.react(letterId); count.textContent = data.reactions; button.classList.add("reacted");
    button.setAttribute("aria-label", data.reacted ? "Carinho enviado" : "Você já enviou carinho");
  } catch (error) { button.title = error.message; }
  finally { button.disabled = false; }
}

function openReport(letterId) {
  $("#report-letter-id").value = letterId; setMessage($("#report-message")); $("#report-dialog").showModal();
}

async function openStory(letter) {
  const dialog = $("#story-dialog");
  const wrap = $("#story-preview-wrap");
  const download = $("#download-story");
  wrap.replaceChildren(); wrap.textContent = "Gerando a arte…"; download.hidden = true; setMessage($("#story-message"));
  dialog.showModal();
  const profile = state.profile ?? { displayName: letter.recipient.name };
  try {
    const { createStoryDataUrl, safeStoryFileName } = await loadStoryTools();
    const url = await createStoryDataUrl({ letter, profile, avatarUrl: state.profile?.hasAvatar ? api.profileAvatarUrl(state.profile.slug) : null });
    state.storyUrl = url;
    const preview = new Image(); preview.src = url; preview.alt = `Prévia da cartinha para ${profile.displayName}`;
    wrap.replaceChildren(preview); download.href = url; download.download = safeStoryFileName(profile.displayName); download.hidden = false;
  } catch (error) { wrap.replaceChildren(); setMessage($("#story-message"), `Não foi possível gerar o PNG: ${error.message}`, "error"); }
}

async function submitLetter(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const recipient = state.profile ? state.profile.slug : form.recipient.value;
  const body = form.body.value;
  const error = validateDraft(recipient, body);
  if (error) return setMessage($("#letter-message"), error, "error");
  const button = $("button[type=submit]", form); setBusy(button, true, "Publicando…"); setMessage($("#letter-message"), "Selando o envelope…");
  try {
    const selectedRecipient = state.recipients.find((item) => item.slug === recipient);
    if (state.profile) await api.createProfileLetter(state.profile.slug, body, createIdempotencyKey());
    else await api.createLetter({ recipient, body }, createIdempotencyKey());
    form.reset(); $("#letter-counter").textContent = `0 / ${LETTER_MAX_LENGTH}`;
    selectRecipient();
    if (!state.profile && selectedRecipient?.kind === "profile") {
      setMessage($("#letter-message"), `Cartinha enviada para ${selectedRecipient.name}. Ela já está no mural pessoal!`, "success");
    } else {
      setMessage($("#letter-message"), "Cartinha publicada. Ela já está no mural!", "success");
      state.page = 1; await loadPublic(); $("#mural").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (requestError) { setMessage($("#letter-message"), requestError.message, "error"); }
  finally { setBusy(button, false); }
}

async function submitProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = {
    displayName: form.displayName.value,
    description: form.description.value,
    ducksUrl: form.ducksUrl.value,
    visibility: form.visibility.value,
    avatarFile: form.avatar.files[0] ?? null
  };
  const validationError = validateProfileDraft(values);
  if (validationError) return setMessage($("#profile-message"), validationError, "error");
  const button = $("#create-profile-button"); setBusy(button, true, "Criando…"); setMessage($("#profile-message"), values.avatarFile ? "Otimizando a foto com segurança…" : "Preparando seu mural…");
  try {
    const avatar = values.avatarFile ? await (await loadStoryTools()).prepareAvatar(values.avatarFile) : null;
    const data = await api.createProfile({ displayName: values.displayName, description: values.description, ducksUrl: values.ducksUrl, visibility: values.visibility, avatar }, state.profileKey);
    const link = buildProfileShareUrl(window.location, data.slug);
    $("#generated-profile-link").value = link; $("#open-generated-link").href = link;
    $("#profile-success-visibility").textContent = values.visibility === "private"
      ? "Este mural é privado e não será listado na página inicial. Compartilhe o link com quem poderá escrever."
      : "Este mural é público e aparecerá na lista inicial de destinatários.";
    state.profileKey = createIdempotencyKey();
    form.reset(); $("#profile-description-counter").textContent = `0 / ${PROFILE_DESCRIPTION_MAX_LENGTH}`; updateProfilePreview(); updateAvatarPreview(null);
    await loadRecipients();
    setMessage($("#profile-message"));
    $("#profile-success-dialog").showModal();
  } catch (error) { setMessage($("#profile-message"), error.message, "error"); }
  finally { setBusy(button, false); }
}

async function submitReport(event) {
  event.preventDefault(); const button = $("#report-submit"); setBusy(button, true, "Enviando…");
  try {
    const data = await api.report($("#report-letter-id").value, $("#report-reason").value);
    setMessage($("#report-message"), data.duplicate ? "Você já denunciou esta cartinha." : "Denúncia enviada para a moderação.", "success");
    setTimeout(() => $("#report-dialog").close(), 900);
  } catch (error) { setMessage($("#report-message"), error.message, "error"); }
  finally { setBusy(button, false); }
}

function openAdmin() { $("#admin-dialog").showModal(); }

async function submitLogin(event) {
  event.preventDefault(); const form = event.currentTarget; const button = $("button[type=submit]", form); setBusy(button, true, "Entrando…");
  try {
    const data = await api.login($("#admin-username").value, $("#admin-password").value);
    api.setToken(data.token); state.moderator = data.moderator; form.reset(); setMessage($("#login-message"));
    $("#admin-login-view").hidden = true; $("#admin-dashboard").hidden = false; $("#admin-welcome").textContent = `Olá, ${data.moderator.displayName}.`;
    await renderAdminTab();
  } catch (error) { setMessage($("#login-message"), error.message, "error"); }
  finally { setBusy(button, false); }
}

async function logout() {
  try { await api.logout(); } catch { /* A sessão local encerra mesmo se já expirou. */ }
  api.setToken(null); state.moderator = null; $("#admin-login-view").hidden = false; $("#admin-dashboard").hidden = true;
  setMessage($("#login-message"), "Sessão encerrada.", "success");
}

function adminError(error) {
  if (error.status === 401) { logout(); return; }
  const panel = $("#admin-panel"); panel.replaceChildren();
  const message = document.createElement("p"); message.className = "form-message error"; message.textContent = error.message; panel.append(message);
}

function createAdminLetterCard(letter) {
  const card = document.createElement("article"); card.className = "admin-card";
  const header = document.createElement("header");
  const meta = document.createElement("span"); meta.textContent = `${letter.recipient_name}${letter.profile_slug ? ` · perfil ${letter.profile_slug}` : ""} · ${formatDate(letter.created_at)}`;
  const badge = document.createElement("span"); badge.className = `status-badge status-${letter.status}`; badge.textContent = letter.status; header.append(meta, badge);
  const quote = document.createElement("blockquote"); quote.textContent = letter.body;
  const stats = document.createElement("p"); stats.className = "form-message"; stats.textContent = `${letter.report_count} denúncia(ões) · ${letter.reaction_count} carinho(s)${letter.moderation_note ? ` · Nota: ${letter.moderation_note}` : ""}`;
  const actions = document.createElement("div"); actions.className = "admin-actions";
  for (const [status, label] of [["published", "Publicar"], ["hidden", "Ocultar"], ["deleted", "Excluir"]]) {
    if (status === letter.status) continue;
    const button = document.createElement("button"); button.type = "button"; button.className = status === "deleted" ? "danger-button" : "secondary-button"; button.textContent = label;
    button.addEventListener("click", async () => {
      setBusy(button, true, "Salvando…");
      try { await api.moderate(letter.id, status, status === "published" ? "Revisada pela moderação" : "Ação da moderação"); await renderAdminLetters(); state.page = 1; await loadPublic(); }
      catch (error) { adminError(error); }
    }); actions.append(button);
  }
  card.append(header, quote, stats, actions); return card;
}

async function renderAdminLetters() {
  const panel = $("#admin-panel"); panel.replaceChildren();
  const toolbar = document.createElement("div"); toolbar.className = "admin-toolbar";
  const title = document.createElement("strong"); title.textContent = "Conteúdo do mural";
  const filter = document.createElement("select"); filter.setAttribute("aria-label", "Filtrar por status");
  for (const [value, label] of [["all", "Todos"], ["published", "Publicados"], ["hidden", "Ocultos"], ["deleted", "Excluídos"]]) filter.add(new Option(label, value));
  toolbar.append(title, filter); panel.append(toolbar); const list = document.createElement("div"); list.className = "admin-list"; panel.append(list);
  async function refresh() {
    list.textContent = "Carregando…";
    try { const data = await api.adminLetters(filter.value); list.replaceChildren(); if (!data.letters.length) list.textContent = "Nenhuma cartinha neste estado."; else data.letters.forEach((letter) => list.append(createAdminLetterCard(letter))); }
    catch (error) { adminError(error); }
  }
  filter.addEventListener("change", refresh); await refresh();
}

async function renderAdminProfiles() {
  const panel = $("#admin-panel"); panel.replaceChildren();
  const toolbar = document.createElement("div"); toolbar.className = "admin-toolbar";
  const title = document.createElement("strong"); title.textContent = "Histórico de links de perfis";
  const filter = document.createElement("select"); filter.setAttribute("aria-label", "Filtrar perfis por status");
  for (const [value, label] of [["all", "Todos"], ["active", "Ativos"], ["hidden", "Ocultos"], ["deleted", "Excluídos"]]) filter.add(new Option(label, value));
  toolbar.append(title, filter); panel.append(toolbar); const list = document.createElement("div"); list.className = "admin-list"; panel.append(list);
  async function refresh() {
    list.textContent = "Carregando…";
    try {
      const data = await api.adminProfiles(filter.value); list.replaceChildren();
      if (!data.profiles.length) { list.textContent = "Nenhum perfil neste estado."; return; }
      for (const profile of data.profiles) {
        const card = document.createElement("article"); card.className = "admin-card";
        const header = document.createElement("header"); const name = document.createElement("strong"); name.textContent = profile.display_name;
        const badge = document.createElement("span"); badge.className = `status-badge status-${profile.status}`; badge.textContent = profile.status; header.append(name, badge);
        const copy = document.createElement("p"); copy.textContent = profile.description || "Sem descrição.";
        const stats = document.createElement("p"); stats.className = "form-message"; stats.textContent = `${profile.letter_count} cartinha(s) · ${profile.visibility === "private" ? "privado pelo link" : "público"} · criado em ${formatDate(profile.created_at)}${profile.ducks_url ? " · Ducks informado" : ""}`;
        const visibilityControl = document.createElement("div"); visibilityControl.className = "admin-visibility-control";
        const visibilityLabel = document.createElement("strong"); visibilityLabel.textContent = "Visibilidade";
        const visibilityButtons = document.createElement("div"); visibilityButtons.className = "admin-visibility-buttons";
        for (const [visibility, label] of [["public", "Público"], ["private", "Privado"]]) {
          const visibilityButton = document.createElement("button");
          visibilityButton.type = "button";
          visibilityButton.className = "secondary-button";
          visibilityButton.textContent = label;
          visibilityButton.setAttribute("aria-pressed", String(profile.visibility === visibility));
          visibilityButton.disabled = profile.visibility === visibility;
          visibilityButton.addEventListener("click", async () => {
            setBusy(visibilityButton, true, "Salvando…");
            try {
              await api.setProfileVisibility(profile.id, visibility);
              await loadRecipients();
              await refresh();
            } catch (error) { adminError(error); }
            finally { setBusy(visibilityButton, false); }
          });
          visibilityButtons.append(visibilityButton);
        }
        visibilityControl.append(visibilityLabel, visibilityButtons);
        const profileLink = buildProfileShareUrl(window.location, profile.slug);
        const linkRow = document.createElement("div"); linkRow.className = "admin-profile-link";
        const linkInput = document.createElement("input"); linkInput.readOnly = true; linkInput.value = profileLink; linkInput.setAttribute("aria-label", `Link do mural de ${profile.display_name}`);
        const copyLink = document.createElement("button"); copyLink.type = "button"; copyLink.className = "secondary-button"; copyLink.textContent = "Copiar link"; copyLink.addEventListener("click", () => copyText(profileLink, copyLink));
        const openLink = document.createElement("a"); openLink.className = "secondary-button"; openLink.href = profileLink; openLink.textContent = "Abrir mural";
        linkRow.append(linkInput, copyLink, openLink);
        const actions = document.createElement("div"); actions.className = "admin-actions";
        for (const [status, label] of [["active", "Ativar"], ["hidden", "Ocultar"], ["deleted", "Excluir"]]) {
          if (status === profile.status) continue;
          const button = document.createElement("button"); button.type = "button"; button.className = status === "deleted" ? "danger-button" : "secondary-button"; button.textContent = label;
          button.addEventListener("click", async () => { setBusy(button, true, "Salvando…"); try { await api.moderateProfile(profile.id, status, "Ação da moderação"); await refresh(); } catch (error) { adminError(error); } });
          actions.append(button);
        }
        card.append(header, copy, stats, visibilityControl, linkRow, actions); list.append(card);
      }
    } catch (error) { adminError(error); }
  }
  filter.addEventListener("change", refresh); await refresh();
}

async function renderModerators() {
  const panel = $("#admin-panel"); panel.replaceChildren();
  const form = document.createElement("form"); form.className = "moderator-form";
  form.innerHTML = `<label>Usuário<input name="username" required minlength="3" maxlength="40" autocomplete="off"></label><label>Nome exibido<input name="displayName" required maxlength="60"></label><label>Senha temporária<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label><button class="primary-button" type="submit">Adicionar</button>`;
  const message = document.createElement("p"); message.className = "form-message"; message.setAttribute("role", "status"); panel.append(form, message);
  const list = document.createElement("div"); list.className = "admin-list"; panel.append(list);
  async function refresh() {
    const data = await api.moderators(); list.replaceChildren();
    data.moderators.forEach((moderator) => {
      const row = document.createElement("article"); row.className = "admin-card admin-toolbar";
      const copy = document.createElement("div"); const name = document.createElement("strong"); name.textContent = moderator.display_name; const user = document.createElement("p"); user.className = "form-message"; user.textContent = `@${moderator.username} · ${moderator.active ? "ativo" : "inativo"}`; copy.append(name, user);
      const button = document.createElement("button"); button.type = "button"; button.className = moderator.active ? "danger-button" : "secondary-button"; button.textContent = moderator.active ? "Desativar" : "Reativar"; button.disabled = moderator.id === state.moderator.id;
      button.addEventListener("click", async () => { try { await api.setModeratorActive(moderator.id, !moderator.active); await refresh(); } catch (error) { setMessage(message, error.message, "error"); } });
      row.append(copy, button); list.append(row);
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const data = new FormData(form); const button = $("button", form); setBusy(button, true, "Criando…");
    try { await api.createModerator(Object.fromEntries(data)); form.reset(); setMessage(message, "Moderador adicionado.", "success"); await refresh(); }
    catch (error) { setMessage(message, error.message, "error"); } finally { setBusy(button, false); }
  });
  try { await refresh(); } catch (error) { adminError(error); }
}

async function renderAudit() {
  const panel = $("#admin-panel"); panel.textContent = "Carregando histórico…";
  try {
    const data = await api.audit(); panel.replaceChildren(); if (!data.entries.length) { panel.textContent = "Nenhuma ação registrada."; return; }
    data.entries.forEach((entry) => {
      const row = document.createElement("div"); row.className = "audit-entry";
      const time = document.createElement("time"); time.dateTime = entry.created_at; time.textContent = formatDate(entry.created_at);
      const copy = document.createElement("span"); copy.textContent = `${entry.moderator_name ?? "Sistema"}: ${entry.action} em ${entry.target_type} ${entry.target_id}`;
      row.append(time, copy); panel.append(row);
    });
  } catch (error) { adminError(error); }
}

async function renderAdminTab() {
  if (state.adminTab === "letters") return renderAdminLetters();
  if (state.adminTab === "profiles") return renderAdminProfiles();
  if (state.adminTab === "moderators") return renderModerators();
  return renderAudit();
}

function updateProfilePreview() {
  $("#profile-preview-name").textContent = $("#profile-display-name").value.trim() || "Seu nome";
  $("#profile-preview-description").textContent = $("#profile-description-input").value.trim() || "Seu mural vai ficar assim.";
  $("#profile-preview-visibility").textContent = $("input[name=visibility]:checked").value === "private" ? "Privado · somente pelo link" : "Público";
}

function updateAvatarPreview(file) {
  if (state.avatarPreviewUrl) URL.revokeObjectURL(state.avatarPreviewUrl);
  const preview = $("#avatar-preview"); preview.replaceChildren();
  if (!file) { const mark = document.createElement("span"); mark.textContent = "✦"; preview.append(mark); state.avatarPreviewUrl = null; return; }
  state.avatarPreviewUrl = URL.createObjectURL(file); const image = new Image(); image.src = state.avatarPreviewUrl; image.alt = "Prévia da foto escolhida"; preview.append(image);
}

function bindEvents() {
  $("#letter-body").addEventListener("input", (event) => { $("#letter-counter").textContent = `${Array.from(event.target.value).length} / ${LETTER_MAX_LENGTH}`; });
  $("#letter-form").addEventListener("submit", submitLetter);
  $("#recipient-filter").addEventListener("change", (event) => { state.filter = event.target.value; state.page = 1; loadPublic(); });
  $("#load-more").addEventListener("click", () => { state.page += 1; loadPublic({ append: true }); });
  $("#report-form").addEventListener("submit", submitReport);
  $("#profile-form").addEventListener("submit", submitProfile);
  $("#create-profile-button").addEventListener("click", () => $("#profile-form").requestSubmit());
  $("#profile-display-name").addEventListener("input", updateProfilePreview);
  $("#profile-description-input").addEventListener("input", (event) => { $("#profile-description-counter").textContent = `${Array.from(event.target.value).length} / ${PROFILE_DESCRIPTION_MAX_LENGTH}`; updateProfilePreview(); });
  $$("input[name=visibility]").forEach((input) => input.addEventListener("change", updateProfilePreview));
  $("#profile-avatar-input").addEventListener("change", (event) => updateAvatarPreview(event.target.files[0] ?? null));
  $("#copy-generated-link").addEventListener("click", (event) => copyText($("#generated-profile-link").value, event.currentTarget));
  $("[data-close-profile-success]").addEventListener("click", () => $("#profile-success-dialog").close());
  $("#copy-profile-link").addEventListener("click", (event) => copyText(window.location.href, event.currentTarget));
  $("[data-close-story]").addEventListener("click", () => $("#story-dialog").close());
  $$('[data-open-admin]').forEach((button) => button.addEventListener("click", openAdmin));
  $("[data-close-admin]").addEventListener("click", () => $("#admin-dialog").close());
  $("#login-form").addEventListener("submit", submitLogin); $("#logout-button").addEventListener("click", logout);
  $$('[data-admin-tab]').forEach((button) => button.addEventListener("click", async () => {
    state.adminTab = button.dataset.adminTab;
    $$('[data-admin-tab]').forEach((tab) => tab.setAttribute("aria-selected", String(tab === button)));
    await renderAdminTab();
  }));
}

async function init() {
  bindEvents();
  window.MONARCHY_WALL_BOOTSTRAP?.markReady?.();
  if (adminRequested) openAdmin();
  if (state.profileSlug) {
    try { const data = await api.profile(state.profileSlug); configureProfile(data.profile); }
    catch (error) { $("#hero-title").textContent = "Mural indisponível"; $(".hero-intro").textContent = error.message; $("#letter-form").hidden = true; }
  } else {
    try { await loadRecipients(); }
    catch (error) { $("#recipient-options").textContent = "Não foi possível carregar os destinatários."; setMessage($("#letter-message"), error.message, "error"); }
  }
  await loadPublic();
}

init();
