import { wrapStoryText } from "./model.js?v=20261001-anonymous-wall";

const MAX_AVATAR_BYTES = 350 * 1024;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler a foto."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(file) {
  if (globalThis.createImageBitmap) return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("A foto não pôde ser aberta.")); };
    image.src = url;
  });
}

export async function prepareAvatar(file) {
  if (!file) return null;
  const source = await decodeImage(file);
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const scale = Math.min(1, 512 / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  canvas.getContext("2d", { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();

  let quality = .86;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  while (blob && blob.size > MAX_AVATAR_BYTES && quality > .46) {
    quality -= .1;
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  }
  if (!blob || blob.size > MAX_AVATAR_BYTES) throw new Error("Não foi possível reduzir a foto para 350 KB. Escolha outra imagem.");
  return { mediaType: "image/webp", data: await blobToBase64(blob) };
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.closePath();
}

function loadRemoteImage(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function drawWrappedText(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || context.measureText(candidate).width <= maxWidth) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines) visible[maxLines - 1] = `${visible[maxLines - 1].replace(/[.…]*$/, "")}…`;
  visible.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  return visible.length;
}

export async function createStoryDataUrl({ letter, profile, avatarUrl }) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 1080, 1920);
  gradient.addColorStop(0, "#160c3d");
  gradient.addColorStop(.46, "#5a218f");
  gradient.addColorStop(1, "#17627f");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1080, 1920);

  const glow = context.createRadialGradient(820, 260, 20, 820, 260, 560);
  glow.addColorStop(0, "rgba(37, 205, 244, .55)");
  glow.addColorStop(1, "rgba(37, 205, 244, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 1080, 1000);

  context.fillStyle = "rgba(255,255,255,.18)";
  for (let row = 0; row < 7; row += 1) for (let column = 0; column < 8; column += 1) {
    context.beginPath(); context.arc(72 + column * 34, 90 + row * 34, 4, 0, Math.PI * 2); context.fill();
  }

  context.textAlign = "center";
  context.fillStyle = "#ffffff";
  context.font = "700 34px system-ui, sans-serif";
  context.fillText("MONARCHY COMMUNITY", 540, 104);
  context.fillStyle = "#28c5f4";
  context.font = "800 26px system-ui, sans-serif";
  context.fillText("O BABADO ANÔNIMO CHEGOU ✦", 540, 170);

  const avatar = await loadRemoteImage(avatarUrl);
  context.save();
  context.beginPath(); context.arc(540, 330, 112, 0, Math.PI * 2); context.clip();
  if (avatar) context.drawImage(avatar, 428, 218, 224, 224);
  else {
    context.fillStyle = "#7b32c7"; context.fillRect(428, 218, 224, 224);
    context.fillStyle = "white"; context.font = "800 92px system-ui, sans-serif"; context.fillText(profile.displayName.slice(0, 1).toUpperCase(), 540, 365);
  }
  context.restore();
  context.strokeStyle = "#ffffff"; context.lineWidth = 12; context.beginPath(); context.arc(540, 330, 118, 0, Math.PI * 2); context.stroke();
  context.fillStyle = "white"; context.font = "800 58px system-ui, sans-serif"; context.fillText(`Para ${profile.displayName}`, 540, 510);

  roundedRect(context, 90, 610, 900, 910, 58);
  context.fillStyle = "rgba(255,255,255,.94)"; context.fill();
  context.strokeStyle = "rgba(255,255,255,.7)"; context.lineWidth = 6; context.stroke();
  context.fillStyle = "#762bc0"; context.font = "800 64px system-ui, sans-serif"; context.fillText("?", 540, 735);

  const roughLines = wrapStoryText(letter.body, 27).length;
  const fontSize = roughLines > 11 ? 48 : roughLines > 8 ? 56 : 66;
  context.fillStyle = "#17101f";
  context.font = `700 ${fontSize}px Georgia, serif`;
  context.textBaseline = "top";
  drawWrappedText(context, letter.body, 540, 825, 740, fontSize * 1.35, 12);

  context.textBaseline = "alphabetic";
  context.fillStyle = "rgba(255,255,255,.9)"; context.font = "600 28px system-ui, sans-serif";
  context.fillText("Comente, responda e espalhe nos stories", 540, 1695);
  context.fillStyle = "#25cdf4"; context.font = "800 36px system-ui, sans-serif";
  context.fillText("MONARCHY ✦", 540, 1780);
  return canvas.toDataURL("image/png");
}

export function safeStoryFileName(displayName) {
  const safe = String(displayName).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return `recado-${safe || "monarchy"}.png`;
}
