const { pool } = require('./database');

/**
 * NELFUND Refund Portal — Auto Migration
 * Runs on every server start.
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to run repeatedly.
 * Default staff accounts are only inserted if they don't already exist.
 *
 * Staff Login Credentials (change passwords after first login!):
 *   Admin  → username: admin    password: admin123
 *   Staff  → username: staff1   password: staff123
 */

async function migrate() {
    const client = await pool.connect();
    try {
        console.log('⏳ Running database migrations...');

        await client.query('BEGIN');

        // ── 1. STAFF ──────────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS staff (
                staff_id       SERIAL PRIMARY KEY,
                username       VARCHAR(50)  UNIQUE NOT NULL,
                password_hash  VARCHAR(255) NOT NULL,
                full_name      VARCHAR(100) NOT NULL,
                email          VARCHAR(100),
                role           VARCHAR(20)  DEFAULT 'staff'
                               CHECK (role IN ('admin', 'staff')),
                is_active      BOOLEAN      DEFAULT TRUE,
                created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                last_login     TIMESTAMP    NULL
            );
        `);

        // ── 2. NELFUND APPROVED LISTS ─────────────────────────────────────────
        await client.query(`
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
        `);

        // ── 3. STUDENTS ───────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                reg_number  VARCHAR(50)  PRIMARY KEY,
                full_name   VARCHAR(100) NOT NULL,
                department  VARCHAR(100),
                level       VARCHAR(20),
                list_id     INT          NOT NULL,
                is_active   BOOLEAN      DEFAULT TRUE,
                date_added  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (list_id) REFERENCES nelfund_approved_lists(list_id)
            );
        `);

        // ── 4. REFUND REQUESTS ────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS refund_requests (
                request_id               SERIAL PRIMARY KEY,
                reg_number               VARCHAR(50) NOT NULL,
                paid_before_disbursement BOOLEAN     DEFAULT TRUE,
                refund_amount            DECIMAL(10, 2),
                payment_type             VARCHAR(50) NOT NULL
                                         CHECK (payment_type IN (
                                             'first_installment',
                                             'second_installment',
                                             'full_payment'
                                         )),
                status                   VARCHAR(20) DEFAULT 'pending'
                                         CHECK (status IN ('pending', 'approved', 'rejected')),
                rejection_reason         TEXT,
                verified_by              INT,
                submitted_at             TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
                verified_at              TIMESTAMP   NULL,
                is_locked                BOOLEAN     DEFAULT FALSE,
                batch_id                 INT         NULL,
                FOREIGN KEY (reg_number)   REFERENCES students(reg_number),
                FOREIGN KEY (verified_by)  REFERENCES staff(staff_id)
            );
        `);

        // ── 5. REMITA DOCUMENTS ───────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS remita_documents (
                document_id   SERIAL PRIMARY KEY,
                request_id    INT          NOT NULL,
                file_name     VARCHAR(255) NOT NULL,
                file_path     VARCHAR(255) NOT NULL,
                amount_paid   DECIMAL(10, 2) NOT NULL,
                payment_date  DATE,
                remita_number VARCHAR(100),
                uploaded_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (request_id) REFERENCES refund_requests(request_id)
                    ON DELETE CASCADE
            );
        `);

        // ── 6. BANK DETAILS ───────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS bank_details (
                bank_id        SERIAL PRIMARY KEY,
                request_id     INT          NOT NULL,
                account_name   VARCHAR(100) NOT NULL,
                account_number VARCHAR(20)  NOT NULL,
                bank_name      VARCHAR(100) NOT NULL,
                is_verified    BOOLEAN      DEFAULT FALSE,
                created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (request_id) REFERENCES refund_requests(request_id)
                    ON DELETE CASCADE
            );
        `);

        // ── 7. REFUND BATCHES ─────────────────────────────────────────────────
        await client.query(`
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
        `);

        // ── 8. BATCH FILES ────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS batch_files (
                file_id      SERIAL PRIMARY KEY,
                batch_id     INT          NOT NULL,
                file_name    VARCHAR(255) NOT NULL,
                file_path    VARCHAR(255) NOT NULL,
                generated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (batch_id) REFERENCES refund_batches(batch_id)
            );
        `);

        // ── 9. COMPLAINTS ─────────────────────────────────────────────────────
        await client.query(`
            CREATE TABLE IF NOT EXISTS complaints (
                complaint_id SERIAL PRIMARY KEY,
                reg_number   VARCHAR(50)  NOT NULL,
                subject      VARCHAR(255) NOT NULL,
                message      TEXT         NOT NULL,
                status       VARCHAR(20)  DEFAULT 'pending'
                             CHECK (status IN ('pending', 'answered')),
                reply        TEXT,
                replied_by   INT,
                created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                replied_at   TIMESTAMP,
                FOREIGN KEY (reg_number) REFERENCES students(reg_number),
                FOREIGN KEY (replied_by) REFERENCES staff(staff_id)
            );
        `);

        // ── 10. INDEXES (safe — ignored if already exist) ─────────────────────
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_student_list     ON students(list_id);
            CREATE INDEX IF NOT EXISTS idx_request_status   ON refund_requests(status);
            CREATE INDEX IF NOT EXISTS idx_request_reg      ON refund_requests(reg_number);
        `);

        await client.query('COMMIT');
        console.log('✓ All tables are ready.');

        // ── 11. SEED DEFAULT STAFF (only if not already present) ──────────────
        //
        //  Credentials:
        //    Admin  → username: admin    | password: admin123
        //    Staff  → username: staff1   | password: staff123
        //
        //  Hashes were generated with bcrypt (saltRounds = 10).
        //  Change passwords immediately after your first login!

        await pool.query(`
            INSERT INTO staff (username, password_hash, full_name, email, role)
            VALUES (
                'admin',
                '$2b$10$xioyJLjrvB245pWbJgC3Qu7qQo1t3q2vm0jaOllZUZqggA4ZxZddm',
                'Administrator',
                'admin@nelfund.edu',
                'admin'
            )
            ON CONFLICT (username) DO NOTHING;
        `);

        await pool.query(`
            INSERT INTO staff (username, password_hash, full_name, email, role)
            VALUES (
                'staff1',
                '$2b$10$Yx.jJzLPNeWSfFcsEkV6uOO9EkmSaMyDE0MqB/M1Bbsc1yZMpqZxi',
                'Staff Member',
                'staff@nelfund.edu',
                'staff'
            )
            ON CONFLICT (username) DO NOTHING;
        `);

        console.log('✓ Default staff credentials seeded (skipped if already exist).');
        console.log('  ┌─────────────────────────────────────────┐');
        console.log('  │  Login Credentials                      │');
        console.log('  │  Admin : username=admin  pw=admin123    │');
        console.log('  │  Staff : username=staff1 pw=staff123    │');
        console.log('  └─────────────────────────────────────────┘');

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('✗ Migration failed:', err.message);
        throw err;  // let server.js handle it
    } finally {
        client.release();
    }
}

module.exports = migrate;
