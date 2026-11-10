# Manual do usuário

Este manual descreve as tarefas de quem administra a carteira e de quem registra serviços. O sistema funciona no navegador do celular, tablet ou computador. Para usar dados reais, acesse o endereço publicado pela sua organização.

## Antes de começar

- **Supervisor:** entra em **Acesso do supervisor** com o código e a senha administrativos. Pode importar, consultar, exportar e substituir a carteira, além de gerenciar os acessos.
- **Equipe:** escolhe **Neoenergia** ou **Vencer**, informa o código e a senha recebidos e pressiona **Enter** ou **Entrar**. Cada perfil vê as ordens vinculadas ao seu tipo e ao valor da coluna **RESPONSÁVEL**.
- Use uma conexão com a internet. Aguarde **Salvo no servidor** ou a tela **Registro confirmado** antes de fechar a página ou considerar uma operação concluída.
- O botão de olho permite conferir a senha digitada. Evite compartilhar credenciais em grupos públicos.

## Supervisor: começar a carteira do mês

1. Abra **Importar planilhas** e escolha **Nova carteira do mês**.
2. Selecione o arquivo `.xlsx`. Confira a aba detectada, a quantidade de ordens válidas e as linhas que serão ignoradas.
3. Confirme **Importar carteira do novo mês** e aguarde **Salvo no servidor**.
4. Abra **Ordens** ou **Painel** para conferir a quantidade importada e alguns responsáveis.

Linhas marcadas como **CANCELAR ORDEM** não entram na carteira. Na importação inicial, linhas sem número da ordem, empresa, equipe ou responsável são ignoradas. Confira a prévia antes de confirmar. Cabeçalhos repetidos impedem a importação até serem corrigidos no arquivo.

### Acrescentar ordens durante o mês

Em **Importar planilhas**, escolha **Acrescentar ordens**, selecione o arquivo e confira a prévia. Nessa modalidade, cada nova linha precisa ter número da ordem, empresa, equipe, responsável, serviço e quantidade ajustada. O sistema mantém as ordens existentes e seus registros, informa quantas foram adicionadas, ignora linhas incompletas ou de cancelamento e não duplica ordens já cadastradas.

### Trocar a carteira no mês seguinte

1. Em **Importar planilhas > Nova carteira do mês**, clique em **Exportar carteira completa**.
2. Guarde o arquivo baixado e confira se contém as informações esperadas. Só então use **Excluir carteira deste mês**, liberado após a exportação.
3. Confirme a exclusão e importe a planilha do novo mês.
4. Aguarde **Salvo no servidor** e confira as ordens no **Painel**.

A exclusão remove a carteira de ordens ativa. Os perfis de acesso continuam cadastrados; revise o valor **RESPONSÁVEL** de cada um após a nova importação. O histórico de protocolos continua disponível em **Protocolos**, mas o arquivo exportado deve ser guardado para consulta da carteira antiga.

## Supervisor: criar e manter acessos

1. Abra **Acessos > Criar acesso**.
2. Escolha **Neoenergia** ou **Vencer** e informe o **Responsável** como aparece na planilha.
3. Preencha o **Nome da pessoa (aparece nos protocolos)**, o **Código de acesso**, a senha e a confirmação. O olho mostra ou oculta cada campo de senha.
4. Clique em **Criar acesso** e aguarde **Alterações salvas**. Guarde o código e a senha exibidos: a senha não poderá ser consultada depois.

O cadastro pode ser feito mesmo que esse responsável não tenha ordens no mês. A tela avisa essa condição e, ao entrar, o usuário verá **Sem atividades na carteira atual**. Confira a grafia do responsável para evitar um perfil sem ordens por engano. O código precisa ser exclusivo; o formulário informa campos incompletos, código repetido ou senhas diferentes. Se o servidor rejeitar a alteração, a tela mostra o erro e oferece **Revisar perfil** e **Tentar novamente**. Um perfil ainda sem confirmação do servidor não deve ser distribuído à equipe.

Em **Acessos**, busque por nome, código ou responsável e use os filtros de empresa, responsável e estado para localizar um perfil. Clique em **Editar** para corrigir empresa, responsável, nome, código ou trocar a senha. Deixe os dois campos de senha vazios para mantê-la. As opções **Desativar acesso**, **Ativar acesso** e **Excluir acesso** ficam no fim do formulário de edição. A exclusão é permanente e exige confirmação. Editar ou excluir um perfil encerra suas sessões abertas.

## Equipe: consultar e registrar uma ordem

Após entrar, **Pendentes** mostra as ordens disponíveis para o responsável do perfil. O número nessa aba é a soma da **quantidade ajustada** dessas ordens. Use a busca para localizar número, alimentador ou barramento. **Ver detalhes** mostra os dados adicionais da planilha. **Executado** reúne as ordens concluídas por esse acesso; o número nessa aba também usa a quantidade ajustada.

**Apresentação** mostra gráficos da carteira vinculada ao perfil: quantidade ajustada por frente de serviço, por avanço e por UTD. A seção **Aderência da carteira** usa número de ordens, indicado separadamente na tela.

### Serviço executado

1. Na ordem pendente, clique em **Registrar execução**.
2. Escolha **Executado**, informe a quantidade realmente feita e, quando ela for menor que a prevista, explique a diferença em **Observação**.
3. Clique em **Salvar e gerar protocolo**. Aguarde **Registro confirmado** e anote o protocolo.

Depois da confirmação, a ordem sai de **Pendentes** e aparece em **Executado**. Outra equipe não consegue registrar uma execução para uma ordem já concluída; se alguém a concluir primeiro, o servidor informa o conflito ao tentar salvar.

### Serviço impedido

1. Na mesma tela, escolha **Impedimento**.
2. Selecione o motivo e descreva o ocorrido em **Observação**.
3. Se houver evidência, use **Foto adicionada** para tirar uma foto ou escolher uma imagem da galeria. A imagem aceita é JPEG, PNG ou WebP, até 1,2 MB.
4. Clique em **Registrar impedimento** e aguarde o protocolo.

O impedimento fica no histórico e pode ser consultado pelo supervisor, com motivo, observação e foto. A ordem **permanece pendente** na carteira para uma nova tentativa de execução. O impedimento não equivale à conclusão do serviço.

## Supervisor: acompanhar e conferir

- **Painel** resume ordens importadas, executadas, pendentes e impedimentos. A seção por responsável mostra o avanço de cada grupo.
- **Apresentação** acompanha a quantidade ajustada da carteira atual por frente, avanço e UTD. Escolha uma frente para detalhar suas UTDs. Apenas a seção **Aderência da carteira** conta ordens.
- **Controle** e **Ordens** oferecem busca e filtros. A opção **Outros dados da planilha** abre os campos adicionais sem repetir as colunas principais.
- **Protocolos** mostra cada tentativa separadamente, com protocolo, ordem, equipe, responsável, operador, resultado, problema, evidência e data. Use **Abrir foto** para examinar um impedimento e **Atualizar** para consultar registros recentes.
- **Exportar carteira** ou **Exportar seleção** gera uma planilha com os dados da carteira e campos de execução, quantidade, situação, impedimento e auditoria. A exportação mantém dados e cabeçalhos; não reproduz necessariamente a aparência, fórmulas ou células mescladas do arquivo original.

As telas abertas recebem um aviso após uma alteração salva e consultam os dados atualizados automaticamente. Também verificam alterações a cada cerca de **2 minutos** e quando a aba volta ao primeiro plano. Se a conexão ao vivo cair, fazem verificações mais frequentes até reconectar. Um protocolo só confirma o registro quando a tela mostrar **Registro confirmado**.

## Se algo não funcionar

| Mensagem ou situação | O que fazer |
| --- | --- |
| **Sem atividades na carteira atual** | Peça ao supervisor para conferir o tipo e o valor **RESPONSÁVEL** do perfil e se há ordens desse responsável no mês. |
| **Falha ao salvar** / **Não foi possível salvar o perfil** | Leia o erro exibido, corrija os dados se necessário e use **Tentar novamente**. Não distribua o acesso antes de **Alterações salvas**. |
| **Falha temporária no servidor** ao registrar | Anote a referência exibida e informe ao supervisor. Verifique se o protocolo apareceu no histórico antes de tentar outra vez, para evitar registros duplicados. |
| Ordem já executada por outra equipe | Atualize a lista para ver o estado atual. |
| Imagem recusada | Escolha JPEG, PNG ou WebP com até 1,2 MB. |
| Importação rejeitada | Confira formato `.xlsx`, cabeçalhos, campos obrigatórios e a prévia de linhas ignoradas. |

Ao reportar um problema, informe **tela, número da ordem, horário aproximado, mensagem e referência**, se houver. Não envie senhas.
