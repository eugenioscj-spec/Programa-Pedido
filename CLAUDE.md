# Oggi Sorvetes (Sinop-MT) — contexto para o Claude

Sistema próprio de gestão das lojas Oggi Sorvetes (franquia) do Eugenio e sócios: pedidos B2B pela câmara fria,
estoque com custo médio, financeiro (DRE/DFC, bancos, fluxo futuro), análises, CRM e integrações (CPlug, Rede).
Conversar sempre em português, com linguagem simples (o usuário não é programador). Fuso: America/Cuiaba (UTC−4).

## Onde está e como publica
- Render (plano pago, com disco `/data`, `DB_PATH=/data/oggi.db`). Publica sozinho a cada push na branch
  **`claude/oggi-sorvetes-b2b-ordering-lbo3ri`** (é nela que se trabalha; não há PR).
- Node 22, Express 5, better-sqlite3, front-end em JS puro (`public/`). Testes: `npm test` (node:test) — rodar antes de enviar.
- Migrações versionadas em `src/migrations.js` (cópia de segurança automática antes de migrar). Hoje: versão 15.
- Datas sempre por `src/time.js`. Kardex imutável (correção = estorno). Dinheiro em centavos.
- Variáveis no Render (o usuário cadastra; nunca pedir no chat): `CPLUG_EMPRESA/USUARIO/SENHA`,
  `REDE_CLIENT_ID/SECRET`, `REDE_USUARIO/SENHA` (produção), `ITAU_CLIENT_ID/SECRET`, `ITAU_CONTAS`
  (agência/conta-dígito) + Secret Files `itau.crt`/`itau.key`, `REDE_AMBIENTE` (sandbox|producao), `REDE_PVS`, `ADMIN_EMAIL/PASSWORD` (apagar depois de usar).

## Decisões já tomadas (não mudar sem perguntar)
- Regra do dono: não decidir sozinho nada que mude números contábeis; planejar e esperar o OK.
- Lojas: Loja 1 - Centro = CPlug "MT SINOP SETOR COMERCIAL" (CNPJ 63.532.954/0001-65, PV Rede 107468247, matriz);
  Loja 2 = "MT SINOP RESIDENCIAL BURITIS" (CNPJ 63.532.954/0002-46, PV 107531038, filial). Loja 2 também é cliente B2B
  (sem conta a receber; no futuro o pedido dela vira transferência). Confirmar a correspondência com o dono se surgir dúvida.
- Estoque da câmara: inventário físico de 13/11/2026 (880 caixas) sem custo — custo a informar. Top Hit 33/cx, Açaí 200g 12/cx.
  Transferência câmara → Loja 2 de 14/11/2026 (lista à mão, 109 caixas) lançada pela migração 15.
- B2B: pedido entregue vira conta a receber em entrega + 30 dias + 1 dia útil (prazo por cliente).
- Excluir pedido (inclusive entregue): só quem tem `can_delete_orders` (o dono). Desfaz estoque por estorno, apaga a conta a receber.
- CPlug: robô pelo login (o CPlug respeita "Aguarde N segundos"; dados vêm em listas `"data": [...]` das DataTables).
  Rotina: de hora em hora 8h–23h (hoje) e a partir das 3h (fechamento de ontem/anteontem); só GUARDA (cplug_daily_*).
  De-para dos produtos confirmado pelo dono (14/11/2026).
- Rede: API oficial Gestão de Vendas; sandbox funcionando; produção pedida por e-mail (ecommerce@userede.com.br) em 14/11/2026.
  Chamado da Rede RITM8284863 aberto em 16/11/2026 (prazo de até 3 dias úteis; Suporte E-Commerce Rede 3003 0603 / 0800 723 0603).
  18/11/2026: a Rede gerou as credenciais de PRODUÇÃO (Gestão de Acessos + Gestão de Vendas; enviadas ao e-mail do dono).
  Login de produção OK (grant password; escopo "feature_merchant_statement merchant-statement"); vendas davam 403
  "Partner not allowed for this company number" = falta o Opt-in. Opt-in em `src/rede-optin.js` (Integrações → Rede):
  POST /partner/v1/organizations/requests/features/merchant-statement (corpo montado lendo o swagger.yaml oficial na hora;
  campo obrigatório desconhecido = não envia), GET .../requests/{requestId}/features/merchant-statement (situação).
  Corpo real: {requestCompanyNumber, requestType: T|P|I, permissions: "R" (só leitura), companyNumbers só no P}.
  Pedido TOTAL feito em 17/11/2026 20:58 (nº be86c0b3-c9bd-4d39-b429-ab28639f5e85); APROVADO pelo dono no portal em 18/11/2026. Depois o dono aprova no portal (Minha Rede → PV → Conciliação → "Compartilhar").
  developer.userede.com.br é bloqueado NESTE ambiente (o Render acessa).
  Bandeira vem como código (brandCode: na Loja 2 em 16/11 apareceram 1, 2 e 14) — confirmar a tabela com comprovantes reais.
  Loja 2 (PV 107531038) funciona; Loja 1 sem vendas (mudando de ponto). Rede só traz até o dia ANTERIOR (D-1).
  Algumas vendas de crédito têm desconto ~2% além do MDR (bruto − líquido − mdrAmount; antecipação?) = other_cents: confirmar.
- Itaú (18/11/2026): API oficial "Account Statement" (`src/itau.js`, `src/itau-sync.js`; Integrações → Itaú). mTLS com
  certificado dinâmico (autosserviço no Itaú for Developers: criar aplicação com Extrato → credencial Produção → pedir
  aprovação → Owner aprova no Bankline em até 7 dias → emitir em até 72 h e baixar .crt/.key; vale 365 dias, renova 30 dias
  antes). Token STS client_credentials (~5 min). Extrato grava em bank_transactions (mesma conciliação do OFX); `insertNew`
  no bank.js evita duplicar OFX × API por dia+valor. Rotina: a cada 3 h, 6h–22h, últimos 7 dias (setting itau_auto).
  Aguardando o dono emitir a credencial/certificado e cadastrar no Render.
- Recebimentos das vendas das lojas (decisão 14/11/2026, para quando os lançamentos forem ligados): dinheiro no mesmo dia
  (caixa da loja); débito e crédito no dia útil seguinte no **Itaú** (vendem antecipado); Pix no mesmo dia (banco a confirmar).

## Pendências (lembrar o dono; apagar daqui quando resolver)
1. Receita das lojas na DRE: o dono quer separar venda loja × B2B e conferir com o CPlug antes de ligar o lançamento automático.
2. Pix das lojas: confirmar se cai no mesmo dia e em qual banco.
3. Taxas de cartão: lançar só quando a Rede liberar a produção (chamado RITM8284863; aí: REDE_AMBIENTE=producao, REDE_PVS, credenciais novas).
4. CMV das lojas pelo produto vendido (hoje: mercadoria enviada às lojas a custo) — pendência futura.
5. Estoque de cada loja: o dono vai fazer inventário das lojas; depois criar estoque por loja (transferência entra, venda do CPlug sai).
6. Custo do estoque da câmara (inventário de 13/11 entrou sem custo).
7. Decisões contábeis antigas ainda não confirmadas: transferência às lojas como CMV das lojas; perdas no CMV; brindes como despesa.
8. Bancos: cadastrar Itaú/Santander/Cofre com saldo inicial; depois conexão automática (Open Finance).
9. O dono disse ter "outras alterações" a pedir (ex.: preços) — perguntar.
10. Escala para ~20 lojas: avaliar API paga do CPlug (custo por acesso ou por loja — ele perguntou ao suporte), perfis de acesso
    para os sócios (contador = financeiro; sócio de Sinop = operacional; investidores = leitura), DRE semanal por loja com metas e
    alertas, relatório automático de segunda-feira, cópia de segurança fora do Render, feriados no "dia útil".
