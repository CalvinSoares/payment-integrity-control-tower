# AGENTS.md

## Missão

Construir uma plataforma de integridade de pagamentos que seja independente de adquirente e possa operar com Axxon ou qualquer combinação de gateway, processador, banco e bandeira.

## Regras obrigatórias

1. O domínio não pode importar SDK, nome de rota ou modelo específico de um provedor.
2. Integrações externas devem estar atrás de portas (`ports`) e adaptadores (`adapters`).
3. Valores monetários são inteiros na menor unidade da moeda; nunca usar `float` para decisão financeira.
4. Eventos, comandos, arquivos e webhooks precisam de chave idempotente e deduplicação.
5. O ledger é imutável: correções geram novos lançamentos, nunca UPDATE destrutivo.
6. Toda decisão financeira precisa ser explicável por evidências, regras aplicadas e versão do algoritmo.
7. Dados sensíveis devem ser minimizados, mascarados e nunca incluir PAN/CVV real.
8. Não executar pagamento, retenção ou ajuste automático sem política explícita e trilha de auditoria.
9. Testar duplicidade, ordem invertida, atraso, replay, partial failure, timeout e reprocessamento.
10. Toda mudança de contrato exige versão, exemplo válido e estratégia de compatibilidade.

## Forma de trabalhar

- Antes de implementar um adaptador, documentar o mapeamento provedor → modelo canônico.
- Antes de separar um serviço, demonstrar a necessidade operacional ou de escala.
- Manter fixtures determinísticas de autorização, captura, liquidação, estorno, chargeback e repasse.
- Não colocar segredos, PAN, CVV ou arquivos reais de liquidação no repositório.
- Toda mudança deve declarar impacto em dados, eventos, reprocessamento e observabilidade.

## Definição de pronto

Uma fase só termina quando possui contrato documentado, testes de sucesso e falha, métricas/logs mínimos, replay seguro e uma forma de explicar o resultado para operação.

## Política obrigatória de commits

Cada fase deve ser dividida em tarefas pequenas e independentes. Cada tarefa concluída deve gerar um commit próprio, com escopo claro e reversível.

- Nunca usar `git add .` ou um commit genérico para encerrar uma fase.
- Informar sempre os caminhos exatos no `git add --`.
- Antes do commit, executar `git diff --cached --check` e, quando fizer sentido, os testes da tarefa.
- Entregar ao usuário o comando completo de commit, incluindo uma mensagem Conventional Commit específica.
- Não misturar documentação, domínio, banco, adaptador e testes no mesmo commit quando puderem ser separados.
- Se um arquivo tiver mudanças de tarefas diferentes, usar `git add -p` e explicar quais hunks selecionar.
- Nunca incluir `.env`, segredos, dumps, dados reais ou alterações não relacionadas.

O checklist de toda tarefa é: implementar → testar → mostrar arquivos exatos → fornecer comando de stage → fornecer comando de commit → indicar o próximo commit da sequência.
