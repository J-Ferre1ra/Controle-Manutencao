# Controle de Execução de Ordens

Aplicação web responsiva em React e TypeScript. Em produção, a interface e a API serão servidas pelo Cloudflare Workers, e os dados compartilhados ficarão no Cloudflare D1. Os computadores que acessam pelo navegador não precisam de Python, Pandas ou Node.js.

## Sincronização

Cada execução é salva no banco. As telas abertas consultam mudanças a cada 2 minutos e atualizam as ordens sem recarregar a página; ao voltar para uma aba que estava em segundo plano, ela consulta imediatamente. A carteira só é enviada completa quando muda a importação ou a configuração administrativa; as atualizações das equipes trazem apenas ordens alteradas desde a consulta anterior.

O formulário de execução avisa antes de fechar ou recarregar a página quando há informações ainda não enviadas. O navegador exibe a confirmação padrão, sem permitir personalizar o texto.

## Executar para desenvolvimento

Requer Node.js e npm na máquina de desenvolvimento:

```bash
npm install
npm run dev
```

Gerar a interface que será publicada:

```bash
npm run build
```

## Preparar a publicação Cloudflare

É necessário estar autenticado na conta Cloudflare que será usada. O domínio ainda pode ser definido depois; o Worker também pode ser acessado pelo endereço `workers.dev`.

1. Autentique o Wrangler: `npx wrangler login`.
2. Crie o banco: `npm run cf:db:create`.
3. Copie o `database_id` exibido para `wrangler.jsonc`, substituindo `PREENCHER_COM_O_ID_DO_D1`.
4. Aplique as tabelas no banco remoto: `npm run cf:db:migrate:remote`.
5. Configure os dois segredos do supervisor sem colocá-los no código ou no Git:

   ```bash
   npx wrangler secret put SUPERVISOR_CODE
   npx wrangler secret put SUPERVISOR_PASSWORD
   ```

6. Publique a interface e a API: `npm run deploy`.

O endereço final será informado pelo Wrangler. Depois do primeiro acesso administrativo, o supervisor importa as planilhas do mês e cadastra os acessos das equipes. Os arquivos de referência antigos não são carregados automaticamente.

## Estimativa de uso e custo

Como referência, 60 aparelhos ativos por 12 horas, consultando a cada 2 minutos, geram cerca de 21.600 consultas diárias ou 648 mil em 30 dias, sem contar login e registros. A sincronização incremental lê o cursor e somente as ordens alteradas. O Workers Paid inclui 10 milhões de requisições mensais; uso acima das franquias e outros produtos podem gerar cobrança adicional. Consulte a [tabela oficial de preços do Cloudflare Workers e D1](https://developers.cloudflare.com/workers/platform/pricing/) para os limites atuais.

## Dados e acesso

- `work_orders`: ordens, estado atual e dados de execução.
- `access_profiles`: perfis e códigos das equipes; senhas ficam armazenadas como hash.
- `execution_records`: histórico de auditoria e protocolos.
- `photos`: imagens de constatação de impedimentos.
- `sync_metadata`: revisões usadas para enviar apenas as mudanças aos aparelhos.

As imagens são exceções de impedimento, limitadas a 1,2 MB cada nesta versão. Os acessos das equipes veem somente as ordens da equipe e, quando vinculados, do responsável. Apenas o supervisor importa e altera a carteira.

## Planilhas

Os arquivos enviados foram usados para identificar a estrutura, não para preencher o banco. A exportação e a análise administrativa usam a carteira importada pelo supervisor. O sistema conserva cabeçalhos e ordem das colunas de origem e acrescenta os campos de execução e auditoria; não replica estilos, fórmulas ou mesclagens visuais dos arquivos originais.
