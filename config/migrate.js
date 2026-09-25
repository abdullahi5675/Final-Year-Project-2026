const { pool } = require('./database');

/**
 * NELFUND Refund Portal — Fast Single-Query Auto Migration
 * Runs on every server start in a single DB network round-trip.
 * Uses CREATE TABLE IF NOT EXISTS and ON CONFLICT DO NOTHING.
 */

async function migrate() {
    const startTime = Date.now();
    const client = await pool.connect();
    try {
        console.log('⏳ Running database migration check...');

        const migrationSql = `
            BEGIN;

            -- 1. STAFF
            CREATE TABLE IF NOT EXISTS staff (
                staff_id       SERIAL PRIMARY KEY,
                username       VARCHAR(50)  UNIQUE NOT NULL,
                password_hash  VARCHAR(255) NOT NULL,
                full_name      VARCHAR(100) NOT NULL,
                email          VARCHAR(100),
                role           VARCHAR(20)  DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
                is_active      BOOLEAN      DEFAULT TRUE,
                created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                last_login     TIMESTAMP    NULL
            );

            -- 2. NELFUND APPROVED LISTS
            CREATE TABLE IF NOT EXISTS nelfund_approved_lists (
                list_id          SERIAL PRIMARY KEY,
                batch_reference  VARCHAR(100) NOT NULL,
                upload_date      DATE         NOT NULL,
                uploaded_by      INT          NOT NULL,
                total_students   INT          DEFAULT 0,
                file_path        VARCHAR(255),
                created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (uploaded_by) REFERENCES staff(staff_id)
            );

            -- 3. STUDENTS
            CREATE TABLE IF NOT EXISTS students (
                reg_number    VARCHAR(50)  PRIMARY KEY,
                full_name     VARCHAR(100) NOT NULL,
                department    VARCHAR(100),
                level         VARCHAR(20),
                list_id       INT          NOT NULL,
                password_hash VARCHAR(255) NULL,
                is_active     BOOLEAN      DEFAULT TRUE,
                date_added    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (list_id) REFERENCES nelfund_approved_lists(list_id)
            );

            -- 4. REFUND REQUESTS
            CREATE TABLE IF NOT EXISTS refund_requests (
                request_id               SERIAL PRIMARY KEY,
                reg_number               VARCHAR(50) NOT NULL,
                paid_before_disbursement BOOLEAN     DEFAULT TRUE,
                refund_amount            DECIMAL(10, 2),
                payment_type             VARCHAR(50) NOT NULL CHECK (payment_type IN ('first_installment', 'second_installment', 'full_payment')),
                status                   VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
                rejection_reason         TEXT,
                verified_by              INT,
                submitted_at             TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
                verified_at              TIMESTAMP   NULL,
                is_locked                BOOLEAN     DEFAULT FALSE,
                batch_id                 INT         NULL,
                FOREIGN KEY (reg_number)   REFERENCES students(reg_number),
                FOREIGN KEY (verified_by)  REFERENCES staff(staff_id)
            );

            -- 5. REMITA DOCUMENTS
            CREATE TABLE IF NOT EXISTS remita_documents (
                document_id   SERIAL PRIMARY KEY,
                request_id    INT          NOT NULL,
                file_name     VARCHAR(255) NOT NULL,
                file_path     VARCHAR(255) NOT NULL,
                amount_paid   DECIMAL(10, 2) NOT NULL,
                payment_date  DATE,
                remita_number VARCHAR(100),
                uploaded_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (request_id) REFERENCES refund_requests(request_id) ON DELETE CASCADE
            );

            -- 6. BANK DETAILS
            CREATE TABLE IF NOT EXISTS bank_details (
                bank_id        SERIAL PRIMARY KEY,
                request_id     INT          NOT NULL,
                account_name   VARCHAR(100) NOT NULL,
                account_number VARCHAR(20)  NOT NULL,
                bank_name      VARCHAR(100) NOT NULL,
                is_verified    BOOLEAN      DEFAULT FALSE,
                created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (request_id) REFERENCES refund_requests(request_id) ON DELETE CASCADE
            );

            -- 7. REFUND BATCHES
            CREATE TABLE IF NOT EXISTS refund_batches (
                batch_id       SERIAL PRIMARY KEY,
                batch_number   VARCHAR(50)    UNIQUE NOT NULL,
                student_count  INT            DEFAULT 0,
                total_amount   DECIMAL(12, 2) DEFAULT 0.00,
                created_date   DATE           NOT NULL,
                created_by     INT            NOT NULL,
                is_downloaded  BOOLEAN        DEFAULT FALSE,
                downloaded_at  TIMESTAMP      NULL,
                downloaded_by  INT,
                FOREIGN KEY (created_by)    REFERENCES staff(staff_id),
                FOREIGN KEY (downloaded_by) REFERENCES staff(staff_id)
            );

            -- 8. BATCH FILES
            CREATE TABLE IF NOT EXISTS batch_files (
                file_id      SERIAL PRIMARY KEY,
                batch_id     INT          NOT NULL,
                file_name    VARCHAR(255) NOT NULL,
                file_path    VARCHAR(255) NOT NULL,
                generated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (batch_id) REFERENCES refund_batches(batch_id)
            );

            -- 9. COMPLAINTS
            CREATE TABLE IF NOT EXISTS complaints (
                complaint_id SERIAL PRIMARY KEY,
                reg_number   VARCHAR(50)  NOT NULL,
                subject      VARCHAR(255) NOT NULL,
                message      TEXT         NOT NULL,
                status       VARCHAR(20)  DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
                reply        TEXT,
                replied_by   INT,
                created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                replied_at   TIMESTAMP,
                FOREIGN KEY (reg_number) REFERENCES students(reg_number),
                FOREIGN KEY (replied_by) REFERENCES staff(staff_id)
            );

            -- 10. ACTIVITY LOGS
            CREATE TABLE IF NOT EXISTS activity_logs (
                log_id       SERIAL PRIMARY KEY,
                staff_id     INT REFERENCES staff(staff_id) ON DELETE SET NULL,
                reg_number   VARCHAR(50)  NULL,
                actor_type   VARCHAR(10)  DEFAULT 'staff',
                student_name VARCHAR(100) NULL,
                action       VARCHAR(100) NOT NULL,
                details      TEXT,
                ip_address   VARCHAR(45),
                created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS reg_number   VARCHAR(50)  NULL;
            ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS actor_type   VARCHAR(10)  DEFAULT 'staff';
            ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS student_name VARCHAR(100) NULL;

            ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NULL;

            -- 11. INDEXES
            CREATE INDEX IF NOT EXISTS idx_student_list     ON students(list_id);
            CREATE INDEX IF NOT EXISTS idx_request_status   ON refund_requests(status);
            CREATE INDEX IF NOT EXISTS idx_request_reg      ON refund_requests(reg_number);
            CREATE INDEX IF NOT EXISTS idx_activity_staff   ON activity_logs(staff_id);
            CREATE INDEX IF NOT EXISTS idx_activity_student ON activity_logs(reg_number);

            -- 12. DEFAULT STAFF SEEDS
            INSERT INTO staff (username, password_hash, full_name, email, role)
            VALUES (
                'admin',
                '$2b$10$xioyJLjrvB245pWbJgC3Qu7qQo1t3q2vm0jaOllZUZqggA4ZxZddm',
                'Administrator',
                'admin@nelfund.edu',
                'admin'
            ) ON CONFLICT (username) DO NOTHING;

            INSERT INTO staff (username, password_hash, full_name, email, role)
            VALUES (
                'staff1',
                '$2b$10$Yx.jJzLPNeWSfFcsEkV6uOO9EkmSaMyDE0MqB/M1Bbsc1yZMpqZxi',
                'Staff Member',
                'staff@nelfund.edu',
                'staff'
            ) ON CONFLICT (username) DO NOTHING;

            COMMIT;
        `;

        await client.query(migrationSql);
        const duration = Date.now() - startTime;
        console.log(`⚡ Database migration ready (${duration}ms).`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('✗ Migration failed:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

module.exports = migrate;

if (require.main === module) {
    migrate()
        .then(() => {
            console.log('✓ Migration finished successfully.');
            process.exit(0);
        })
        .catch((err) => {
            console.error('✗ Migration error:', err.message);
            process.exit(1);
        });
}
