import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const apiBaseUrl = process.env.API_BASE_URL?.replace(/\/$/, "") || "http://localhost:8787";
const apiOrigin = new URL(apiBaseUrl).origin;

if (process.env.CI && !process.env.API_BASE_URL) throw new Error("Defina a variável de repositório API_BASE_URL antes de publicar no GitHub Pages.");
if (!/^https:\/\//.test(apiBaseUrl) && !/^http:\/\/localhost(?::\d+)?$/.test(apiBaseUrl)) throw new Error("API_BASE_URL deve usar HTTPS (ou localhost no desenvolvimento). ");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "public"), output, { recursive: true });
await writeFile(path.join(output, "config.js"), `window.MONARCHY_WALL_CONFIG = Object.freeze(${JSON.stringify({ apiBaseUrl })});\n`, "utf8");

const indexPath = path.join(output, "index.html");
const index = (await readFile(indexPath, "utf8")).replaceAll("http://localhost:8787", apiOrigin);
if (!index.includes("Mural Anônimo da Comunidade")) throw new Error("O artefato não contém a página esperada.");
if (!index.includes("Psiu… aproxima aqui.") || !index.includes("Central da fofoca") || !index.includes("anonimato não é passe livre")) {
  throw new Error("A linguagem divertida e o limite de segurança da central de fofocas estão ausentes.");
}
if (!index.includes('id="story-print-mode"') || !index.includes("não é possível baixar esta imagem") || !index.includes("navegador externo")) {
  throw new Error("As instruções de print, a limitação do Ducks e a recomendação de navegador externo estão ausentes.");
}
if (!index.includes('id="create-profile-button" type="button"')) throw new Error("O botão de criação deve permanecer type=button para nunca submeter sem JavaScript.");
if (index.includes("data-open-admin")) throw new Error("A navegação pública não pode expor a entrada da moderação.");
if (!index.includes('id="profile-success-dialog"')) throw new Error("O artefato não contém a confirmação de perfil criado.");
if (!index.includes('id="recipient-options"') || index.includes('<select id="recipient"')) {
  throw new Error("O seletor visual de destinatários com suporte a avatares está ausente.");
}
if (!index.includes('name="visibility" value="public" checked') || !index.includes('name="visibility" value="private"')) {
  throw new Error("As opções pública e privada do perfil estão ausentes ou o padrão deixou de ser público.");
}
if (!index.includes('name="letterVisibility" value="public" checked') || !index.includes('name="letterVisibility" value="protected"') || !index.includes('id="profile-unlock-form"')) {
  throw new Error("As opções de leitura e o desbloqueio persistente dos recados estão ausentes.");
}
if (!index.includes('id="profile-password"') || !index.includes('id="profile-password-confirmation"') || !index.includes('id="profile-password-tooltip"')) {
  throw new Error("A senha inicial criada pelo dono e seu aviso de segurança estão ausentes.");
}
if (index.includes("♥") || index.includes("com carinho") || index.includes('class="envelope"')) {
  throw new Error("A temática pública ainda contém elementos de correio romântico.");
}
if (!index.includes("https://app.duckapps.com.br/seu-perfil") || index.includes("https://duckpps.com/c/seu-perfil")) {
  throw new Error("O frontend precisa indicar somente o domínio Ducks permitido.");
}
await writeFile(indexPath, index, "utf8");
const localScripts = [...index.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]).filter((source) => !source.includes(":"));
await Promise.all(localScripts.map((source) => access(path.join(output, source.split(/[?#]/, 1)[0]))));
await access(path.join(output, "moderacao.html"));
console.log(`Frontend gerado em ${output} para API ${apiBaseUrl}`);
