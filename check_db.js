const db = require('./config/database');

async function checkTable() {
    try {
        console.log('Checking complaints table...');
        const [result] = await db.query("SELECT to_regclass('public.complaints')");
        console.log('Result:', result);
        if (result[0].to_regclass) {
            console.log('Table exists.');
        } else {
            console.log('Table does NOT exist.');
        }
        process.exit(0);
    } catch (error) {
        console.error('Error checking table:', error);
        process.exit(1);
    }
}
checkTable();
