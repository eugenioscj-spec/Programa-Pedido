# Oggi Sorvetes (Sinop-MT) — contexto para o Claude

Sistema próprio de gestão das lojas Oggi Sorvetes (franquia) do Eugenio e sócios: pedidos B2B pela câmara fria,
estoque com custo médio, financeiro (DRE/DFC, bancos, fluxo futuro), análises, CRM e integrações (CPlug, Rede).
Conversar sempre em português, com linguagem simples (o usuário não é programador). Fuso: America/Cuiaba (UTC−4).

## Onde está e como publica
- Render (plano pago, com disco `/data`, `DB_PATH=/data/oggi.db`). Publica sozinho a cada push na branch
  **`claude/oggi-sorvetes-b2b-ordering-lbo3ri`** (é nela que se trabalha; não há PR).
- Node 22, Express 5, better-sqlite3, front-end em JS puro (`public/`). Testes: `npm test` (node:test) — rodar antes de enviar.
- Migrações versionadas em `src/migrations.js` (cópia de segurança automática antes de migrar). Hoje: versão 18.
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
  Bandeira (brandCode): 1 = Mastercard, 2 = Visa (conferido: vendas de 16/11 da Loja 2 = depósitos de 17/11 no Itaú
  "RECEBIMENTO REDE VISA DB"/"MAST DB"/"MAST AT", centavo a centavo); 14 = provavelmente Elo (falta confirmar).
  No extrato Itaú: DB = débito (D+1), AT = crédito antecipado (D+1, ~2% a mais), CD = crédito sem antecipação (~30 dias).
  Loja 2 (PV 107531038) funciona; Loja 1 sem vendas (mudando de ponto). Rede só traz até o dia ANTERIOR (D-1).
  Algumas vendas de crédito têm desconto ~2% além do MDR (bruto − líquido − mdrAmount; antecipação?) = other_cents: confirmar.
- Itaú (18/11/2026): API oficial "Account Statement" (`src/itau.js`, `src/itau-sync.js`; Integrações → Itaú). mTLS com
  certificado dinâmico (autosserviço no Itaú for Developers: criar aplicação com Extrato → credencial Produção → pedir
  aprovação → Owner aprova no Bankline em até 7 dias → emitir em até 72 h e baixar .crt/.key; vale 365 dias, renova 30 dias
  antes). Token STS client_credentials (~5 min). Extrato grava em bank_transactions (mesma conciliação do OFX); `insertNew`
  no bank.js evita duplicar OFX × API por dia+valor. Rotina: a cada 3 h, 6h–22h, últimos 7 dias (setting itau_auto).
  Contas Itaú: MATRIZ (Loja 1) ag. 1364 c/c 97535-7; FILIAL (Loja 2) ag. 4776 c/c 99822-3 → ITAU_CONTAS="1364/0097535-7,4776/0099822-3". O dono gerou as chaves no programa do ZIP (caminho do analista) e vai
  mandar a chave pública ao gerente pedindo Extrato + Pix cobrança + Boletos + DDA (sem pagamentos).
  26/11/2026: Itaú abriu "Implantação Técnica do produto Conciliação Bancária" em análise — protocolos IT-000271752
  (1364/97535-7) e IT-000271757 (1364/97535-7 e 4776/99822-3); razão social GELARE LOJA MT01 LTDA. Aguardando o e-mail
  com os 3 valores criptografados (etapa 2 do programa) ou outra instrução do gerente.
  28/11/2026: o Itaú mandou (fluxo "varejo") uma PLANILHA com Client ID de produção + TOKEN TEMPORÁRIO por CNPJ (vale 7 dias;
  escopos liberados em até 2 dias úteis; NÃO criar credencial nova no portal). O sistema gera o certificado sozinho
  (`src/itau-cert.js`: chave RSA 2048 + CSR igual ao programa oficial, POST sts.itau.com.br/seguranca/v1/certificado/solicitacao
  com Bearer token temporário; a resposta traz o .crt e "Secret: <uuid>" = Client Secret). Guarda em itau_credentials
  (migração 18; chave e secret com seal(), cifrados se ITAU_CRYPT_KEY existir; contas por credencial). Tela: Integrações →
  Itaú → "Gerar certificado com a planilha do Itaú". A rotina usa as credenciais do banco (senão, as variáveis do servidor).
  28/11/2026: certificado GERADO pelo dono no sistema (credencial da matriz, contas 1364/97535-7 e 4776/99822-3), vale até
  27/11/2027; token OAuth testado OK. Falta: escopos (até 2 dias úteis) → "Buscar extrato agora"; ver se a filial é coberta.
  Se o STS recusar o TLS, ITAU_TLS_INSECURE=1 (o programa oficial do Itaú não verifica o certificado do servidor). OFX do Itaú: o parser
  ignora linhas "SALDO ..." e aceita UTF-8 declarado como 1252.
- Conferência (18/11/2026, menu "Conferência"; `src/conciliacao.js` + `src/rede-sync.js`, migração 16): VALOR EXATO
  (decisão do dono: diferença zero; se as inconsistências forem muitas, rever). Por loja e dia: crédito/débito CPlug × Rede
  (bruto aprovado); Pix CPlug × "PIX QR CODE RECEBIDO" no Itaú da loja; depósito: líquido do débito + crédito antecipado
  (other_cents > 0) × "RECEBIMENTO REDE <BANDEIRA> DB|AT<PV>" no dia útil seguinte (CD = crédito de ~30 dias, à parte).
  Rotina Rede: guarda rede_sales/rede_days, refaz os 3 últimos dias, a partir das 6h de 8 em 8 h (setting rede_auto).
  Lojas ligadas: int_stores source 'rede' (107468247 → Loja 1, 107531038 → Loja 2); contas Itaú em settings conc_itau_contas.
  Validado com dados reais de 16/11 (Loja 2): tudo bate, depósito 17/11 = R$ 272,01. Só compara, não lança nada.
- Organização (19/11/2026): menu por áreas (GROUPS em admin.js: Visão geral, Lojas, Distribuição, Financeiro, Relatórios,
  Configurações; submenu na 2ª linha). Painel executivo (`src/executive.js`, rota /executivo): vendas das lojas (CPlug) mês ×
  mesmo período do mês anterior, 12 meses, B2B, caixa, contas, conferência 7 dias, estoque, integrações e alertas; EBITDA
  por loja ainda NÃO (depende das decisões contábeis). Cadastro das lojas (`src/stores.js`, migração 17: cnpj, status,
  opened_at, area_m2, rent_cents, capex_cents, royalty_bp, marketing_bp, itau_account; liga CPlug/PV Rede; nova loja cria o
  caixa). Feriados (`src/holidays.js`: nacionais + Carnaval/Sexta Santa/Corpus Christi + extras em settings feriados_extras)
  usados por nextBusinessDay. Registro de alterações (`src/audit.js`, tabela audit_log): todo POST/PUT/PATCH/DELETE do
  painel, sem senhas/chaves; tela em Configurações.
- Recebimentos das vendas das lojas (decisão 14/11/2026, para quando os lançamentos forem ligados): dinheiro no mesmo dia
  (caixa da loja); débito e crédito no dia útil seguinte no **Itaú** (vendem antecipado); Pix no mesmo dia (banco a confirmar).

## Pendências (lembrar o dono; apagar daqui quando resolver)
1. Receita das lojas na DRE: o dono quer separar venda loja × B2B e conferir com o CPlug antes de ligar o lançamento automático.
2. Pix das lojas: o OFX do Itaú da filial mostra "PIX QR CODE RECEBIDO" no mesmo dia (Loja 2 → Itaú 4776/99822-3); confirmar com o dono e a Loja 1.
3. Taxas de cartão: a Rede de produção JÁ funciona (18/11). Falta o dono decidir como lançar: MDR (taxa) e antecipação (~2%) como despesas separadas?
4. CMV das lojas pelo produto vendido (hoje: mercadoria enviada às lojas a custo) — pendência futura.
5. Estoque de cada loja: o dono vai fazer inventário das lojas; depois criar estoque por loja (transferência entra, venda do CPlug sai).
6. Custo do estoque da câmara (inventário de 13/11 entrou sem custo).
7. Decisões contábeis antigas ainda não confirmadas: transferência às lojas como CMV das lojas; perdas no CMV; brindes como despesa.
8. Bancos: cadastrar Itaú/Santander/Cofre com saldo inicial; depois conexão automática (Open Finance).
9. O dono disse ter "outras alterações" a pedir (ex.: preços) — perguntar.
11. Itaú: certificado gerado (28/11). Testar "Buscar extrato agora" após liberação dos escopos (até 2 dias úteis); se a filial der 403, pedir à gerente.
12. Estratégia (19/11/2026): meta de 20 lojas e venda por R$ 10 mi+ → proposta de menus por área, painel executivo, DRE por loja
    (EBITDA de loja), orçamento × realizado, fechamento mensal com trava, auditoria, cadastro de lojas (CAPEX, m², aluguel),
    pacote de valuation (LTM, SSS, cohort). FEITO em 19/11: menus, cadastro de lojas, feriados, registro, painel executivo.
    Falta: o dono preencher a ficha das lojas (inauguração, m², aluguel, investimento, royalties/marketing) e ligar o CPlug da Loja 1.
10. Escala para ~20 lojas: avaliar API paga do CPlug (custo por acesso ou por loja — ele perguntou ao suporte), perfis de acesso
    para os sócios (contador = financeiro; sócio de Sinop = operacional; investidores = leitura), DRE semanal por loja com metas e
    alertas, relatório automático de segunda-feira, cópia de segurança fora do Render, feriados no "dia útil".
