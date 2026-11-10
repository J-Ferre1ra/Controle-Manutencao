# Documentação técnica e de operação

Esta documentação descreve a versão atual do Controle de Execução de Ordens. O [manual de uso](manual-do-usuario.md) explica as tarefas de quem trabalha nas telas; este arquivo explica as regras, os componentes e a manutenção do software.

## Objetivo e limites do produto

A aplicação reúne em uma carteira ativa as ordens da planilha mensal. O supervisor importa e acompanha essa carteira, cadastra acessos e consulta protocolos. Cada perfil de equipe consulta as ordens autorizadas e registra execução ou impedimento. A exportação gera um novo arquivo de acompanhamento; a planilha original não é editada pelo sistema.

A aplicação é online. Não existe fila de registros offline nem sincronização posterior garantida. Uma execução só deve ser considerada salva quando o servidor devolver o protocolo.

## Tecnologias

| Camada | Ferramentas | Uso no projeto |
| --- | --- | --- |
| Interface | [React 19](https://react.dev/), [TypeScript](https://www.typescriptlang.org/docs/) e [Vite 6](https://vite.dev/guide/) | Telas, tipos, compilação e entrega da interface. |
| Visualização | [Recharts](https://recharts.org/) e CSS responsivo | Gráficos da apresentação e layout para celular, tablet e computador. |
| Exportação da apresentação | [pdf-lib](https://pdf-lib.js.org/) | Gera no navegador o PDF da carteira filtrada pelo perfil da equipe. |
| Planilhas | [SheetJS](https://docs.sheetjs.com/) | Leitura de arquivos enviados e geração do arquivo Excel exportado. |
| API | [Cloudflare Workers](https://developers.cloudflare.com/workers/) | Login, autorização, importação, gravação, consulta e arquivos da interface. |
| Banco | [Cloudflare D1](https://developers.cloudflare.com/d1/) | Ordens, perfis, sessões, protocolos, fotos e revisões. |
| Atualização entre aparelhos | [Durable Objects](https://developers.cloudflare.com/durable-objects/) e WebSocket | Aviso de mudança; cada cliente busca seus dados pela API autenticada. |
| Operação | [Wrangler](https://developers.cloudflare.com/workers/wrangler/) e Workers Builds | Desenvolvimento local, migrações, build e publicação. |

As versões instaladas são controladas por [package.json](../package.json) e pelo arquivo de lock. Os aparelhos das equipes não precisam instalar Node.js, Python ou bibliotecas: usam o navegador.

## Arquitetura

~~~mermaid
flowchart LR
    U[Equipe ou supervisor] --> N[Navegador: React]
    N -->|HTTPS /api| W[Cloudflare Worker]
    W --> D[(D1)]
    W --> A[Workers Assets]
    N <-->|WebSocket /api/live| W
    W --> O[Durable Object: aviso de mudança]
~~~

O navegador nunca acessa o D1 diretamente. O Worker autentica a sessão, aplica o escopo do perfil e devolve apenas os dados permitidos. O Durable Object transmite somente o aviso de que houve alteração; ele não envia ordens, senhas nem protocolos pelo WebSocket.

### Organização do código

| Caminho | Responsabilidade |
| --- | --- |
| [src/App.tsx](../src/App.tsx) | Login, telas de equipe e supervisor, formulários, salvamento e sincronização. |
| [src/Presentation.tsx](../src/Presentation.tsx) | Cálculo e gráficos da carteira atual. |
| [src/lib/excel.ts](../src/lib/excel.ts) | Reconhecimento de abas e colunas, mapeamento de linhas e exportação Excel. |
| [src/lib/quantity.js](../src/lib/quantity.js) | Leitura de quantidades com separadores brasileiros ou internacionais. |
| [src/data/api.ts](../src/data/api.ts) | Chamadas HTTP e cursor de sincronização. |
| [src/types.ts](../src/types.ts) | Tipos de ordens, perfis, importações e notificações. |
| [src/styles.css](../src/styles.css) | Estilos e regras responsivas. |
| [worker/index.js](../worker/index.js) | Rotas da API, regras de autorização, operações D1 e canal de avisos. |
| [worker/access-profile-validation.js](../worker/access-profile-validation.js) | Validação dos perfis antes da gravação. |
| [drizzle](../drizzle) | Migrações SQL do D1. |
| [wrangler.jsonc](../wrangler.jsonc) | Worker, assets, ligação D1 e Durable Object. |

## Modelo de dados e regras

| Tabela D1 | Conteúdo |
| --- | --- |
| **work_orders** | Estado atual de cada ordem, dados importados e revisão da última alteração. |
| **access_profiles** | Empresa, responsável, nome, código, estado e hash da senha de cada perfil. |
| **execution_records** | Histórico de tentativas, cada uma com protocolo próprio. |
| **photos** | Evidências dos impedimentos, ligadas ao protocolo. |
| **imports** | Histórico das importações. |
| **sessions** | Sessões autenticadas com token armazenado como hash. |
| **sync_metadata** | Revisões da carteira e das mudanças incrementais. |
| **login_attempts** | Controle de tentativas de login malsucedidas. |

### Escopo dos perfis

O perfil é associado à **empresa** e ao valor de **RESPONSÁVEL**. Se um perfil também tiver vínculo de equipe, esse filtro é aplicado. Para fins de acesso, **NPER** da planilha é tratado como Neoenergia. O filtro é aplicado no Worker para ler ordens, registrar serviços e abrir fotos, além do filtro visual na interface. Um perfil pode continuar ativo mesmo sem ordem correspondente na carteira do mês; nesse caso, recebe uma lista vazia.

As notificações de registro são visíveis para perfis da mesma empresa. O aviso pode indicar a equipe e a pessoa que registrou, mas não amplia o acesso à lista de ordens ou às fotos.

### Estado de uma ordem

- **Pendente:** disponível para registro autorizado.
- **Executada:** concluída após confirmação do servidor; sai das pendentes.
- **Impedimento:** é uma tentativa registrada em **execution_records**. A ordem continua **pendente**, podendo receber uma nova tentativa.

A ordem atual guarda o último registro relevante; o histórico preserva as tentativas separadamente. Ao registrar uma execução, o servidor também grava o operador, horário, quantidade realmente informada e protocolo. Uma tentativa concorrente sobre ordem já concluída é recusada.

### Importação, troca mensal e exportação

- **Nova carteira:** a interface procura uma aba com número da ordem, **EMPRESA**, **EQUIPE** e **RESPONSÁVEL**; prefere **ACOMPANHAMENTO** quando presente. A prévia mostra linhas aceitas e ignoradas. Linhas **CANCELAR ORDEM** e linhas incompletas não entram. Cabeçalhos repetidos bloqueiam a importação. A carteira ativa precisa estar vazia para importar o novo mês.
- **Ordens complementares:** exigem também serviço e quantidade ajustada positiva. O servidor insere apenas as linhas novas, preservando as ordens existentes e seus registros. A chave de duplicidade é **número da ordem + empresa + responsável**.
- **Troca de mês:** o supervisor exporta a carteira completa, confirma a exclusão e importa o arquivo novo. A exclusão preserva perfis e histórico de protocolos. O servidor confere a revisão da carteira antes de excluir; uma mudança posterior à exportação exige nova conferência.
- **Exportação:** inclui as colunas da origem e campos de execução, observação, impedimento, operador, horário e protocolo. Gera também resumos por equipe e responsável. O arquivo não conserva a formatação, mesclagens e fórmulas exatas do arquivo recebido.

Na importação inicial, a carteira é gravada como conjunto de ordens. Registrar uma execução altera somente a ordem afetada, a revisão e o histórico, além da foto se houver. Editar um perfil não regrava as ordens. A importação complementar insere somente as ordens novas.

### Medidas da apresentação

A apresentação usa os dados das ordens ativas, já limitados pelo perfil no servidor:

| Indicador | Cálculo |
| --- | --- |
| Quantidade ajustada | Soma de **QTD. AJUSTADA** da seleção. |
| Quantidade executada na apresentação | Soma de **QTD. AJUSTADA** das ordens com estado **executada**. |
| Quantidade pendente | Quantidade ajustada menos a quantidade ajustada das ordens executadas. |
| Aderência da carteira | Número e percentual de ordens executadas. |
| Quantidade realmente executada | Valor informado pela equipe; aparece no protocolo e na exportação, separadamente dos totais acima. |

Exemplo: se a ordem tem quantidade ajustada **6** e a equipe informa **3 realizadas**, a apresentação considera **6** após a conclusão da ordem. O protocolo guarda **3** e a observação da diferença.

As frentes são identificadas a partir de **SERVIÇO**, **EQUIPE**, **AVANÇO** e **EMPRESA**: Poda LM, Roço manual, Bobcat, Linha viva, Estrutural próprio e Outros serviços. O gráfico de defeitos agrupa pela coluna **AVANÇO**. A UTD vem da coluna **UTD** da planilha; quando ela não existe, usa o responsável como referência. Os gráficos são recalculados com a carteira atual e não reutilizam fórmulas ou valores em cache da aba antiga **APRESENTAÇÃO**, que pode conter referências a outro mês.

A aba **APRESENTAÇÃO** do arquivo exportado tem indicadores próprios, inclusive quantidade informada e considerada com base no valor realmente executado. Compare o nome e a unidade do indicador antes de confrontá-lo com os gráficos online.

## API e sincronização

| Rota | Finalidade |
| --- | --- |
| **POST /api/login**, **GET /api/session**, **POST /api/logout** | Autenticar, recuperar e encerrar a sessão. |
| **GET /api/state** | Carteira completa ou alterações desde o cursor informado. |
| **GET /api/live** | WebSocket autenticado para avisos de mudança. |
| **POST /api/executions** | Registrar execução ou impedimento. |
| **GET /api/admin/executions** | Consultar o histórico paginado do supervisor. |
| **POST /api/admin/state** | Salvar mudanças administrativas, como perfis e carteira inicial. |
| **POST /api/admin/orders/import** | Incluir ordens complementares. |
| **POST /api/admin/orders/clear** | Excluir a carteira ativa após conferência de revisão. |
| **GET /api/photos/:protocol** | Abrir evidência conforme as permissões da sessão. |

Após uma gravação confirmada, o Worker publica um aviso no Durable Object. Cada navegador consulta **/api/state** com seu cursor e recebe ordens alteradas e notificações autorizadas. Uma troca completa de carteira exige recarregar o conjunto pertinente. Também há consulta a cada cerca de **2 minutos** e quando a aba volta ao primeiro plano. Se o WebSocket estiver desconectado, a interface tenta consultar a cada **15 segundos** até reconectar. Assim, o aviso acelera a atualização entre aparelhos sem fazer uma gravação no D1 por aparelho.

As quotas de **requisições**, **linhas lidas** e **linhas gravadas** são métricas distintas. A quantidade depende dos acessos e do uso real. Consulte o painel da conta e a [documentação de preços e limites](https://developers.cloudflare.com/workers/platform/pricing/) antes de fazer projeções de custo; o plano pago amplia franquias, mas não corrige erros de lógica ou configuração.

## Segurança

- O Worker valida a sessão antes de liberar ordens, histórico, fotos e o WebSocket; rotas administrativas exigem sessão de supervisor.
- Requisições de alteração feitas de outra origem são recusadas.
- O cookie de sessão usa **HttpOnly**, **Secure** e **SameSite=Lax**.
- Senhas dos perfis são derivadas com **PBKDF2 SHA-256 e 100.000 iterações**; o D1 guarda salt e hash. Os segredos **SUPERVISOR_CODE** e **SUPERVISOR_PASSWORD** pertencem à configuração do Worker, nunca ao repositório.
- Editar, desativar ou excluir um perfil invalida suas sessões abertas. O histórico de protocolos não é apagado com o perfil.
- As fotos aceitas são JPEG, PNG ou WebP, com limite aproximado de **1,2 MB** por envio. Nesta versão elas ficam no D1 em base64.

## Desenvolvimento local

Requer Node.js 20 ou mais recente e npm. Na raiz do repositório:

~~~bash
npm ci
npm run cf:db:migrate:local
npm run build
~~~

Para exercitar interface e API juntas, crie um arquivo **.dev.vars** local com credenciais **fictícias de teste** para **SUPERVISOR_CODE** e **SUPERVISOR_PASSWORD** e execute:

~~~bash
npx wrangler dev --local
~~~

O arquivo **.dev.vars** é ignorado pelo Git. O Wrangler local usa D1 e Durable Objects locais; não use dados nem credenciais reais em testes. **npm run dev** inicia só o Vite e serve para trabalhar na interface, sem a API completa. Os comandos de verificação disponíveis são **npm test** e **npm run build**.

## Publicação e manutenção

O ramo **main** está conectado ao Workers Builds da Cloudflare. Após o push, confira o resultado do build e a versão servida pelo endereço publicado. Uma aba do navegador aberta antes do deploy continua usando o JavaScript antigo até ser recarregada.

A instalação atual já tem o identificador do D1 em **wrangler.jsonc**. Para uma instalação nova em outra conta, crie outro D1, altere o identificador no arquivo, aplique as migrações SQL e configure os dois segredos do supervisor. Não recrie o banco da instalação atual para uma publicação comum. Alterações futuras nas tabelas exigem migração D1; a migração do Durable Object está declarada no Wrangler. A publicação manual, quando necessária e autenticada na conta correta, usa **npm run deploy**.

Na operação mensal, guarde e confira a exportação antes de excluir a carteira. Monitore uso do D1, falhas e referências de erro do Worker. O armazenamento de fotos no D1 e a ausência de fila offline são limites de arquitetura a reavaliar se o volume de uso crescer. Nenhuma estimativa de economia de tempo ou de produtividade foi validada aqui; resultados operacionais devem ser medidos e aprovados pela supervisão antes de divulgação.
