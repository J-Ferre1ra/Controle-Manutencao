# Manual de uso

Este manual é para quem registra serviços e para quem administra a carteira. O sistema funciona no navegador do celular, tablet ou computador. É preciso estar conectado à internet para consultar e salvar dados.

## Acesso ao sistema

| Quem usa | Como entrar | O que pode fazer |
| --- | --- | --- |
| Equipe | Escolha **Neoenergia** ou **Vencer**, digite o código e a senha fornecidos pela supervisão e pressione **Enter** ou **Entrar nas ordens**. | Ver as ordens vinculadas ao perfil, registrar execução ou impedimento e consultar a apresentação da sua carteira. |
| Supervisor | Selecione **Acesso do supervisor** e informe o código e a senha administrativos. | Importar e exportar ordens, acompanhar resultados, consultar protocolos e administrar acessos. |

No celular, o menu do supervisor abre pelo botão **☰**. Ao terminar, use **Sair** ou **Sair da administração**, especialmente em aparelhos compartilhados.

Um acesso ativo pode não encontrar ordens em determinado mês. Nesse caso, a equipe verá **Sem atividades na carteira atual**. O supervisor deve conferir se a empresa e o nome **RESPONSÁVEL** do perfil correspondem aos da planilha importada.

## Entenda os números

| Termo | Significado |
| --- | --- |
| **Ordem** | Um registro da carteira, identificado pelo número da OS. |
| **QTD. AJUSTADA** | Quantidade prevista para a ordem na planilha importada. Os totais das abas **Pendentes**, **Executado** e dos gráficos usam essa medida. |
| **Quantidade realmente executada** | Valor informado pela equipe ao registrar a execução. Fica no protocolo e na exportação. |
| **Quantidade executada na Apresentação** | Soma da **QTD. AJUSTADA** das ordens concluídas. |
| **Aderência da carteira** | Número e percentual de ordens concluídas; é a seção que conta ordens em vez de quantidade ajustada. |

Exemplo: uma ordem com **QTD. AJUSTADA = 6** pode ser concluída com **3 realizadas**, desde que a diferença seja explicada na observação. A apresentação contabiliza **6** como quantidade ajustada de ordem concluída; o protocolo registra **3** como quantidade realmente executada. Um impedimento não conclui a ordem e não entra na quantidade executada da apresentação.

## Equipe: encontrar e registrar serviços

### Encontrar uma ordem

1. Entre com o seu acesso e abra **Pendentes**.
2. Use a busca por número da ordem, alimentador ou barramento.
3. Abra **Ver detalhes** para consultar os demais campos da planilha.
4. Confira o serviço e a quantidade prevista antes de registrar.

**Pendentes** e **Executado** mostram totais de quantidade ajustada. A aba **Executado** reúne as ordens concluídas vinculadas ao responsável do perfil, inclusive quando outra pessoa desse mesmo responsável fez o registro.

### Registrar uma execução

1. Na ordem pendente, toque em **Registrar execução** e mantenha **Executado** selecionado.
2. Informe a **Quantidade realmente executada**. Se for menor que a ajustada, explique o motivo em **Observação**.
3. Toque em **Salvar e gerar protocolo**.
4. Aguarde **Registro confirmado** e guarde o número do protocolo.

Depois da confirmação, a ordem deixa **Pendentes** e aparece em **Executado**. Se outra equipe tiver concluído a mesma ordem primeiro, o servidor informa o conflito; atualize a lista para conferir a situação.

### Registrar um impedimento

1. Na mesma tela, selecione **Impedimento**.
2. Escolha o motivo e descreva o ocorrido em **Observação**.
3. Se houver evidência, toque em **Adicionar foto de constatação** e escolha a câmera ou uma imagem da galeria. O sistema aceita JPEG, PNG e WebP e limita o envio a 1,2 MB.
4. Toque em **Registrar impedimento** e aguarde o protocolo.

O impedimento fica no histórico para conferência do supervisor, com motivo, observação e foto, quando enviada. A ordem **continua pendente** para uma nova tentativa. Se houver mais de uma tentativa, cada registro terá seu próprio protocolo.

### Acompanhar a carteira

A terceira aba, **Apresentação**, reúne a quantidade ajustada por frente de serviço, por **AVANÇO** e por UTD. Selecione uma frente em **Visão por UTD** para detalhá-la. A seção **Aderência da carteira** mostra quantas ordens foram concluídas. O percentual exibido é o avanço do mês inteiro (concluído dividido pela carteira), não o MTD% de uma meta até a data atual. Use **Exportar apresentação** para baixar um Excel com as abas **APRESENTAÇÃO** e **ORDENS**, limitado às ordens do seu acesso.

Ao receber um aviso de registro feito por outra equipe da mesma empresa, a tela consulta os dados atualizados. O aviso mostra quem registrou e pode ser fechado. A lista de ordens continua limitada ao perfil de acesso.

## Supervisor: operar a carteira

| Tela | Para que serve |
| --- | --- |
| **Painel** | Visão geral das ordens e acompanhamento por responsável. |
| **Controle** | Gráficos e filtros operacionais. |
| **Apresentação** | Quantidade ajustada por frente, avanço e UTD; aderência por número de ordens. |
| **Ordens** | Busca, filtros, detalhes da planilha e exportação da seleção. |
| **Importar planilhas** | Carteira do mês, inclusão de novas ordens, troca mensal e histórico de importações. |
| **Protocolos** | Histórico de execuções e impedimentos, incluindo operador, data, motivo e foto. |
| **Acessos** | Criação, edição, ativação, desativação e exclusão de perfis. |

### Importar a primeira carteira do mês

1. Abra **Importar planilhas > Nova carteira do mês** e selecione o arquivo de ordens.
2. Confira a aba reconhecida, a quantidade de linhas aceitas, as linhas ignoradas e as primeiras ordens na **Conferência antes de importar**. A prévia não grava dados.
3. Corrija o arquivo se houver cabeçalhos repetidos ou campos obrigatórios ausentes.
4. Clique em **Importar carteira do novo mês** e aguarde **Salvo no servidor**.
5. Confira a quantidade importada em **Painel** ou **Ordens** e alguns responsáveis em **Acessos**.

A planilha deve ter número da ordem, **EMPRESA**, **EQUIPE** e **RESPONSÁVEL** nas linhas importadas. Linhas marcadas **CANCELAR ORDEM** são desconsideradas. A aba **ACOMPANHAMENTO** é escolhida quando identificada; abas de apresentação e resumo não são importadas como ordens.

### Acrescentar ordens durante o mês

Em **Importar planilhas**, escolha **Acrescentar ordens**, selecione a nova planilha e confira a prévia. Cada nova linha precisa ter número da ordem, empresa, equipe, responsável, serviço e quantidade ajustada maior que zero. Clique em **Acrescentar à carteira atual**. O sistema informa quantas ordens entraram e quantas foram ignoradas ou reconhecidas como duplicadas.

As ordens existentes e seus registros são preservados. Para identificar uma duplicata nessa importação, o sistema compara **número da ordem + empresa + responsável**.

### Trocar a carteira no mês seguinte

1. Em **Importar planilhas > Nova carteira do mês**, use **Exportar carteira completa**.
2. Confira se o arquivo foi baixado e guarde-o para consulta e auditoria.
3. Após a exportação, use **Excluir carteira deste mês** e confirme a operação.
4. Importe a planilha do novo mês e aguarde **Salvo no servidor**.
5. Confira as ordens e revise os responsáveis dos perfis de acesso.

A exclusão remove a carteira ativa, mas mantém os perfis e o histórico de protocolos. Se outra pessoa alterar a carteira após a exportação, o servidor pode exigir uma nova exportação antes de permitir a exclusão. O arquivo exportado é necessário para consultar a carteira antiga fora da tela de ordens atuais.

### Criar ou manter acessos

1. Abra **Acessos** e clique em **+ Criar acesso**.
2. Escolha a empresa e informe **Responsável** exatamente como aparece na carteira.
3. Preencha **Nome da pessoa (aparece nos protocolos)**, código de acesso, senha e confirmação. O botão de olho permite conferir os campos de senha nesse formulário.
4. Clique em **Criar acesso** e aguarde **Alterações salvas** antes de entregar o código e a senha à pessoa.

O código deve ser exclusivo. O formulário avisa quando o responsável não possui ordens no mês; o perfil ainda pode ser criado para uso em outra carteira. Se o servidor rejeitar o cadastro, leia a mensagem e use **Revisar perfil** ou **Tentar novamente**. Uma credencial sem confirmação de salvamento não deve ser distribuída.

Para alterar um perfil, localize-o pela busca ou pelos filtros e clique em **Editar acesso**. É possível corrigir empresa, responsável, nome e código. Para manter a senha atual, deixe os dois campos de nova senha vazios. No fim do formulário há **Desativar acesso**, **Ativar acesso** e **Excluir acesso**. Excluir é permanente para o perfil e exige confirmação; os protocolos históricos continuam disponíveis. Alterar ou excluir um perfil encerra suas sessões abertas.

### Conferir registros e exportar

Em **Protocolos**, consulte a tabela de registros e confira número da ordem, protocolo, operador, resultado, data, observação e evidência. **Abrir foto** mostra a imagem de um impedimento quando houver. Use **Atualizar** para consultar registros recentes e **Carregar mais registros** para ver páginas anteriores.

**Exportar carteira**, no topo das páginas administrativas, baixa a carteira completa. Na página **Apresentação**, use **Exportar apresentação** para baixar apenas o resumo e as ordens da carteira. A exportação da carteira inclui campos de execução e auditoria e preserva os dados das colunas de origem; ela não reproduz exatamente as fórmulas, cores e mesclagens do arquivo enviado.

## Salvamento e atualização das telas

Uma operação administrativa só está confirmada quando aparecer **Salvo no servidor** ou **Alterações salvas**. **Conectado** indica comunicação com o servidor, mas não confirma uma alteração pendente. Para a equipe, a confirmação é a tela **Registro confirmado** com protocolo.

Após uma mudança salva, as telas abertas recebem um aviso e consultam os dados. Também verificam mudanças periodicamente e quando a aba volta ao primeiro plano. Sem conexão, o sistema não mantém uma fila local confiável para enviar registros depois. Se a página já estava aberta antes de uma nova versão ser publicada, recarregue-a para receber a interface atualizada.

## Se algo não funcionar

| Situação | O que fazer |
| --- | --- |
| **Sem atividades na carteira atual** | Confirme com o supervisor a empresa, o valor **RESPONSÁVEL** e se há ordens para ele neste mês. |
| **Falha ao salvar** ou cadastro rejeitado | Leia a mensagem exibida, corrija o campo indicado e tente novamente. Aguarde a confirmação do servidor. |
| Falha ao gerar protocolo | Informe ao supervisor o número da ordem, horário e referência da falha. Antes de repetir, confira em **Protocolos** se o registro entrou. |
| Ordem concluída por outra equipe | Atualize a lista e confira o estado da ordem. |
| Foto recusada | Escolha outra imagem JPEG, PNG ou WebP de até 1,2 MB. |
| Importação rejeitada | Confira o arquivo, cabeçalhos, campos obrigatórios e linhas ignoradas na prévia. |

Ao comunicar um problema, informe **tela, número da ordem, horário aproximado e mensagem exibida**. Não envie senhas.
