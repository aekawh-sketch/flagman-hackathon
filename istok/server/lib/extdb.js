'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Заказы других ресторанов Флагмана, чьи сотрудники работают в этой панели.
//  У ИСТОК — по базе на точку (istok_kush, istok_kan), как было. Остальным —
//  одна база (DB_NAME_EXT, по умолчанию istok_ext) и в ней своя схема на точку
//  с теми же таблицами из schema.sql: касса, заказы, бухгалтерия и выгрузки
//  работают с ней без изменений. База и схема создаются при первом заказе.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DB = process.env.DB_NAME_EXT || 'istok_ext';
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

function makePool(database, extra = {}) {
  return new Pool({
    host:                    process.env.DB_HOST     || 'localhost',
    port:                    parseInt(process.env.DB_PORT || '5432'),
    user:                    process.env.DB_USER     || process.env.USER,
    password:                process.env.DB_PASSWORD || '',
    database,
    max:                     5,
    idleTimeoutMillis:       30000,
    connectionTimeoutMillis: 2000,
    ...extra,
  });
}

let dbReady = null;
/** База есть или создаём её (только если её нет: 3D000 — «база не существует»). */
function ensureDb() {
  if (!/^[a-z0-9_]+$/.test(DB)) return Promise.reject(new Error(`DB_NAME_EXT: «${DB}» — только латиница, цифры и _`));
  dbReady ||= (async () => {
    const probe = makePool(DB, { max: 1 });
    try {
      await probe.query('SELECT 1');
    } catch (e) {
      if (e.code !== '3D000') throw e;
      const admin = makePool('postgres', { max: 1 });
      try {
        await admin.query(`CREATE DATABASE ${DB}`);
        console.log(`✅ Создана база заказов других ресторанов: ${DB}`);
      } catch (e2) {
        if (e2.code !== '42P04') throw e2;   // уже создал параллельный запрос
      } finally {
        await admin.end();
      }
    } finally {
      await probe.end();
    }
  })().catch(e => { dbReady = null; throw e; });
  return dbReady;
}

const pools = new Map();   // точка → Promise<Pool>

/** Пул точки другого ресторана: search_path — её схема, таблицы созданы. */
function pool(loc) {
  if (!SLUG.test(loc)) return Promise.reject(new Error('Неверный код точки'));
  if (!pools.has(loc)) {
    pools.set(loc, (async () => {
      await ensureDb();
      const schema = 'loc_' + loc.replace(/-/g, '_');
      const p = makePool(DB, { options: `-c search_path=${schema}` });
      p.on('error', err => console.error(`❌ [${loc}] PostgreSQL:`, err.message));
      await p.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await p.query(SCHEMA_SQL);   // скрипт повторяемый: только дополняет схему
      return p;
    })().catch(e => { pools.delete(loc); throw e; }));
  }
  return pools.get(loc);
}

module.exports = { pool, DB };
