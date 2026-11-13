# Controle de Execução de Ordens

Aplicação web para reunir a carteira mensal de ordens, distribuir a visualização por empresa e responsável e registrar execuções ou impedimentos com protocolo. O supervisor importa, acompanha e exporta a carteira; cada equipe usa seu próprio acesso no navegador.

**Idealização e desenvolvimento:** João Henrique Ferreira.

O sistema publicado está em [controle-manutencao-neoenergia.programation-077.workers.dev](https://controle-manutencao-neoenergia.programation-077.workers.dev). Celulares e computadores precisam apenas do navegador e de conexão com a internet.

## Documentação

- [Manual de uso em Markdown](docs/manual-do-usuario.md) — guia visual, por etapa, para equipes e supervisão.
- [Manual de uso em PDF](docs/manual-do-usuario.pdf) — versão pronta para leitura e compartilhamento, com telas ilustrativas em alta resolução.
- [Documentação técnica em Markdown](docs/documentacao-do-projeto.md) — arquitetura, tecnologias, regras, banco de dados, segurança, limites e operação.
- [Documentação técnica em PDF](docs/documentacao-tecnica.pdf) — versão diagramada para leitura e compartilhamento.

As imagens dos documentos mostram a interface usando exclusivamente dados demonstrativos fictícios.

## Como funciona

1. O supervisor importa a planilha geral do mês. As ordens ficam no banco de dados e são vinculadas ao tipo de empresa e ao valor de **RESPONSÁVEL**.
2. Uma pessoa autorizada registra a execução ou o impedimento. O servidor confirma a gravação e devolve um protocolo.
3. A execução conclui a ordem; o impedimento fica no histórico e mantém a ordem pendente para nova tentativa.
4. As telas abertas recebem avisos de mudanças e consultam os dados autorizados. A apresentação usa **QTD. AJUSTADA**; apenas a aderência final conta ordens.
5. O supervisor pode acrescentar ordens durante o mês, exportar a carteira e fazer a troca mensal.

A importação não modifica o arquivo original. A exportação da carteira completa inclui campos de execução e auditoria, abas de resumo e fórmulas com a identidade visual do modelo Excel. A exportação da apresentação conserva a estrutura, as cores e as fontes do arquivo original.

## Correções importantes dos erros de produção

Durante os primeiros testes, o envio da execução retornava erro 500 por `ReferenceError: observacao is not defined`. O Worker preparava o conteúdo em `observation`, mas usava um identificador inexistente ao montar a ordem. O código foi corrigido para gravar a observação corretamente; a gravação da ordem, do protocolo e da eventual evidência passou a ser confirmada em lote transacional. Depois da publicação, foi confirmado um protocolo gerado com sucesso.

Também foram identificados dois problemas independentes:

- **Senha:** o valor antigo de PBKDF2, 120.000 iterações, ultrapassava o limite aceito pela Web Crypto da Cloudflare. Novas senhas passaram a usar 100.000 iterações; perfis gravados com um hash legado incompatível precisam ter a senha renovada.
- **Cota do D1 gratuito:** a Cloudflare informou que a conta havia atingido o limite diário gratuito de linhas escritas. Uma importação inicial grava cada ordem aceita, mas consultas periódicas não regravam a carteira: quando não há mudanças, o servidor retorna apenas o cursor atualizado. A importação complementar insere somente ordens novas, e uma execução altera a ordem envolvida e cria seu registro de auditoria. O plano Workers Paid ampliou a franquia e removeu o bloqueio de cota que impedia aqueles testes; isso não corrige eventuais erros de código e o uso continua sujeito aos limites e à cobrança vigentes.

O limite de linhas escritas do D1 é diferente de requisições HTTP e de linhas lidas. A Cloudflare aplicava a franquia ao uso da conta, portanto o erro de cota, por si só, não prova que uma equipe ou um único registro tenha consumido todo o volume. A documentação técnica explica os tipos de operação e o que os logs confirmaram.

## Tecnologias principais

| Parte | Tecnologia |
| --- | --- |
| Interface | React 19, TypeScript, Vite e CSS responsivo |
| Apresentação | Tabelas responsivas em React e CSS |
| Exportação da apresentação | Modelo Excel original e fflate |
| Leitura e exportação de planilhas | SheetJS (xlsx) |
| API e arquivos publicados | Cloudflare Workers e Workers Assets |
| Dados | Cloudflare D1 |
| Avisos entre aparelhos | Durable Objects e WebSocket |
| Desenvolvimento e publicação | Node.js, npm e Wrangler |

As versões e os scripts ficam em [package.json](package.json). A configuração da Cloudflare fica em [wrangler.jsonc](wrangler.jsonc).

## Desenvolvimento local

Com Node.js 20 ou mais recente:

~~~bash
npm ci
npm run dev
~~~

Esse comando abre somente a interface de desenvolvimento. Para exercitar login, gravação e sincronização com um banco **local**, consulte a seção de desenvolvimento da [documentação técnica](docs/documentacao-do-projeto.md). Para compilar a versão de publicação:

~~~bash
npm run build
~~~

## Publicação e dados

O ramo **main** está conectado ao Workers Builds da Cloudflare. Um push inicia o build e a publicação; uma aba que já estava aberta precisa ser recarregada para receber a nova interface. O banco D1 e os segredos do supervisor já estão configurados na instalação atual. Não recrie o banco nem coloque senhas em arquivos versionados para fazer uma atualização comum.

O sistema exige conexão para salvar. Os protocolos são a confirmação de gravação; uma mudança visual antes dessa confirmação não substitui o registro no servidor. A carteira exportada é uma cópia para consulta e auditoria, não a planilha original com suas fórmulas e formatação.

Este repositório descreve o funcionamento do produto. Indicadores de economia de tempo ou de resultado operacional serão tratados após definição de uma linha de base e validação pela supervisão.
