// Базы заказов сайта ИСТОК на VPS: создать, если их нет, и применить schema.sql — она повторяемая (IF NOT EXISTS),
// поэтому запускается при каждом старте контейнера перед server.js. База — тот же PostgreSQL, что у склада.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const conn = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};
const dbs = [process.env.DB_NAME_KUSH, process.env.DB_NAME_KAN];
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createDatabases() {
  const c = new Client({ ...conn, database: 'postgres' });
  await c.connect();
  try {
    for (const db of dbs) {
      if (!/^[a-z0-9_]+$/.test(db || '')) throw new Error(`Имя базы «${db}» — только латиница, цифры и _`);
      const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
      if (!rowCount) await c.query(`CREATE DATABASE ${db}`);
    }
  } finally {
    await c.end();
  }
}

(async () => {
  for (let attempt = 1; ; attempt++) {            // база могла ещё не принимать соединения
    try {
      await createDatabases();
      break;
    } catch (e) {
      if (attempt >= 30) throw e;
      await sleep(2000);
    }
  }
  for (const db of dbs) {
    const c = new Client({ ...conn, database: db });
    await c.connect();
    try {
      await c.query(schema);
    } finally {
      await c.end();
    }
  }
  console.log(`ИСТОК: базы заказов готовы (${dbs.join(', ')})`);
})().catch(e => {
  console.error('ИСТОК: базы заказов не подготовлены —', e.message);
  process.exit(1);
});
