# Controle de Execução de Ordens

Aplicação web para reunir a carteira mensal de ordens, distribuir a visualização por empresa e responsável e registrar execuções ou impedimentos com protocolo. O supervisor importa, acompanha e exporta a carteira; cada equipe usa seu próprio acesso no navegador.

O sistema publicado está em [controle-manutencao-neoenergia.programation-077.workers.dev](https://controle-manutencao-neoenergia.programation-077.workers.dev). Celulares e computadores precisam apenas do navegador e de conexão com a internet.

## Documentação

- [Manual de uso](docs/manual-do-usuario.md) — tarefas das equipes e do supervisor, significado dos números e solução de problemas comuns.
- [Documentação técnica](docs/documentacao-do-projeto.md) — tecnologias, regras de negócio, arquitetura, dados, sincronização, desenvolvimento e publicação.

## Como funciona

1. O supervisor importa a planilha geral do mês. As ordens ficam no banco de dados e são vinculadas ao tipo de empresa e ao valor de **RESPONSÁVEL**.
2. Uma pessoa autorizada registra a execução ou o impedimento. O servidor confirma a gravação e devolve um protocolo.
3. A execução conclui a ordem; o impedimento fica no histórico e mantém a ordem pendente para nova tentativa.
4. As telas abertas recebem avisos de mudanças e consultam os dados autorizados. A apresentação usa **QTD. AJUSTADA**; apenas a aderência final conta ordens.
5. O supervisor pode acrescentar ordens durante o mês, exportar a carteira e fazer a troca mensal.

A importação não modifica o arquivo original. A exportação cria um novo arquivo com os campos de execução e auditoria.

## Tecnologias principais

| Parte | Tecnologia |
| --- | --- |
| Interface | React 19, TypeScript, Vite e CSS responsivo |
| Gráficos | Recharts |
| Exportação da apresentação | xlsx-js-style |
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
