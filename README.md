# Controle de Execução de Ordens

Protótipo web responsivo para apresentar e validar o fluxo de execução de ordens da Neoenergia. A interface é uma SPA em React + TypeScript, roda no navegador e não usa Python.

## Executar localmente

Requer Node.js e npm somente para desenvolvimento:

```bash
npm install
npm run dev
```

Para gerar os arquivos estáticos:

```bash
npm run build
```

## O que já está no protótipo

- Acesso de demonstração para Inspeção, equipes próprias e terceirizadas.
- Pesquisa de ordens por número, alimentador, barramento, serviço e responsável.
- Registro de execução com quantidade realizada, observação e protocolo; Inspeção registra situação e observação.
- Registro de impedimento com motivo, observação e foto de constatação.
- Área administrativa demonstrativa para importar abas `.xlsx`, acompanhar equipes, consultar protocolos, gerir perfis e exportar ordens por equipe.
- Os cabeçalhos e a ordem de colunas da carteira importada são usados na exportação; os campos de auditoria são acrescentados.

## Planilhas recebidas

Os arquivos de outubro foram usados para entender os cabeçalhos e os relacionamentos. Nenhuma linha desses arquivos foi incluída na demonstração. As ordens fictícias exibidas no primeiro acesso servem somente para demonstrar as telas; ao importar a planilha `CONTROLE`, elas são removidas.

- `CONTROLE` / `ACOMPANHAMENTO` é a referência geral e contém `RESPONSÁVEL`.
- As carteiras `NPER` e `VENCER` podem complementar a carteira geral por `ORDEM` ↔ `NUM_CONSEQUENCIA`.
- `INSPEÇÃO` usa `OS`; seus registros ficam separados porque esse arquivo não trouxe uma chave que corresponda à planilha geral.
- `PES` e `PES LV` não são tratados como `RESPONSÁVEL`.

A exportação gera novas planilhas `.xlsx` com os cabeçalhos e a ordem de colunas da origem, mas não replica estilos, fórmulas ou mesclagens visuais dos arquivos originais.

## Limites desta versão

Esta é uma demonstração local: ordens, perfis e importações ficam no `localStorage` do navegador. Outro aparelho não compartilha esses dados. O acesso administrativo e os códigos mostrados na tela também são demonstrativos; não há autenticação real nem proteção de dados operacionais. Fotos e informações reais não devem ser usadas nesta versão.

Para operação compartilhada, o destino proposto é Supabase (PostgreSQL e armazenamento privado para evidências), sujeito à aprovação da TI e às políticas da empresa. O rascunho em [`supabase/schema.sql`](supabase/schema.sql) mostra as tabelas e regras de acesso previstas; ainda não há conexão com um projeto Supabase. No sistema real, somente a administração poderá importar e alterar a carteira do mês. As equipes poderão consultar as ordens vinculadas ao perfil, e registros de execução/impedimento serão mantidos para auditoria.

## Estrutura funcional confirmada

O painel das equipes prioriza `ALIMENTADOR`, `BARRAMENTO`, `QTD AJUSTADA`, `QTD EXECUTADA`, `NUM_CONSEQUENCIA`, `EMPRESA`, `EQUIPE`, `SERVIÇO`, `AVANÇO` e `RESPONSÁVEL`. `QTD EXECUTADA` é preenchida pela equipe. O consolidado mantém também a quantidade planejada para comparação e usa a quantidade realizada no registro.

Para equipes terceirizadas, cada perfil é vinculado à equipe e ao nome de `RESPONSÁVEL`; o nome de quem fez o registro fica separado para auditoria.
