# Oggi Sorvetes · Pedidos B2B e Estoque

Sistema web para a loja receber **pedidos de clientes empresa (B2B)** por um link e **controlar o estoque da câmara fria**, com entrada e saída de tudo por **código de barras**.

| Link | Para quem | O que faz |
|---|---|---|
| `https://SEU-ENDERECO/` | Clientes B2B | Cadastro por CNPJ, catálogo, pedido por **caixa fechada ou unidade**, histórico, repetir pedido |
| `https://SEU-ENDERECO/admin` | Loja | Pedidos, separação com leitor, entrada de mercadoria, estoque, inventário, produtos, clientes |

---

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

Toda movimentação fica registrada no **Histórico** (data, tipo, quantidade, saldo, pedido/nota, usuário) e pode ser exportada para planilha.

### Tipos de movimentação

| Tipo | Quando usar |
|---|---|
| Entrada (recebimento) | Mercadoria chegou da franqueadora/fornecedor. Informe o nº da nota. |
| Saída (pedido) | Automática quando o pedido é separado. |
| Estorno (pedido) | Automático quando um pedido separado é cancelado. |
| Transferência p/ loja | Produtos que saem da câmara para o balcão da loja. |
| Perda / avaria | Produto danificado, vencido, descongelado. |
| Saída avulsa | Bonificação, amostra, venda fora do portal. |
| Ajuste / inventário | Contagem física: o sistema lança a diferença sozinho. |

## Leitor de código de barras

Qualquer leitor USB ou Bluetooth que funcione como teclado serve (os mais comuns são assim). Não precisa instalar nada.

- **Entrada / Saída**: clique no campo e bipe. O **código da caixa** (DUN-14) soma uma caixa inteira e o **código da unidade** (EAN) soma uma unidade. Também dá para digitar o nome do produto.
- **Código não cadastrado**: o sistema oferece cadastrar o produto na hora, já com o código preenchido.
- **Separação de pedido**: bipe os produtos do pedido. A tela mostra o que falta, avisa se passar da quantidade ou se o produto não é do pedido, e dá a baixa no final.
- **Inventário**: bipe/conte os produtos e clique em "Aplicar contagem". O sistema ajusta só os produtos contados.

Pelo celular também funciona: digite o código ou o nome do produto no campo.

---

## Instalar e rodar no seu computador

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
| `DB_PATH` | `./data/oggi.db` | Onde fica o arquivo do banco de dados |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Se definidas, criam o administrador ao iniciar (só quando ainda não existe nenhum) |

## Colocar no ar (link para os clientes)

O sistema é um único programa Node.js com banco **SQLite**, que é um arquivo só. Qualquer hospedagem que rode Node.js **com disco persistente** serve. Algumas opções:

1. **Railway** ou **Render** (mais simples, cerca de US$ 5–7/mês): conecte este repositório do GitHub, comando de início `npm start`. **Crie um volume/disco persistente** e aponte `DB_PATH` para ele (ex.: `/data/oggi.db`). Sem disco persistente, os dados se perdem a cada atualização.
2. **VPS** (Hostinger, DigitalOcean, Contabo, etc.): instale o Node, rode com `pm2 start server.js` e coloque um domínio com HTTPS (Caddy ou Nginx).

Depois de publicar:
1. Defina `ADMIN_EMAIL` e `ADMIN_PASSWORD` na hospedagem **antes** de publicar (recomendado). Se não definir, acesse `/admin` **imediatamente** e crie o administrador, porque o primeiro a acessar cria o usuário.
2. Em **Config.**, preencha o WhatsApp da loja, o pedido mínimo e o aviso do catálogo.
3. Cadastre os produtos (um a um ou **importando planilha** em Produtos → Importar planilha).
4. Lance o estoque inicial em **Entrada / Saída → Inventário** (ou Entrada).
5. Envie o link `https://SEU-ENDERECO/` para os clientes.

### Backup

Em **Config. → Baixar backup** você baixa uma cópia completa do sistema. Faça isso toda semana. Para restaurar, substitua o arquivo do `DB_PATH` pelo backup.

## Importar produtos por planilha

No Excel, monte uma planilha com estas colunas na primeira linha e salve como **CSV**:

```
codigo_barras;codigo_caixa;sku;nome;categoria;unidades_caixa;preco_unidade;preco_caixa;estoque_minimo;vende_unidade;vende_caixa
7891234567890;17891234567897;PIC01;Picolé Chocolate;Picolés;24;4,50;98,00;48;sim;sim
```

- Produtos com o mesmo código de barras (ou SKU) são **atualizados**. Os outros são criados.
- A importação **não altera o estoque**. Para o estoque inicial, use Entrada ou Inventário.
- Se `preco_caixa` ficar vazio, o sistema usa preço da unidade × unidades por caixa.

---

## Estrutura do código

```
server.js              inicia o servidor
src/db.js              banco de dados (tabelas)
src/inventory.js       regras de estoque e pedidos (reserva, baixa, estorno, inventário)
src/app.js             rotas da API (cliente e painel)
src/auth.js            senhas e sessões
src/util.js            CNPJ, valores em R$, CSV
public/index.html      portal do cliente   (public/js/loja.js)
public/admin.html      painel da loja      (public/js/admin.js)
test/                  testes automáticos
```

## Próximos passos possíveis

- Avisos automáticos por WhatsApp/e-mail (pedido novo, pedido confirmado)
- Tabela de preço por cliente / descontos por volume
- Controle de lote e validade
- Emissão de NF-e integrada (Bling, Tiny, Omie…)
- Integração com o PDV da loja para baixar as vendas do balcão
- Leitura de código de barras pela câmera do celular
- Fotos dos produtos no catálogo
