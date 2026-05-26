const { Pool } = require('pg');
require('dotenv').config();

// Create connection pool
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 10000,
    query_timeout: 30000,
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
});

// Wrapper to mimic mysql2 promise interface [rows, fields]
const query = async (text, params) => {
    try {
        const result = await pool.query(text, params);
        return [result.rows, result.fields];
    } catch (error) {
        console.error('Database query error:', error);
        throw error;
    }
};

// Wrapper for checking connections (MySQL `getConnection` equivalent)
// PG pools handle connections automatically, but for transactions we need a client.
const getConnection = async () => {
    const client = await pool.connect();

    if (!client._isWrapped) {
        // Add wrapper to client too for transactions
        const originalQuery = client.query;
        const boundOriginalQuery = originalQuery.bind(client);
        const originalRelease = client.release;

        client.query = async (text, params) => {
            const result = await boundOriginalQuery(text, params);
            // If it's an INSERT/UPDATE, mysql2 returns an object with insertId/affectedRows in the first element.
            // PG returns a Result object. We need to map this.

            // For SELECT: return [rows, fields]
            if (text.trim().toLowerCase().startsWith('select')) {
                return [result.rows, result.fields];
            }

            // For INSERT/UPDATE/DELETE: return [infoObject, undefined]
            // MySQL2 'OkPacket' structure: { fieldCount, affectedRows, insertId, ... }
            const info = {
                affectedRows: result.rowCount,
                insertId: (result.rows && result.rows.length > 0) ? result.rows[0][Object.keys(result.rows[0])[0]] : null
            };
            return [info, null];
        };

        // Begin/Commit/Rollback wrappers
        client.beginTransaction = () => boundOriginalQuery('BEGIN');
        client.commit = () => boundOriginalQuery('COMMIT');
        client.rollback = () => boundOriginalQuery('ROLLBACK');

        // Override release to restore original unwrapped state
        client.release = function() {
            client.query = originalQuery;
            client.release = originalRelease;
            client._isWrapped = false;
            return originalRelease.apply(client, arguments);
        };

        client._isWrapped = true;
    }

    return client;
};

// Test connection with retry logic
async function testConnection(retries = 5, delay = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await pool.query('SELECT NOW()');
            console.log('✓ Database connected successfully to PostgreSQL');

            // Pre-warm the pool: create 3 idle connections so first requests are fast
            const warmClients = [];
            try {
                for (let i = 0; i < 3; i++) {
                    warmClients.push(await pool.connect());
                }
                console.log('✓ Connection pool pre-warmed (3 connections ready)');
            } catch (wErr) {
                console.warn('⚠ Pool pre-warm partial failure:', wErr.message);
            } finally {
                warmClients.forEach(c => c.release());
            }

            // Keep-alive: ping every 4 minutes so idle connections stay open
            setInterval(async () => {
                try { await pool.query('SELECT 1'); }
                catch (e) { console.warn('⚠ Keep-alive ping failed:', e.message); }
            }, 4 * 60 * 1000);

            return;
        } catch (err) {
            if (attempt < retries) {
                console.warn(`⚠ DB connection attempt ${attempt}/${retries} failed: ${err.message}. Retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error('✗ Could not connect to PostgreSQL after', retries, 'attempts:', err.message);
                console.error('  → Make sure PostgreSQL is running and your .env DB_* settings are correct.');
            }
        }
    }
}

testConnection();

module.exports = {
    query,
    getConnection,
    pool // export pool if needed
};
