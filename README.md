# Oggi Sorvetes · Pedidos B2B e Estoque

Sistema web para a loja receber **pedidos de clientes empresa (B2B)** por um link e **controlar o estoque da câmara fria**, com entrada e saída de tudo por **código de barras**.

| Link | Para quem | O que faz |
|---|---|---|
| `https://SEU-ENDERECO/` | Clientes B2B | Cadastro por **CNPJ ou CPF**, catálogo por **tipo › linha**, **favoritos**, pedido por **caixa fechada ou unidade**, histórico, repetir pedido |
| `https://SEU-ENDERECO/admin` | Loja | Pedidos, separação com leitor, entrada com custo, saídas por destino, estoque a custo, relatórios, produtos com foto, clientes |

---

## Perfis de acesso

| Perfil | Onde entra | O que vê e faz |
|---|---|---|
| **Master** | `/admin` | Tudo: pedidos, estoque com custo e faturamento potencial, relatórios, **Financeiro (DRE e DFC)**, produtos, clientes, usuários e configurações. |
| **Loja** | `/admin` | Só o **estoque da câmara em quantidades** (sem custos nem preços) e **Repor loja**: registra o que levou da câmara para a loja dele (vira uma transferência para aquela loja). |
| **Cliente B2B** | `/` | Só o catálogo (das linhas liberadas para ele), os favoritos e os próprios pedidos. Não vê quantidades em estoque. |

O master cria os usuários em **Config. → Usuários do painel** (perfil Loja exige escolher a loja) e pode desativar ou trocar a senha. Sempre existe ao menos um master ativo.

## Clientes, linhas liberadas e favoritos

- **CNPJ ou CPF:** o cliente entra e se cadastra com qualquer um dos dois (CPF para estabelecimentos informais). Continua sendo cliente B2B.
- **Tipo › Linha:** cada produto tem um **tipo** (Picolés, Potes, Açaí, Sundae, Cones, Bombons) e uma **linha** (Sensa, Clássicos, Disney…). O catálogo do cliente filtra primeiro pelo tipo e depois pela linha. Produto novo sem tipo recebe o tipo pelo começo do nome.
- **Linhas liberadas:** em **Clientes → Editar**, o master escolhe o que cada cliente pode ver e pedir. Tipo inteiro marcado inclui as linhas que forem cadastradas depois; tudo marcado = sem restrição. O servidor também recusa pedido de produto fora das linhas liberadas.
- **Favoritos:** o cliente toca na ☆ do produto e ele aparece na aba **★ Favoritos**, para pedir mais rápido.

## Financeiro: DRE e DFC (só master)

Em **Financeiro**:

- **Lançamentos:** receitas e despesas com conta, valor, **competência** (mês do resultado), vencimento e data de pagamento/recebimento (vazio = em aberto). Mostra o total a pagar e a receber em aberto.
- **DRE gerencial** (competência), mês a mês: a venda B2B, o CMV, as perdas, os brindes/parcerias e a mercadoria enviada às lojas **vêm sozinhos do estoque**; o resto vem dos lançamentos, conforme a "linha da DRE" de cada conta. Enquanto as vendas do balcão não vêm do PDV, lance-as nas contas "Vendas Loja…"; a mercadoria enviada às lojas (a custo) faz o papel do CMV das lojas.
- **DFC** (método direto, regime de caixa): só o que foi efetivamente pago/recebido, separado em atividades operacionais, de investimento e de financiamento, com saldo inicial e final. Informe o saldo de caixa inicial em **Plano de contas**.
- **Plano de contas:** editável. "Recebimento de clientes B2B" e "Pagamento de notas de mercadoria" entram só no caixa, para não contar duas vezes na DRE.

Exportação para Excel/CSV como os demais relatórios.

### Bancos: extratos OFX e conciliação

Em **Financeiro → Bancos e conciliação**:

1. Exporte o extrato em **OFX** no internet banking (Itaú, Santander, Bradesco, C6 e outros) e importe. Pode mandar vários arquivos e meses de uma vez; o que já foi importado é ignorado, mesmo com períodos sobrepostos. A conta bancária é criada sozinha.
2. O sistema **confere o saldo**: calcula o saldo de cada conta pelos movimentos e compara com o saldo que o banco informa em cada arquivo. Se não bater, provavelmente falta importar algum período.
3. **Concilie** cada movimento:
   - **Dar baixa:** quando existe um lançamento em aberto com o mesmo valor e vencimento próximo (até 10 dias), o sistema sugere a baixa;
   - **Lançar:** escolhe a conta do plano de contas e o movimento vira um lançamento já pago. Marcando "lembrar", o sistema aprende e sugere a mesma conta da próxima vez;
   - **Ignorar:** para o que só troca dinheiro de lugar (transferência entre contas próprias, aplicação/resgate, pagamento de fatura do cartão).
   - Dá para selecionar vários e **aceitar as sugestões** ou lançar todos numa conta. Tudo pode ser desfeito.
4. **Extratos por banco:** saldo inicial, entradas, saídas e saldo final de cada conta, mês a mês, além dos totais por categoria.

O saldo dos bancos calculado pelos extratos entra sozinho no saldo inicial da **DFC**. O "saldo inicial em dinheiro" do plano de contas é só o que fica fora dos bancos.

## Como o estoque funciona

O estoque é sempre guardado em **unidades**. Cada produto tem "unidades por caixa", então o sistema mostra tudo como `3 cx + 5 un`.

```
Cliente faz pedido  ──►  NOVO        (reserva o estoque: outro cliente não consegue pedir o mesmo produto)
Loja confirma       ──►  CONFIRMADO  (continua reservado)
Loja separa         ──►  SEPARADO    (SAÍDA do estoque: a baixa acontece aqui, quando sai da câmara)
Loja entrega        ──►  ENTREGUE
Cancelado           ──►  libera a reserva; se já tinha sido separado, faz o ESTORNO (volta ao estoque)
```

- **Físico**: o que está na câmara.
- **Reservado**: pedidos novos/confirmados ainda não separados.
- **Disponível** = físico − reservado. É o que o cliente consegue pedir.

Toda movimentação fica registrada no **Histórico** (data, tipo, quantidade, valor, saldo, destino/motivo, pedido/nota, usuário) e pode ser exportada para planilha. Lançamentos **nunca são editados nem apagados**: para corrigir, use **Estornar**, que lança o contrário pelo mesmo valor e guarda o motivo.

### Tipos de movimentação

A mercadoria que sai da câmara tem só quatro destinos: **venda B2B**, **transferência para uma loja**, **perda** ou **saída sem venda**. Além disso há os ajustes de inventário.

| Tipo | Quando acontece |
|---|---|
| Entrada | Mercadoria chegou (nota da franqueadora/fornecedor). Informe o **custo** por caixa ou por unidade. Custo zero (bonificação) só com observação. |
| Venda B2B | Automática quando o pedido é **separado**. Grava o custo (CMV) e a receita. |
| Transferência p/ loja | Saída para a **Loja 1 - Centro** ou a **Loja 2** (cadastre outras em Config.). Grava o preço de varejo do dia. |
| Perda | Exige o **motivo**: vencimento, avaria/embalagem, descongelamento, divergência no recebimento, furto/extravio ou outros (com observação). Motivos editáveis em Config. |
| Saída sem venda | Brinde, parceria/patrocínio, bonificação a cliente, amostra/degustação, doação, consumo interno ou outros (lista editável em Config.; alguns exigem observação). Cliente opcional. |
| Sobra / Divergência de inventário | Lançadas pela contagem. Divergência (faltou) aparece nos relatórios junto das perdas, com nome próprio. |
| Custo inicial | Dá valor a um produto que tem estoque mas não tem custo (ex.: dados de antes desta versão), sem mudar as unidades. |
| Estorno | Desfaz um lançamento, pelo mesmo valor. Venda só se desfaz cancelando o pedido. |

Saídas manuais acima de um valor (padrão R$ 200,00, ajustável em Config.) pedem observação.

## Como o valor do estoque é calculado

O sistema usa o **custo médio ponderado móvel**, o mais comum na contabilidade de comércio.

- Cada produto guarda **quantas unidades** tem e **quanto elas valem a custo** (em R$). O custo médio é sempre a divisão de um pelo outro. Exemplo: caixa de R$ 87,30 com 12 un. = R$ 7,275 por unidade.
- **Entrada:** soma as unidades e soma o valor da nota. Exemplo: 10 un a R$ 10,00 + 10 un a R$ 20,00 = 20 un valendo R$ 300,00 (médio R$ 15,00).
- **Qualquer saída** (venda, transferência, perda, sem venda, divergência): sai pelo custo médio do momento, arredondado ao centavo. 5 un do exemplo acima = R$ 75,00.
- **Saída que zera o produto** leva todo o valor que sobrou, para nunca ficar "centavo fantasma" em produto sem unidade.
- **Estorno** devolve exatamente o valor que saiu no lançamento original, mesmo que o custo médio já tenha mudado.
- **Sobra de inventário** entra pelo custo médio atual (ou, se o produto estiver zerado, pelo custo da última entrada).
- **Produto sem custo:** quem tinha estoque antes desta versão fica marcado "sem custo". Informe o custo em **Estoque → Informar custo inicial**, ou deixe para a próxima entrada: o custo da nota valoriza também o estoque antigo (na tela de entrada dá para informar outro custo). Até lá, os relatórios em R$ mostram esses produtos à parte, sem inventar valor.
- O sistema não aceita saldo negativo, nem em unidades nem em valor.
- Datas e meses seguem o horário de **Cuiabá (UTC−4)**, independente do servidor. A **venda é reconhecida quando a mercadoria sai da câmara** (separação), que é o mesmo momento da baixa no estoque.

## Relatórios

Em **Relatórios**, escolha o período (ou "Este mês", "Mês passado", "Este ano") e exporte para Excel ou CSV.

1. **Conciliação** (o mais importante): estoque inicial + entradas − vendas (a custo) − transferências − perdas − saídas sem venda ± ajustes = estoque final, em unidades e em R$, por produto e no total. Se não bater com a posição na data final, a diferença aparece **em vermelho**.
2. **Posição de estoque** em qualquer data: unidades (cx + un), custo médio, valor a custo, a preço B2B e a preço de varejo. Datas passadas são reconstruídas pelo histórico.
3. **Vendas B2B:** por cliente, produto e mês: receita, CMV, margem bruta em R$ e %. Cancelamentos descontam no mês do cancelamento.
4. **Perdas e divergências:** por motivo, produto e mês, em unidades e R$ a custo, e o % sobre as entradas do período.
5. **Transferências:** por loja, produto e mês, a custo e a preço de varejo.

O painel inicial mostra o estoque a custo (e a preço B2B), as vendas e a margem B2B do mês, as perdas do mês e um aviso quando há produto sem custo.

### Como conferir a conciliação

1. Abra **Relatórios → Conciliação** e clique em **Este ano** (ou escolha um período).
2. No quadro **Resumo**, a linha **Diferença** precisa ser **0 un** e **R$ 0,00**. Uma faixa verde confirma: "A conciliação fecha".
3. Para conferir com a câmara, abra **Posição de estoque** na data final: o total a custo é o mesmo "Estoque final" da conciliação.
4. Se aparecer algo em vermelho, exporte para Excel e me mande: cada linha mostra o produto e o tipo de movimentação.

## Fotos e Catálogo Oggi 2026

- Cada produto pode ter uma **foto** (Produtos → Editar → Adicionar foto). Ela aparece no catálogo do cliente. O navegador reduz a foto antes de enviar, e ela fica guardada no banco, então o backup leva as fotos junto.
- **Produtos → Catálogo Oggi 2026** cadastra os 90 produtos do catálogo, com foto, preço (B2B e varejo) e unidades por caixa. Quem já existe não é alterado. Os produtos entram sem código de barras: bipe na tela do produto ou preencha pela planilha.
- **Produtos → Unidades por caixa** muda a quantidade por caixa de uma linha inteira de uma vez (o preço da caixa calculado acompanha).
- No catálogo do cliente, produtos esgotados ficam escondidos, com um botão "Mostrar esgotados".
- **O cliente nunca vê a quantidade em estoque**, só "Disponível" ou "Esgotado". Na revisão do pedido, os itens que pedem mais do que temos ficam em vermelho e o pedido não é enviado até ele diminuir. O servidor confere de novo ao receber o pedido, e a recusa não informa números.
- **Excluir produto** (na tela do produto) só funciona para produto que nunca teve estoque nem pedido, porque o histórico é permanente. Para tirar do catálogo um produto que já teve movimentação, desmarque "Ativo".

## Leitor de código de barras

Qualquer leitor USB ou Bluetooth que funcione como teclado serve (os mais comuns são assim). Não precisa instalar nada.

- **Entrada / Saída**: clique no campo e bipe. O **código da caixa** (DUN-14) soma uma caixa inteira e o **código da unidade** (EAN) soma uma unidade. Também dá para digitar o nome do produto.
- **Código não cadastrado**: o sistema oferece cadastrar o produto na hora, já com o código preenchido.
- **Separação de pedido**: bipe os produtos do pedido. A tela mostra o que falta, avisa se passar da quantidade ou se o produto não é do pedido, e dá a baixa no final.
- **Inventário**: bipe/conte os produtos e clique em "Aplicar contagem". O sistema ajusta só os produtos contados.

Pelo celular também funciona: digite o código ou o nome do produto no campo.

---

## Testar de graça no seu computador (sem programar)

1. Instale o **Node.js** (versão LTS) em https://nodejs.org. É só clicar em Avançar até o fim.
2. Nesta página do GitHub, clique em **Code → Download ZIP** e extraia o arquivo (botão direito → *Extrair tudo*).
3. Dentro da pasta, dê dois cliques em **`Testar no Windows.bat`** (ou **`Testar no Mac.command`**).

Na primeira vez ele instala tudo e carrega **dados de teste**: o Catálogo Oggi 2026 com fotos, dois clientes, 45 dias de movimentações de todos os tipos (com custos) e **5 caixas de cada produto do catálogo**, para dar para comprar por caixa ou por unidade. Num banco de teste antigo, os produtos "(exemplo)" da primeira versão são removidos e as caixas de teste são lançadas uma única vez. Depois abre o painel no navegador e mostra o endereço para testar pelo celular, que precisa estar no mesmo Wi-Fi. Os dados de teste ficam na pasta `data` e não vão para o sistema publicado.

## Instalar e rodar no seu computador (para desenvolvedores)

Você precisa do [Node.js](https://nodejs.org) versão 20 ou superior.

```bash
npm install
npm start
```

Depois abra:
- Painel da loja: http://localhost:3000/admin. No **primeiro acesso** você cria o usuário administrador.
- Portal do cliente: http://localhost:3000/

Para testar com produtos e um cliente de exemplo:

```bash
npm run seed     # cria produtos fictícios "(exemplo)" e o cliente CNPJ 11.222.333/0001-81, senha cliente123
```

Testes automáticos: `npm test`.

### Variáveis de ambiente (opcionais)

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `DB_PATH` | `./data/oggi.db` (ou o Volume do Railway) | Onde fica o arquivo do banco de dados. No Render com disco: `/data/oggi.db` |
| `MODO_TESTE` | — | `sim` só mostra a faixa "Ambiente de teste" no topo. Não lança dados de exemplo (isso só no teste local). |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Ao iniciar, criam esse administrador ou redefinem a senha dele. Apague depois de usar. |

## Colocar no ar (link para os clientes)

**Os dados só ficam guardados se a hospedagem tiver disco permanente.** Sem disco, toda vez que o sistema
reinicia (no Render grátis isso acontece após 15 min sem acesso e a cada atualização) o banco volta ao início:
senhas, clientes, estoque e lançamentos se perdem. O painel mostra um aviso vermelho nesse caso.

### Render (o que está em uso)

1. No serviço, em **Settings → Instance Type**, troque **Free** por **Starter** (cerca de US$ 7/mês). O plano grátis não aceita disco.
2. Em **Disks → Add Disk**: nome `dados`, **Mount Path** `/data`, tamanho **1 GB** (cerca de US$ 0,25/mês).
3. Em **Environment**, crie a variável `DB_PATH` = `/data/oggi.db`. Apague `MODO_TESTE`, se existir.
4. Salve. Depois que atualizar, entre no painel e confira que o aviso vermelho sumiu.
5. Se usou `ADMIN_EMAIL`/`ADMIN_PASSWORD` para entrar, apague essas variáveis depois do primeiro acesso:
   enquanto existirem, a senha do administrador volta para a da variável a cada reinício.

Com disco, cada atualização deixa o sistema fora do ar por alguns segundos.

### Railway

1. Em railway.com, entre com a conta do GitHub. Clique em **New Project → Deploy from GitHub repo** e escolha este repositório.
2. Adicione um **Volume** (disco) ao serviço, com caminho `/data`. O sistema detecta o volume sozinho (`RAILWAY_VOLUME_MOUNT_PATH`) e salva o banco nele.
3. Em **Settings → Networking → Generate Domain**, gere o endereço público.
4. Abra `https://SEU-ENDERECO/admin` e crie o administrador. O primeiro a acessar cria o usuário, então faça isso logo depois de gerar o endereço.

Em qualquer hospedagem, toda vez que um código novo é enviado para o GitHub o sistema atualiza sozinho, e os dados no disco continuam lá.

### Backup

Em **Config. → Baixar backup** você baixa uma cópia completa do sistema. Faça isso toda semana. Para restaurar, substitua o arquivo do `DB_PATH` pelo backup.

## Importar produtos por planilha

Em **Produtos → Importar planilha → Baixe a planilha modelo (Excel)**. Preencha uma linha por produto e importe o próprio arquivo `.xlsx`. Também aceita `.csv`.

- A aba "Como preencher" explica cada coluna. Dica: com o cursor na célula `codigo_barras`, bipe o produto com o leitor.
- Produtos com o mesmo código de barras (ou SKU) são **atualizados**. Os outros são criados.
- A importação **não altera o estoque**. Para o estoque inicial, use Entrada ou Inventário.
- Se `preco_caixa` ficar vazio, o sistema usa preço da unidade × unidades por caixa.
- `preco_varejo` é o preço no balcão (opcional), usado para valorizar as transferências para as lojas.
- A planilha modelo vem com os produtos já cadastrados (inclusive os do catálogo, com o SKU `OG26-…`): preencha os códigos de barras e reimporte.

---

## Estrutura do código

```
server.js              inicia o servidor
src/db.js              banco de dados (esquema da versão 1)
src/migrations.js      atualizações do banco (versão em settings.schema_version; copia o banco antes)
src/inventory.js       regras de estoque: move() é a única função que altera estoque (custo médio, estorno…)
src/reports.js         relatórios (posição, conciliação, vendas, perdas, transferências)
src/time.js            fuso de Cuiabá (todas as consultas por data passam por aqui)
src/export.js          exportação de relatórios para .xlsx/.csv
src/catalog.js         carregador do Catálogo Oggi 2026 (catalog/oggi-2026.json + fotos)
src/app.js             rotas da API (cliente e painel)
src/auth.js            senhas e sessões
src/util.js            CNPJ, valores em R$, CSV
public/index.html      portal do cliente   (public/js/loja.js)
public/admin.html      painel da loja      (public/js/admin.js)
test/                  testes automáticos (npm test)
```

## Próximos passos possíveis

**Fase 2 (controle fino):** lote e validade com separação FEFO, preço por cliente e desconto por volume, pagamento dos pedidos e contas a receber, perfis de usuário (só o dono vê custo e margem), fechamento mensal, devolução de cliente B2B, saldo dentro das lojas, entrada direto pelo XML da nota fiscal.

**Fase 3 (análise):** giro e cobertura de estoque, curva ABC, sazonalidade e sugestão de compra, ranking de clientes, painel por loja (integração com o PDV), NF-e, WhatsApp e leitura pela câmera do celular.
