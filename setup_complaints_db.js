const db = require('./config/database');

async function createTable() {
    try {
        console.log('Creating complaints table...');

        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS complaints (
                complaint_id SERIAL PRIMARY KEY,
                reg_number VARCHAR(50) NOT NULL,
                subject VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
                reply TEXT,
                replied_by INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                replied_at TIMESTAMP,
                FOREIGN KEY (reg_number) REFERENCES students(reg_number),
                FOREIGN KEY (replied_by) REFERENCES staff(staff_id)
            );
        `;

        await db.query(createTableQuery);
        console.log('Successfully created complaints table.');
    } catch (error) {
        console.error('Error creating table:', error);
    } finally {
        await db.pool.end();
    }
}

createTable();
