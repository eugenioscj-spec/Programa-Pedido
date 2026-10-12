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

## Testar de graça no seu computador (sem programar)

1. Instale o **Node.js** (versão LTS) em https://nodejs.org. É só clicar em Avançar até o fim.
2. Nesta página do GitHub, clique em **Code → Download ZIP** e extraia o arquivo (botão direito → *Extrair tudo*).
3. Dentro da pasta, dê dois cliques em **`Testar no Windows.bat`** (ou **`Testar no Mac.command`**).

Na primeira vez ele instala tudo e carrega produtos e um cliente **de exemplo**. Depois abre o painel no navegador e mostra o endereço para testar pelo celular, que precisa estar no mesmo Wi-Fi. Os dados de teste ficam na pasta `data` e não vão para o sistema publicado.

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
| `DB_PATH` | `./data/oggi.db` (ou o Volume do Railway) | Onde fica o arquivo do banco de dados |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Ao iniciar, criam esse administrador ou redefinem a senha dele. Apague depois de usar. |

## Colocar no ar (link para os clientes)

O caminho recomendado é o **Railway** (cerca de US$ 5/mês). O projeto já vem configurado para ele (`railway.json`):

1. Em railway.com, entre com a conta do GitHub. Clique em **New Project → Deploy from GitHub repo** e escolha este repositório.
2. Adicione um **Volume** (disco) ao serviço, com caminho `/data`. O sistema detecta o volume sozinho (`RAILWAY_VOLUME_MOUNT_PATH`) e salva o banco nele. **Sem volume os dados se perdem**, e o painel mostra um aviso vermelho.
3. Em **Settings → Networking → Generate Domain**, gere o endereço público.
4. Abra `https://SEU-ENDERECO/admin` e crie o administrador. O primeiro a acessar cria o usuário, então faça isso logo depois de gerar o endereço.

Toda vez que um código novo for enviado para o GitHub, o Railway atualiza o sistema sozinho, e os dados no volume continuam lá.

**Esqueceu a senha do painel?** No Railway, em **Variables**, crie `ADMIN_EMAIL` (o seu e-mail de login) e `ADMIN_PASSWORD` (a nova senha). O sistema reinicia com a senha nova. Depois de entrar, apague as duas variáveis.

Outra opção é uma **VPS** (Hostinger, DigitalOcean, etc.): instale o Node 22, rode com `pm2 start server.js` e coloque um domínio com HTTPS.

### Backup

Em **Config. → Baixar backup** você baixa uma cópia completa do sistema. Faça isso toda semana. Para restaurar, substitua o arquivo do `DB_PATH` pelo backup.

## Importar produtos por planilha

Em **Produtos → Importar planilha → Baixe a planilha modelo (Excel)**. Preencha uma linha por produto e importe o próprio arquivo `.xlsx`. Também aceita `.csv`.

- A aba "Como preencher" explica cada coluna. Dica: com o cursor na célula `codigo_barras`, bipe o produto com o leitor.
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
