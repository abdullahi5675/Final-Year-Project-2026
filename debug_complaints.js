const db = require('./config/database');

async function testComplaints() {
    try {
        console.log('--- Testing Database Connection ---');
        const [time] = await db.query('SELECT NOW()');
        console.log('DB Time:', time);

        console.log('\n--- Checking Tables ---');
        // Simple check if tables exist
        try {
            await db.query('SELECT count(*) FROM students');
            console.log('Students table: OK');
        } catch (e) {
            console.error('Students table ERROR:', e.message);
        }

        try {
            await db.query('SELECT count(*) FROM staff');
            console.log('Staff table: OK');
        } catch (e) {
            console.error('Staff table ERROR:', e.message);
        }

        try {
            await db.query('SELECT count(*) FROM complaints');
            console.log('Complaints table: OK');
        } catch (e) {
            console.error('Complaints table ERROR:', e.message);
        }

        console.log('\n--- Testing Staff Query ---');
        // This repeats the query used in the staff route
        try {
            const [complaints] = await db.query(
                `SELECT c.*, s.full_name, s.department 
                 FROM complaints c
                 JOIN students s ON c.reg_number = s.reg_number
                 ORDER BY c.created_at DESC LIMIT 5`
            );
            console.log('Staff View Complaints Query: OK', complaints);
        } catch (e) {
            console.error('Staff View Complaints Query ERROR:', e.message);
        }

    } catch (error) {
        console.error('CRITICAL ERROR:', error);
    } finally {
        if (db.pool) await db.pool.end();
    }
}

testComplaints();
