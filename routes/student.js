const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../config/database');
const { requireStudentAuth } = require('../middleware/auth');

// Configure multer for file upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/remita/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|pdf/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only PDF, JPG, JPEG, PNG files are allowed'));
    }
});

// Student dashboard
router.get('/dashboard', requireStudentAuth, async (req, res) => {
    console.log('=> [DASHBOARD] Accessing student dashboard...');
    const startTime = Date.now();
    try {
        const regNumber = req.session.student.reg_number;
        console.log('=> [DASHBOARD] Fetching data for student:', regNumber);

        // Check if student has existing refund request
        const dbStart = Date.now();
        const [requests] = await db.query(
            `SELECT rr.*, rd.amount_paid, rd.remita_number, bd.account_name, bd.account_number, bd.bank_name
             FROM refund_requests rr
             LEFT JOIN remita_documents rd ON rr.request_id = rd.request_id
             LEFT JOIN bank_details bd ON rr.request_id = bd.request_id
             WHERE rr.reg_number = $1`,
            [regNumber]
        );
        console.log(`=> [DASHBOARD] DB query took ${Date.now() - dbStart}ms. Requests found: ${requests.length}`);

        const existingRequest = requests.length > 0 ? requests[0] : null;

        const renderStart = Date.now();
        res.render('student-dashboard', {
            student: req.session.student,
            existingRequest
        });
        console.log(`=> [DASHBOARD] Render and response took ${Date.now() - renderStart}ms. Total route time: ${Date.now() - startTime}ms`);

    } catch (error) {
        console.error('❌ [DASHBOARD ERROR]:', error);
        res.send('An error occurred');
    }
});

// Refund request form
router.get('/refund-request', requireStudentAuth, async (req, res) => {
    try {
        const regNumber = req.session.student.reg_number;

        // Check if already has request
        const [requests] = await db.query(
            'SELECT * FROM refund_requests WHERE reg_number = $1',
            [regNumber]
        );

        if (requests.length > 0) {
            return res.redirect('/student/dashboard');
        }

        res.render('refund-request', {
            student: req.session.student,
            error: null
        });

    } catch (error) {
        console.error('Error:', error);
        res.redirect('/student/dashboard');
    }
});

// Submit refund request
router.post('/refund-request', requireStudentAuth, (req, res, next) => {
    // Handle multer errors explicitly so the browser always gets a response
    upload.single('remita_file')(req, res, (multerErr) => {
        if (multerErr) {
            return res.render('refund-request', {
                student: req.session.student,
                error: multerErr.message || 'File upload failed. Please try again.'
            });
        }
        handleRefundSubmit(req, res);
    });
});

async function handleRefundSubmit(req, res) {
    console.log('=> [SUBMIT] Starting refund request submission handling...');
    const startTime = Date.now();
    let connection = null;

    try {
        const dbConnStart = Date.now();
        connection = await db.getConnection();
        console.log(`=> [SUBMIT] DB connection acquired in ${Date.now() - dbConnStart}ms`);

        const txStart = Date.now();
        await connection.beginTransaction();
        console.log(`=> [SUBMIT] DB transaction started in ${Date.now() - txStart}ms`);

        const regNumber = req.session.student.reg_number;
        const { payment_type, amount_paid, account_name, account_number, bank_name } = req.body;
        const remita_number = (req.body.remita_number || '').replace(/[\s-]/g, '');

        // Validate file upload
        if (!req.file) {
            throw new Error('Please upload your Remita document.');
        }

        // Validate RRR (basic: must not be empty)
        if (!remita_number) {
            throw new Error('Please enter your Remita RRR number.');
        }

        // Validate amount
        const amountPaid = parseFloat(amount_paid);
        if (isNaN(amountPaid) || amountPaid <= 0) {
            throw new Error('Please enter a valid payment amount.');
        }

        // Create refund request
        const query1Start = Date.now();
        const [requestResult] = await connection.query(
            `INSERT INTO refund_requests (reg_number, paid_before_disbursement, refund_amount, payment_type, status, is_locked)
             VALUES ($1, true, $2, $3, 'pending', true) RETURNING request_id`,
            [regNumber, amountPaid, payment_type]
        );
        console.log(`=> [SUBMIT] Insert into refund_requests took ${Date.now() - query1Start}ms`);

        const requestId = requestResult.insertId;

        if (!requestId) {
            throw new Error('Failed to create refund request. Please try again.');
        }

        // Save remita document
        const query2Start = Date.now();
        const normalizedFilePath = req.file.path.replace(/\\/g, '/');
        await connection.query(
            `INSERT INTO remita_documents (request_id, file_name, file_path, amount_paid, remita_number, payment_date)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                requestId,
                req.file.filename,
                normalizedFilePath,
                amountPaid,
                remita_number,
                new Date().toISOString()
            ]
        );
        console.log(`=> [SUBMIT] Insert into remita_documents took ${Date.now() - query2Start}ms`);

        // Save bank details
        const query3Start = Date.now();
        await connection.query(
            `INSERT INTO bank_details (request_id, account_name, account_number, bank_name)
             VALUES ($1, $2, $3, $4)`,
            [requestId, account_name, account_number, bank_name]
        );
        console.log(`=> [SUBMIT] Insert into bank_details took ${Date.now() - query3Start}ms`);

        const commitStart = Date.now();
        await connection.commit();
        console.log(`=> [SUBMIT] Transaction commit took ${Date.now() - commitStart}ms. Total process time: ${Date.now() - startTime}ms`);
        console.log('✅ Refund request created successfully');

        // Return JSON so the AJAX client can navigate immediately
        return res.json({ success: true, redirect: '/student/dashboard' });

    } catch (error) {
        if (connection) {
            try { 
                const rollbackStart = Date.now();
                await connection.rollback(); 
                console.log(`=> [SUBMIT] Rollback took ${Date.now() - rollbackStart}ms`);
            } catch (rbErr) {
                console.error('Rollback error:', rbErr);
            }
        }
        console.error('❌ Submission error:', error);
        return res.json({ success: false, error: error.message });
    } finally {
        if (connection) {
            connection.release();
            console.log('=> [SUBMIT] DB connection released back to pool');
        }
    }
}

// Complaints page
router.get('/complaints', requireStudentAuth, async (req, res) => {
    try {
        const regNumber = req.session.student.reg_number;

        const [complaints] = await db.query(
            `SELECT * FROM complaints WHERE reg_number = $1 ORDER BY created_at DESC`,
            [regNumber]
        );

        res.render('student-complaints', {
            student: req.session.student,
            complaints,
            error: null,
            success: null
        });

    } catch (error) {
        console.error('Complaints error:', error);
        res.redirect('/student/dashboard');
    }
});

// Submit complaint
router.post('/complaints', requireStudentAuth, async (req, res) => {
    const regNumber = req.session.student.reg_number;

    try {
        const { subject, message } = req.body;

        await db.query(
            `INSERT INTO complaints (reg_number, subject, message) VALUES ($1, $2, $3)`,
            [regNumber, subject, message]
        );

        const [complaints] = await db.query(
            `SELECT * FROM complaints WHERE reg_number = $1 ORDER BY created_at DESC`,
            [regNumber]
        );

        return res.render('student-complaints', {
            student: req.session.student,
            complaints,
            error: null,
            success: 'Complaint submitted successfully'
        });

    } catch (error) {
        console.error('Complaint submission error:', error);

        // Safely try to reload complaints for the error view
        let complaints = [];
        try {
            const [rows] = await db.query(
                `SELECT * FROM complaints WHERE reg_number = $1 ORDER BY created_at DESC`,
                [regNumber]
            );
            complaints = rows;
        } catch (fetchErr) {
            console.error('Could not reload complaints after error:', fetchErr);
        }

        return res.render('student-complaints', {
            student: req.session.student,
            complaints,
            error: 'Failed to submit complaint. Please try again.',
            success: null
        });
    }
});

module.exports = router;