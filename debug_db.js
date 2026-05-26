const db = require('./config/database');

async function debugDb() {
    try {
        console.log('--- Checking complaints table ---');
        try {
            const [complaints] = await db.query("SELECT * FROM complaints LIMIT 1");
            console.log('Complaints table exists. Rows:', complaints);
        } catch (e) {
            console.error('Complaints table error:', e.message);
        }

        console.log('--- Checking students table ---');
        try {
            const [students] = await db.query("SELECT * FROM students LIMIT 1");
            console.log('Students table exists. Rows:', students);
        } catch (e) {
            console.error('Students table error:', e.message);
        }

        console.log('--- Checking staff table ---');
        try {
            const [staff] = await db.query("SELECT * FROM staff LIMIT 1");
            console.log('Staff table exists. Rows:', staff);
        } catch (e) {
            console.error('Staff table error:', e.message);
        }

    } catch (error) {
        console.error('General debug error:', error);
    } finally {
        if (db.pool) await db.pool.end();
    }
}

debugDb();
