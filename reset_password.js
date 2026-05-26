const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

async function resetPassword() {
    try {
        const password = 'admin123';
        const hashedPassword = await bcrypt.hash(password, 10);

        console.log(`Generated new hash for password: ${password}`);

        const client = await pool.connect();
        try {
            // Check if admin exists
            const checkRes = await client.query("SELECT * FROM staff WHERE username = 'admin'");

            if (checkRes.rows.length === 0) {
                console.log("Admin user not found. Creating one...");
                await client.query(
                    "INSERT INTO staff (username, password_hash, full_name, email, role, is_active) VALUES ($1, $2, $3, $4, $5, true)",
                    ['admin', hashedPassword, 'Administrator', 'admin@nelfund.edu', 'admin']
                );
                console.log("✓ Created new admin user.");
            } else {
                console.log("Admin user found. Updating password...");
                await client.query(
                    "UPDATE staff SET password_hash = $1 WHERE username = 'admin'",
                    [hashedPassword]
                );
                console.log("✓ Updated admin password.");
            }

        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Error:", err);
    } finally {
        await pool.end();
    }
}

resetPassword();
