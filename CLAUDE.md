# Oggi Sorvetes (Sinop-MT) — contexto para o Claude

Sistema próprio de gestão das lojas Oggi Sorvetes (franquia) do Eugenio e sócios: pedidos B2B pela câmara fria,
estoque com custo médio, financeiro (DRE/DFC, bancos, fluxo futuro), análises, CRM e integrações (CPlug, Rede).
Conversar sempre em português, com linguagem simples (o usuário não é programador). Fuso: America/Cuiaba (UTC−4).

## Onde está e como publica
- Render (plano pago, com disco `/data`, `DB_PATH=/data/oggi.db`). Publica sozinho a cada push na branch
  **`claude/oggi-sorvetes-b2b-ordering-lbo3ri`** (é nela que se trabalha; não há PR).
- Node 22, Express 5, better-sqlite3, front-end em JS puro (`public/`). Testes: `npm test` (node:test) — rodar antes de enviar.
- Migrações versionadas em `src/migrations.js` (cópia de segurança automática antes de migrar). Hoje: versão 14.
- Datas sempre por `src/time.js`. Kardex imutável (correção = estorno). Dinheiro em centavos.
- Variáveis no Render (o usuário cadastra; nunca pedir no chat): `CPLUG_EMPRESA/USUARIO/SENHA`,
  `REDE_CLIENT_ID/SECRET`, `REDE_AMBIENTE` (sandbox|producao), `REDE_PVS`, `ADMIN_EMAIL/PASSWORD` (apagar depois de usar).

## Decisões já tomadas (não mudar sem perguntar)
- Regra do dono: não decidir sozinho nada que mude números contábeis; planejar e esperar o OK.
- Lojas: Loja 1 - Centro = CPlug "MT SINOP SETOR COMERCIAL" (CNPJ 63.532.954/0001-65, PV Rede 107468247, matriz);
  Loja 2 = "MT SINOP RESIDENCIAL BURITIS" (CNPJ 63.532.954/0002-46, PV 107531038, filial). Loja 2 também é cliente B2B
  (sem conta a receber; no futuro o pedido dela vira transferência). Confirmar a correspondência com o dono se surgir dúvida.
- Estoque da câmara: inventário físico de 13/11/2026 (880 caixas) sem custo — custo a informar. Top Hit 33/cx, Açaí 200g 12/cx.
- B2B: pedido entregue vira conta a receber em entrega + 30 dias + 1 dia útil (prazo por cliente).
- Excluir pedido (inclusive entregue): só quem tem `can_delete_orders` (o dono). Desfaz estoque por estorno, apaga a conta a receber.
- CPlug: robô pelo login (o CPlug respeita "Aguarde N segundos"; dados vêm em listas `"data": [...]` das DataTables).
  Rotina: de hora em hora 8h–23h (hoje) e a partir das 3h (fechamento de ontem/anteontem); só GUARDA (cplug_daily_*).
  De-para dos produtos confirmado pelo dono (14/11/2026).
- Rede: API oficial Gestão de Vendas; sandbox funcionando; produção pedida por e-mail (ecommerce@userede.com.br) em 14/11/2026.
  Bandeira vem como código (brandCode) — confirmar a tabela com comprovantes reais.
- Recebimentos das vendas das lojas (decisão 14/11/2026, para quando os lançamentos forem ligados): dinheiro no mesmo dia
  (caixa da loja); débito e crédito no dia útil seguinte no **Itaú** (vendem antecipado); Pix no mesmo dia (banco a confirmar).

## Pendências (lembrar o dono; apagar daqui quando resolver)
1. Receita das lojas na DRE: o dono quer separar venda loja × B2B e conferir com o CPlug antes de ligar o lançamento automático.
2. Pix das lojas: confirmar se cai no mesmo dia e em qual banco.
3. Taxas de cartão: lançar só quando a Rede liberar a produção (aí: REDE_AMBIENTE=producao, REDE_PVS, credenciais novas).
4. CMV das lojas pelo produto vendido (hoje: mercadoria enviada às lojas a custo) — pendência futura.
5. Estoque de cada loja: o dono vai fazer inventário das lojas; depois criar estoque por loja (transferência entra, venda do CPlug sai).
6. Custo do estoque da câmara (inventário de 13/11 entrou sem custo).
7. Decisões contábeis antigas ainda não confirmadas: transferência às lojas como CMV das lojas; perdas no CMV; brindes como despesa.
8. Bancos: cadastrar Itaú/Santander/Cofre com saldo inicial; depois conexão automática (Open Finance).
9. O dono disse ter "outras alterações" a pedir (ex.: preços) — perguntar.
10. Escala para ~20 lojas: avaliar API paga do CPlug (custo por acesso ou por loja — ele perguntou ao suporte), perfis de acesso
    para os sócios (contador = financeiro; sócio de Sinop = operacional; investidores = leitura), DRE semanal por loja com metas e
    alertas, relatório automático de segunda-feira, cópia de segurança fora do Render, feriados no "dia útil".
