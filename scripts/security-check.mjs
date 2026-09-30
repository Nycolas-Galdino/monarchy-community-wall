import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoots = [path.join(root, "public"), path.join(root, "dist")];
const forbiddenNames = new Set([".dev.vars", ".env", ".env.local", ".env.production"]);
const ignoredDirectories = new Set([".git", ".wrangler", "coverage", "dist", "dist-worker", "node_modules"]);
const allowedExamples = new Set([".dev.vars.example", ".env.example"]);
const forbiddenContent = [
  /\bBOOTSTRAP_TOKEN\s*=/,
  /\bIP_HASH_SECRET\s*=/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
];

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function filesUnder(directory, { ignoreDirectories = false } = {}) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoreDirectories && entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target, { ignoreDirectories }));
    else files.push(target);
  }
  return files;
}

async function repositoryFiles() {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8" }
    );
    return stdout.split("\0").filter(Boolean).map((file) => path.join(root, file));
  } catch {
    return (await filesUnder(root, { ignoreDirectories: true }))
      .filter((file) => !forbiddenNames.has(path.basename(file)));
  }
}

const failures = [];
for (const file of await repositoryFiles()) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  if (allowedExamples.has(path.basename(file))) continue;
  if (forbiddenNames.has(path.basename(file))) failures.push(`${relative}: arquivo sensível não pode entrar no repositório`);
  const content = await readFile(file, "utf8");
  for (const pattern of forbiddenContent.slice(2)) {
    if (pattern.test(content)) failures.push(`${relative}: possível credencial encontrada (${pattern})`);
  }
}

for (const directory of publicRoots) {
  if (!(await exists(directory))) continue;
  for (const file of await filesUnder(directory)) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (forbiddenNames.has(path.basename(file))) failures.push(`${relative}: arquivo sensível não pode ser público`);
    const content = await readFile(file, "utf8");
    for (const pattern of forbiddenContent) if (pattern.test(content)) failures.push(`${relative}: padrão de segredo encontrado (${pattern})`);
  }
}

const generatedConfig = path.join(root, "dist", "config.js");
if (await exists(generatedConfig)) {
  const config = await readFile(generatedConfig, "utf8");
  if (!/Object\.freeze\(\{"apiBaseUrl":"[^"]+"\}\)/.test(config)) failures.push("dist/config.js: deve expor somente apiBaseUrl");
}

if (failures.length) throw new Error(`Falha na auditoria de segurança:\n${failures.join("\n")}`);
console.log("Auditoria concluída: nenhum segredo conhecido foi encontrado no código ou no frontend gerado.");
