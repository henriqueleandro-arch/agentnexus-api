// db.js — TiDB connection pool with tenant isolation
const mysql = require("mysql2/promise");

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.TIDB_HOST,
      port: parseInt(process.env.TIDB_PORT, 10),
      user: process.env.TIDB_USER,
      password: process.env.TIDB_PASSWORD,
      ssl: { rejectUnauthorized: true },
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

/**
 * Execute a query scoped to a specific tenant database.
 * This is the core pattern: every request is tied to a tenant.
 */
async function tenantQuery(tenantId, sql, params = []) {
  if (!/^tenant_[a-z0-9_]+$/.test(tenantId)) {
    throw new Error("Invalid tenant ID");
  }
  const conn = await getPool().getConnection();
  try {
    await conn.query(`USE \`${tenantId}\``);
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

/**
 * Execute a query on the platform database (cross-tenant metadata).
 */
async function platformQuery(sql, params = []) {
  const conn = await getPool().getConnection();
  try {
    await conn.query("USE `platform`");
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

module.exports = { getPool, tenantQuery, platformQuery };
