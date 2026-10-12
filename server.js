'use strict';

const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');
const { hashPassword } = require('./src/auth');

const PORT = Number(process.env.PORT) || 3000;
const db = openDatabase();

// ADMIN_EMAIL + ADMIN_PASSWORD (variáveis da hospedagem): cria esse administrador ou,
// se ele já existir, redefine a senha dele. Serve para o primeiro acesso e para
// recuperar a senha esquecida. Depois de entrar, apague as variáveis.
const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  const email = ADMIN_EMAIL.trim();
  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(ADMIN_PASSWORD), existing.id);
    db.prepare("DELETE FROM sessions WHERE user_type = 'admin' AND user_id = ?").run(existing.id);
    console.log(`Senha do administrador ${email} redefinida.`);
  } else {
    db.prepare('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)')
      .run(ADMIN_NAME || 'Administrador', email, hashPassword(ADMIN_PASSWORD));
    console.log(`Administrador ${email} criado.`);
  }
}

const app = createApp(db);

const server = app.listen(PORT, () => {
  console.log(`Oggi Pedidos B2B rodando em http://localhost:${PORT}`);
  console.log(`  Portal do cliente: http://localhost:${PORT}/`);
  console.log(`  Painel da loja:    http://localhost:${PORT}/admin`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nA porta ${PORT} já está em uso. O sistema provavelmente já está aberto em outra janela.`);
    process.exit(1);
  }
  throw err;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
