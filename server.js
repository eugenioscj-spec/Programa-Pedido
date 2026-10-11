'use strict';

const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');
const { hashPassword } = require('./src/auth');

const PORT = Number(process.env.PORT) || 3000;
const db = openDatabase();

// Cria o administrador a partir de variáveis de ambiente (recomendado ao publicar).
const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD && db.prepare('SELECT COUNT(*) n FROM admins').get().n === 0) {
  db.prepare('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)')
    .run(ADMIN_NAME || 'Administrador', ADMIN_EMAIL.trim(), hashPassword(ADMIN_PASSWORD));
  console.log(`Administrador ${ADMIN_EMAIL} criado.`);
}

const app = createApp(db);

app.listen(PORT, () => {
  console.log(`Oggi Pedidos B2B rodando em http://localhost:${PORT}`);
  console.log(`  Portal do cliente: http://localhost:${PORT}/`);
  console.log(`  Painel da loja:    http://localhost:${PORT}/admin`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
