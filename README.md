# Correio da Comunidade

Mural público de cartinhas anônimas, separado do narrador de RPG. O frontend é estático e pode ser publicado no GitHub Pages; a API roda em um Cloudflare Worker e grava perfis, fotos, cartinhas, moderação, denúncias, reações, sessões e auditoria em **Cloudflare D1 (SQLite)**.

## Arquitetura

```text
GitHub Pages (HTML/CSS/JS)
          │ HTTPS + CORS restrito
          ▼
Cloudflare Worker (API e autorização)
          │ binding DB
          ▼
Cloudflare D1 / SQLite
```

O Pages nunca recebe senha, hash de senha, segredo do Worker ou acesso direto ao banco. O token opaco recebido no login administrativo fica somente na memória da aba; o servidor guarda apenas o SHA-256 desse token e o invalida no logout, na expiração ou quando a conta é desativada.

## O que está incluído

- mural responsivo com filtros, paginação e estados vazio/carregando/erro/sucesso;
- seletor visual de destinatários com Staff, Toda a comunidade e perfis ativos, incluindo a foto pública do perfil quando disponível;
- perfis pessoais com link único no formato `?profile=nome-identificador`, compatível com GitHub Pages;
- perfil público por padrão ou privado não listado; perfis privados continuam acessíveis e recebem cartinhas somente pelo link direto;
- nome obrigatório e descrição, link Ducks e foto opcionais; o servidor aceita somente URLs HTTPS no domínio `app.duckapps.com.br`;
- foto redimensionada no navegador, limitada a 350 KB no backend e validada também pela assinatura real do arquivo;
- mural pessoal isolado: suas cartinhas não aparecem no mural comunitário e perfis ocultos deixam de responder publicamente;
- geração local de PNG vertical 1080 × 1920 para stories, sem enviar a arte pronta a terceiros;
- publicação sem nome do remetente, limitada a 600 caracteres e idempotente;
- reação anônima persistida (um “carinho” por origem e cartinha);
- denúncia por motivo, deduplicada, com ocultação automática configurável;
- painel para listar, publicar, ocultar ou excluir logicamente cartinhas;
- área de moderação fora da navegação pública, acessível por `moderacao.html` e ainda protegida por login;
- histórico administrativo de perfis com data, status, quantidade de cartinhas e ações para copiar ou abrir cada link;
- alteração auditada entre perfil público e privado diretamente no histórico administrativo, com controles responsivos para celular;
- várias contas de moderação, criação, desativação e encerramento das sessões desativadas;
- senhas PBKDF2-SHA256 com salt aleatório e 210 mil iterações;
- sessões de até 8 horas, CORS por lista explícita, limites por origem e trilha de auditoria;
- proteção de login contra enumeração por resposta genérica, verificação de senha equivalente e limite de 10 tentativas por 15 minutos;
- limites de 3 perfis por hora e 5 cartinhas por mural a cada 10 minutos por origem pseudonimizada;
- dados do usuário sempre renderizados com `textContent`, sem interpretar HTML;
- migrações SQL versionadas e testes de integração no runtime local do Cloudflare.

“Excluir” é uma exclusão lógica: o texto continua no banco com status `deleted` para auditoria. Isso evita perda acidental. Se a política da comunidade exigir apagamento físico ou prazo de retenção, crie uma migração e uma rotina explícita antes de publicar.

## Desenvolvimento local

Requer Node.js 20 ou mais recente (validado com Node 24) e Python somente para servir os arquivos estáticos.

```powershell
cd monarchy-community-wall
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

O D1 local persiste em `.wrangler/state`, que contém um SQLite local e está ignorado pelo Git. Em outro terminal:

```powershell
cd monarchy-community-wall
python -m http.server 8080 -d public
```

Abra `http://localhost:8080`. Para criar o primeiro moderador uma única vez:

```powershell
$bootstrapToken = Read-Host "BOOTSTRAP_TOKEN de .dev.vars"
$credential = [PSCredential]::new("admin", (Read-Host "Senha inicial (mínimo 12 caracteres)" -AsSecureString))
$body = @{
  username = "admin"
  displayName = "Admin principal"
  password = $credential.GetNetworkCredential().Password
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:8787/api/admin/bootstrap" `
  -Headers @{ "X-Bootstrap-Token" = $bootstrapToken } `
  -ContentType "application/json" -Body $body
```

Depois disso, novos moderadores são criados no próprio painel.

O acesso local da equipe é `http://localhost:8080/moderacao.html`. Em produção, acrescente `/moderacao.html` ao endereço publicado pelo GitHub Pages. O endereço não substitui autenticação: ele apenas deixa a entrada administrativa fora da navegação pública.

## Validação

```powershell
npm run check
npm test
npm run build
```

`npm test` usa Vitest com o plugin oficial de Workers, Miniflare e um D1 isolado, aplicando as migrações reais antes dos testes. O build copia o frontend para `dist/`, verifica os scripts e contratos críticos da interface e gera apenas a configuração pública da URL da API. A interface encerra chamadas travadas após 12 segundos e exibe uma mensagem de recuperação; um watchdog separado também evita carregamento infinito quando o módulo principal não inicia. `npm run security:check` inspeciona o código-fonte, `public/` e `dist/`, rejeita arquivos de ambiente, chaves privadas, tokens conhecidos e qualquer `config.js` que exponha algo além de `apiBaseUrl`.

## Publicar o backend (Worker + D1)

Os comandos abaixo apenas descrevem a publicação; nada foi implantado por esta implementação.

1. Autentique o Wrangler e crie o banco:

```powershell
npx wrangler login
npx wrangler d1 create monarchy-letters
```

2. Substitua `database_id` em `wrangler.toml` pelo UUID retornado.

3. Troque `ALLOWED_ORIGINS` pela origem exata do Pages, sem caminho. Exemplo: `https://seu-usuario.github.io`. Se houver domínio próprio, liste ambos separados por vírgula durante a transição.

4. Cadastre dois segredos independentes, aleatórios e com pelo menos 32 caracteres:

```powershell
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put IP_HASH_SECRET
```

5. Aplique as migrações e publique a API:

```powershell
npm run db:remote
npm run deploy:api
```

6. Use o endpoint `/api/admin/bootstrap`, como no exemplo local, apontando para a URL HTTPS do Worker. Depois de criar o primeiro moderador, remova o segredo de bootstrap para reduzir superfície de ataque:

```powershell
npx wrangler secret delete BOOTSTRAP_TOKEN
```

O bootstrap também é bloqueado pelo banco assim que existe qualquer moderador; a remoção do segredo adiciona defesa em profundidade.

## Publicar o frontend no GitHub Pages

1. No repositório GitHub, crie uma **Repository variable** chamada `API_BASE_URL` com a URL HTTPS do Worker, sem `/api` e sem barra final.
2. Em **Settings → Pages → Build and deployment**, selecione **GitHub Actions**.
3. O workflow `.github/workflows/pages.yml` valida dependências, testes, build e segredos a cada push. A publicação automática do Pages deve ser habilitada somente depois que o Worker estiver implantado e `API_BASE_URL` estiver configurada.
4. Confirme que `ALLOWED_ORIGINS` no Worker contém a origem final mostrada pelo GitHub Pages. Se mudar, atualize `wrangler.toml` e republique somente o Worker.

A URL da API não é segredo e aparece no `config.js` publicado. Credenciais e segredos não devem ser configurados como variável do frontend.

## Configuração e privacidade

| Valor | Onde | Sensível | Finalidade |
|---|---|---:|---|
| `API_BASE_URL` | variável do GitHub | não | endpoint público do Worker |
| `ALLOWED_ORIGINS` | `wrangler.toml` | não | origens que podem chamar a API pelo navegador |
| `BOOTSTRAP_TOKEN` | secret do Worker | sim | cria somente o primeiro moderador |
| `IP_HASH_SECRET` | secret do Worker | sim | pseudonimiza origem para limites, reações e denúncias |
| `SESSION_TTL_HOURS` | `wrangler.toml` | não | expiração da sessão administrativa |
| `REPORT_AUTO_FLAG_THRESHOLD` | `wrangler.toml` | não | denúncias únicas para ocultação automática |
| `DUCKS_ALLOWED_HOSTS` | `wrangler.toml` | não | hosts HTTPS aceitos no campo de perfil Ducks; atualmente `app.duckapps.com.br` |

O IP bruto não é gravado. O backend calcula um fingerprint SHA-256 combinado com `IP_HASH_SECRET`; fingerprints de reação e denúncia permanecem para impedir duplicidade, e registros expirados de rate limit são limpos durante novas requisições. Isso oferece pseudonimização, não anonimato criptográfico absoluto. Documente essa prática na política de privacidade da comunidade.

Fotos de perfil são armazenadas como BLOB no D1. A pessoa que cria o perfil deve ter direito de uso da imagem e compreender que ela será pública. Nome e descrição são sempre tratados como texto simples; a interface não interpreta HTML fornecido por usuários.

## Limites e próximos endurecimentos

- nenhum sistema conectado à internet pode prometer risco zero de invasão; as barreiras implementadas reduzem a superfície, mas exigem atualização, monitoramento e backup;
- o rate limit em D1 é adequado ao volume pequeno esperado, mas uma exposição grande deve adicionar Cloudflare Turnstile, regras de WAF e alertas do Worker;
- todos os moderadores têm o mesmo poder, inclusive criar ou desativar outros moderadores; uma organização maior deve introduzir papéis (`owner`/`moderator`);
- não existe recuperação de senha por e-mail; outro moderador ativo deve criar/desativar contas, ou o operador deve realizar manutenção controlada no D1;
- faça exportações/backup periódicos do D1 e defina política de retenção antes do uso real;
- fontes do Google têm fallback local, mas podem ser removidas se a comunidade exigir zero requisições de terceiros.
