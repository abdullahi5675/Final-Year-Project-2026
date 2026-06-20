const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs').promises;
const db = require('../config/database');
const { requireStaffAuth } = require('../middleware/auth');

// Configure multer for CSV/Excel upload
const upload = multer({
    dest: 'uploads/nelfund-lists/',
    fileFilter: (req, file, cb) => {
        const filetypes = /csv|xlsx|xls/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (extname) {
            return cb(null, true);
        }
        cb(new Error('Only CSV and Excel files are allowed'));
    }
});

// Staff dashboard
router.get('/dashboard', requireStaffAuth, async (req, res) => {
    try {
        // Get statistics
        const [pendingCount] = await db.query(
            `SELECT COUNT(*) as count FROM refund_requests WHERE status = 'pending'`
        );

        const [approvedCount] = await db.query(
            `SELECT COUNT(*) as count FROM refund_requests WHERE status = 'approved' AND batch_id IS NULL`
        );

        const [totalStudents] = await db.query(
            'SELECT COUNT(*) as count FROM students WHERE is_active = true'
        );

        const [totalRequests] = await db.query(
            'SELECT COUNT(*) as count FROM refund_requests'
        );

        const [rejectedCount] = await db.query(
            `SELECT COUNT(*) as count FROM refund_requests WHERE status = 'rejected'`
        );

        res.render('staff-dashboard', {
            staff: req.session.staff,
            stats: {
                pending: pendingCount[0].count,
                approved: approvedCount[0].count,
                totalStudents: totalStudents[0].count,
                totalRequests: totalRequests[0].count,
                rejected: rejectedCount[0].count
            }
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.send('An error occurred');
    }
});

// Upload NELFUND list page
router.get('/upload-list', requireStaffAuth, (req, res) => {
    res.render('upload-list', { staff: req.session.staff, error: null, success: null });
});

// Upload NELFUND list POST
router.post('/upload-list', requireStaffAuth, upload.single('nelfund_file'), async (req, res) => {
    let connection = null;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        if (!req.file) {
            throw new Error('Please select a file to upload');
        }

        const { batch_reference } = req.body;
        const staffId = req.session.staff.staff_id;

        // Read Excel file
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const worksheet = workbook.worksheets[0];

        // Create NELFUND list record
        const [listResult] = await connection.query(
            `INSERT INTO nelfund_approved_lists (batch_reference, upload_date, uploaded_by, file_path)
             VALUES ($1, CURRENT_DATE, $2, $3) RETURNING list_id`,
            [batch_reference, staffId, req.file.path]
        );

        const listId = listResult.insertId;
        let studentCount = 0;

        for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const regNumber = row.getCell(1).value;
            const fullName = row.getCell(2).value;
            const department = row.getCell(3).value;
            const level = row.getCell(4).value;

            if (regNumber && fullName) {
                await connection.query(
                    `INSERT INTO students (reg_number, full_name, department, level, list_id) 
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (reg_number) DO UPDATE 
                     SET full_name = EXCLUDED.full_name,
                         department = EXCLUDED.department,
                         level = EXCLUDED.level,
                         list_id = EXCLUDED.list_id`,
                    [regNumber, fullName, department, level, listId]
                );
                studentCount++;
            }
        }

        await connection.query(
            'UPDATE nelfund_approved_lists SET total_students = $1 WHERE list_id = $2',
            [studentCount, listId]
        );

        await connection.commit();

        res.render('upload-list', {
            staff: req.session.staff,
            error: null,
            success: `Successfully uploaded ${studentCount} students`
        });

    } catch (error) {
        if (connection) {
            try { await connection.rollback(); } catch (rbErr) { console.error('Rollback error:', rbErr); }
        }
        console.error('Upload error:', error);
        res.render('upload-list', {
            staff: req.session.staff,
            error: error.message,
            success: null
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// View pending requests
router.get('/pending-requests', requireStaffAuth, async (req, res) => {
    try {
        const [requests] = await db.query(
            `SELECT rr.*, s.full_name, s.department, rd.file_path, rd.amount_paid, rd.remita_number,
                    bd.account_name, bd.account_number, bd.bank_name
             FROM refund_requests rr
             JOIN students s ON rr.reg_number = s.reg_number
             LEFT JOIN remita_documents rd ON rr.request_id = rd.request_id
             LEFT JOIN bank_details bd ON rr.request_id = bd.request_id
             WHERE rr.status = 'pending'
             ORDER BY rr.submitted_at DESC`
        );

        res.render('pending-requests', {
            staff: req.session.staff,
            requests
        });

    } catch (error) {
        console.error('Error:', error);
        res.send('An error occurred');
    }
});

// Approve/Reject request
router.post('/verify-request/:requestId', requireStaffAuth, async (req, res) => {
    try {
        const { requestId } = req.params;
        const { action, rejection_reason } = req.body;
        const staffId = req.session.staff.staff_id;

        if (action === 'approve') {
            await db.query(
                `UPDATE refund_requests 
                 SET status = 'approved', verified_by = $1, verified_at = NOW()
                 WHERE request_id = $2`,
                [staffId, requestId]
            );
        } else if (action === 'reject') {
            await db.query(
                `UPDATE refund_requests 
                 SET status = 'rejected', verified_by = $1, verified_at = NOW(), rejection_reason = $2
                 WHERE request_id = $3`,
                [staffId, rejection_reason, requestId]
            );
        }

        res.redirect('/staff/pending-requests');

    } catch (error) {
        console.error('Verification error:', error);
        res.send('An error occurred');
    }
});

// Generate batch
router.get('/generate-batch', requireStaffAuth, async (req, res) => {
    let connection = null;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const staffId = req.session.staff.staff_id;
        const batchSize = parseInt(process.env.BATCH_SIZE) || 100;

        // Get approved requests without batch
        const [requests] = await connection.query(
            `SELECT rr.*, s.full_name, s.department, bd.account_name, bd.account_number, bd.bank_name
             FROM refund_requests rr
             JOIN students s ON rr.reg_number = s.reg_number
             JOIN bank_details bd ON rr.request_id = bd.request_id
             WHERE rr.status = 'approved' AND rr.batch_id IS NULL
             LIMIT $1`,
            [batchSize]
        );

        if (requests.length === 0) {
            await connection.rollback();
            return res.send('No approved requests to batch');
        }

        // Create batch
        const batchNumber = 'BATCH-' + Date.now();
        const totalAmount = requests.reduce((sum, r) => sum + parseFloat(r.refund_amount), 0);

        const [batchResult] = await connection.query(
            `INSERT INTO refund_batches (batch_number, student_count, total_amount, created_date, created_by)
             VALUES ($1, $2, $3, CURRENT_DATE, $4) RETURNING batch_id`,
            [batchNumber, requests.length, totalAmount, staffId]
        );

        const batchId = batchResult.insertId;

        // Update requests with batch_id
        const requestIds = requests.map(r => r.request_id);
        await connection.query(
            `UPDATE refund_requests SET batch_id = $1 WHERE request_id = ANY($2::int[])`,
            [batchId, requestIds]
        );

        // Generate Excel file
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Refund List');

        worksheet.columns = [
            { header: 'S/N', key: 'sn', width: 10 },
            { header: 'Reg Number', key: 'reg_number', width: 20 },
            { header: 'Full Name', key: 'full_name', width: 30 },
            { header: 'Department', key: 'department', width: 25 },
            { header: 'Account Name', key: 'account_name', width: 30 },
            { header: 'Account Number', key: 'account_number', width: 20 },
            { header: 'Bank Name', key: 'bank_name', width: 25 },
            { header: 'Amount', key: 'amount', width: 15 }
        ];

        requests.forEach((request, index) => {
            worksheet.addRow({
                sn: index + 1,
                reg_number: request.reg_number,
                full_name: request.full_name,
                department: request.department,
                account_name: request.account_name,
                account_number: request.account_number,
                bank_name: request.bank_name,
                amount: request.refund_amount
            });
        });

        const fileName = `${batchNumber}.xlsx`;
        const filePath = `batches/${fileName}`;

        await workbook.xlsx.writeFile(filePath);

        // Save batch file record
        await connection.query(
            `INSERT INTO batch_files (batch_id, file_name, file_path)
             VALUES ($1, $2, $3)`,
            [batchId, fileName, filePath]
        );

        await connection.commit();

        res.download(filePath, fileName);

    } catch (error) {
        if (connection) {
            try { await connection.rollback(); } catch (rbErr) { console.error('Rollback error:', rbErr); }
        }
        console.error('Batch generation error:', error);
        res.send('An error occurred while generating batch');
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// View all complaints
router.get('/complaints', requireStaffAuth, async (req, res) => {
    try {
        const [complaints] = await db.query(
            `SELECT c.*, s.full_name, s.department 
             FROM complaints c
             JOIN students s ON c.reg_number = s.reg_number
             ORDER BY c.created_at DESC`
        );

        res.render('staff-complaints', {
            staff: req.session.staff,
            complaints
        });

    } catch (error) {
        console.error('Complaints list error:', error);
        res.send('An error occurred');
    }
});

// View single complaint
router.get('/complaints/:id', requireStaffAuth, async (req, res) => {
    try {
        const complaintId = req.params.id;

        const [results] = await db.query(
            `SELECT c.*, s.full_name, s.department, s.level, st.full_name as staff_name
             FROM complaints c
             JOIN students s ON c.reg_number = s.reg_number
             LEFT JOIN staff st ON c.replied_by = st.staff_id
             WHERE c.complaint_id = $1`,
            [complaintId]
        );

        if (results.length === 0) {
            return res.status(404).send('Complaint not found');
        }

        res.render('staff-complaint-detail', {
            staff: req.session.staff,
            complaint: results[0]
        });

    } catch (error) {
        console.error('Complaint detail error:', error);
        res.send('An error occurred');
    }
});

// Reply to complaint
router.post('/complaints/:id/reply', requireStaffAuth, async (req, res) => {
    try {
        const complaintId = req.params.id;
        const staffId = req.session.staff.staff_id;
        const { reply } = req.body;

        await db.query(
            `UPDATE complaints 
             SET reply = $1, replied_by = $2, replied_at = NOW(), status = 'answered'
             WHERE complaint_id = $3`,
            [reply, staffId, complaintId]
        );

        res.redirect(`/staff/complaints/${complaintId}`);

    } catch (error) {
        console.error('Reply error:', error);
        res.send('An error occurred');
    }
});

// View rejected requests
router.get('/rejected-requests', requireStaffAuth, async (req, res) => {
    try {
        const [requests] = await db.query(
            `SELECT rr.*, s.full_name, s.department, s.level,
                    st.full_name AS rejected_by_name
             FROM refund_requests rr
             JOIN students s ON rr.reg_number = s.reg_number
             LEFT JOIN staff st ON rr.verified_by = st.staff_id
             WHERE rr.status = 'rejected'
             ORDER BY rr.verified_at DESC`
        );

        res.render('rejected-requests', {
            staff: req.session.staff,
            requests
        });

    } catch (error) {
        console.error('Rejected requests error:', error);
        res.send('An error occurred');
    }
});

// Export rejected requests as Excel
router.get('/rejected-requests/export', requireStaffAuth, async (req, res) => {
    try {
        const [requests] = await db.query(
            `SELECT rr.reg_number, s.full_name, s.department, s.level,
                    rr.payment_type, rr.refund_amount, rr.rejection_reason,
                    st.full_name AS rejected_by_name, rr.verified_at
             FROM refund_requests rr
             JOIN students s ON rr.reg_number = s.reg_number
             LEFT JOIN staff st ON rr.verified_by = st.staff_id
             WHERE rr.status = 'rejected'
             ORDER BY rr.verified_at DESC`
        );

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'FUTB NELFUND Refund Portal';
        workbook.created = new Date();

        const worksheet = workbook.addWorksheet('Rejected Requests');

        // Style the header row
        worksheet.columns = [
            { header: 'S/N',              key: 'sn',              width: 6  },
            { header: 'Reg Number',       key: 'reg_number',      width: 20 },
            { header: 'Full Name',        key: 'full_name',       width: 28 },
            { header: 'Department',       key: 'department',      width: 28 },
            { header: 'Level',            key: 'level',           width: 10 },
            { header: 'Payment Type',     key: 'payment_type',    width: 20 },
            { header: 'Amount (₦)',       key: 'refund_amount',   width: 16 },
            { header: 'Rejection Reason', key: 'rejection_reason',width: 40 },
            { header: 'Rejected By',      key: 'rejected_by',     width: 22 },
            { header: 'Date Rejected',    key: 'date_rejected',   width: 22 }
        ];

        // Style header
        worksheet.getRow(1).eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF152C5B' } };
            cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            cell.border = {
                top:    { style: 'thin', color: { argb: 'FFB0C4DE' } },
                bottom: { style: 'thin', color: { argb: 'FFB0C4DE' } },
                left:   { style: 'thin', color: { argb: 'FFB0C4DE' } },
                right:  { style: 'thin', color: { argb: 'FFB0C4DE' } }
            };
        });
        worksheet.getRow(1).height = 30;

        // Add data rows
        requests.forEach((r, i) => {
            const paymentLabel = r.payment_type === 'first_installment'  ? 'First Installment'
                               : r.payment_type === 'second_installment' ? 'Second Installment'
                               : 'Full Payment';

            const row = worksheet.addRow({
                sn:               i + 1,
                reg_number:       r.reg_number,
                full_name:        r.full_name,
                department:       r.department,
                level:            r.level,
                payment_type:     paymentLabel,
                refund_amount:    r.refund_amount ? parseFloat(r.refund_amount) : '',
                rejection_reason: r.rejection_reason || '',
                rejected_by:      r.rejected_by_name || 'N/A',
                date_rejected:    r.verified_at ? new Date(r.verified_at).toLocaleString('en-NG') : ''
            });

            // Zebra stripe
            if (i % 2 === 1) {
                row.eachCell((cell) => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
                });
            }

            // Format amount as currency
            row.getCell('refund_amount').numFmt = '₦#,##0.00';
            row.alignment = { wrapText: true, vertical: 'top' };
        });

        // Freeze top row
        worksheet.views = [{ state: 'frozen', ySplit: 1 }];

        // Set response headers and stream
        const fileName = `Rejected-Requests-${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).send('An error occurred while generating the export');
    }
});

module.exports = router;
