const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');
const db = require('../config/database');
const { requireStaffAuth, requireAdminAuth } = require('../middleware/auth');
const { logActivity } = require('../utils/logger');

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

// Helper function to build staff data scope SQL condition
function getStaffScopeCondition(staff, studentAlias = 's', listAlias = 'nal') {
    if (staff.role === 'admin') {
        return { clause: '1=1', params: [] };
    }
    return {
        clause: `${listAlias}.uploaded_by = $1`,
        params: [staff.staff_id]
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// STAFF DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', requireStaffAuth, async (req, res) => {
    try {
        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';
        const staffId = staff.staff_id;

        let pendingQuery, approvedQuery, exportedQuery, totalStudentsQuery, totalRequestsQuery, rejectedQuery, complaintsQuery;
        let queryParams = [];

        if (isAdmin) {
            pendingQuery = `SELECT COUNT(*) as count FROM refund_requests WHERE status = 'pending'`;
            approvedQuery = `SELECT COUNT(*) as count FROM refund_requests WHERE status = 'approved' AND batch_id IS NULL`;
            exportedQuery = `SELECT COUNT(*) as count FROM refund_requests WHERE status = 'approved' AND batch_id IS NOT NULL`;
            rejectedQuery = `SELECT COUNT(*) as count FROM refund_requests WHERE status = 'rejected'`;
            totalStudentsQuery = `SELECT COUNT(*) as count FROM students WHERE is_active = true`;
            totalRequestsQuery = `SELECT COUNT(*) as count FROM refund_requests`;
            complaintsQuery = `SELECT COUNT(*) as count FROM complaints`;
        } else {
            queryParams = [staffId];
            pendingQuery = `
                SELECT COUNT(*) as count FROM refund_requests rr
                JOIN students s ON rr.reg_number = s.reg_number
                JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
                WHERE rr.status = 'pending' AND nal.uploaded_by = $1`;

            approvedQuery = `
                SELECT COUNT(*) as count FROM refund_requests rr
                JOIN students s ON rr.reg_number = s.reg_number
                JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
                WHERE rr.status = 'approved' AND rr.batch_id IS NULL AND nal.uploaded_by = $1`;

            exportedQuery = `
                SELECT COUNT(*) as count FROM refund_requests rr
                JOIN students s ON rr.reg_number = s.reg_number
                JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
                WHERE rr.status = 'approved' AND rr.batch_id IS NOT NULL AND nal.uploaded_by = $1`;

            rejectedQuery = `
                SELECT COUNT(*) as count FROM refund_requests rr
                JOIN students s ON rr.reg_number = s.reg_number
                JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
                WHERE rr.status = 'rejected' AND nal.uploaded_by = $1`;

            totalStudentsQuery = `
                SELECT COUNT(*) as count FROM students s
                JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
                WHERE s.is_active = true AND nal.uploaded_by = $1`;

            totalRequestsQuery = `
                SELECT COUNT(*) as count FROM refund_requests rr
                JOIN students s ON rr.reg_number = s.reg_number
                JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
                WHERE nal.uploaded_by = $1`;

            complaintsQuery = `
                SELECT COUNT(*) as count FROM complaints c
                JOIN students s ON c.reg_number = s.reg_number
                JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
                WHERE nal.uploaded_by = $1`;
        }

        const [pendingCount] = await db.query(pendingQuery, queryParams);
        const [approvedCount] = await db.query(approvedQuery, queryParams);
        const [exportedCount] = await db.query(exportedQuery, queryParams);
        const [rejectedCount] = await db.query(rejectedQuery, queryParams);
        const [totalStudents] = await db.query(totalStudentsQuery, queryParams);
        const [totalRequests] = await db.query(totalRequestsQuery, queryParams);
        const [totalComplaints] = await db.query(complaintsQuery, queryParams);

        const unbatchedApproved = parseInt(approvedCount[0].count) || 0;
        const exportedBursary = parseInt(exportedCount[0].count) || 0;
        const totalApproved = unbatchedApproved + exportedBursary;

        res.render('staff-dashboard', {
            staff,
            stats: {
                pending: parseInt(pendingCount[0].count) || 0,
                approved: unbatchedApproved,
                exported: exportedBursary,
                totalApproved: totalApproved,
                rejected: parseInt(rejectedCount[0].count) || 0,
                totalStudents: parseInt(totalStudents[0].count) || 0,
                totalRequests: parseInt(totalRequests[0].count) || 0,
                totalComplaints: parseInt(totalComplaints[0].count) || 0
            }
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.send('An error occurred loading the dashboard');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD NELFUND APPROVED LIST
// ─────────────────────────────────────────────────────────────────────────────
router.get('/upload-list', requireStaffAuth, (req, res) => {
    res.render('upload-list', { staff: req.session.staff, error: null, success: null, duplicateWarning: null });
});

router.post('/upload-list', requireStaffAuth, upload.single('nelfund_file'), async (req, res) => {
    let connection = null;
    let filePath = req.file ? req.file.path : (req.body ? req.body.temp_file_path : null);

    try {
        if (!filePath) {
            throw new Error('Please select a CSV or Excel file to upload');
        }

        const batch_reference = (req.body.batch_reference || '').trim();
        const confirm_overwrite = req.body.confirm_overwrite === 'true';
        const staffId = req.session.staff.staff_id;

        if (!batch_reference) {
            throw new Error('Batch reference / file identifier is required');
        }

        connection = await db.getConnection();

        // ── 1. Check if a batch with the same reference already exists in nelfund_approved_lists
        const [existingLists] = await connection.query(
            `SELECT nal.*, s.full_name as uploader_name, s.email as uploader_email, s.role as uploader_role
             FROM nelfund_approved_lists nal
             LEFT JOIN staff s ON nal.uploaded_by = s.staff_id
             WHERE LOWER(TRIM(nal.batch_reference)) = LOWER(TRIM($1))
             ORDER BY nal.list_id DESC
             LIMIT 1`,
            [batch_reference]
        );

        // Read Excel file
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const worksheet = workbook.worksheets[0];

        const regNumbers = [];
        for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const regNumber = row.getCell(1).value ? row.getCell(1).value.toString().trim() : null;
            if (regNumber) regNumbers.push(regNumber);
        }

        // ── 2. Check if students in this file already belong to an existing list
        let existingStudentBatch = null;
        if (regNumbers.length > 0) {
            const [overlapping] = await connection.query(
                `SELECT DISTINCT nal.list_id, nal.batch_reference, nal.upload_date, nal.uploaded_by,
                                 s.full_name as uploader_name, s.email as uploader_email, s.role as uploader_role
                 FROM students st
                 JOIN nelfund_approved_lists nal ON st.list_id = nal.list_id
                 LEFT JOIN staff s ON nal.uploaded_by = s.staff_id
                 WHERE st.reg_number = ANY($1)
                 LIMIT 1`,
                [regNumbers]
            );
            if (overlapping && overlapping.length > 0) {
                existingStudentBatch = overlapping[0];
            }
        }

        const targetDuplicate = (existingLists && existingLists.length > 0) ? existingLists[0] : existingStudentBatch;

        // If duplicate detected and user hasn't confirmed overwrite yet
        if (targetDuplicate && !confirm_overwrite) {
            return res.render('upload-list', {
                staff: req.session.staff,
                error: null,
                success: null,
                duplicateWarning: {
                    batchReference: batch_reference,
                    existingBatchRef: targetDuplicate.batch_reference,
                    uploaderName: targetDuplicate.uploader_name || 'System User',
                    uploaderRole: targetDuplicate.uploader_role ? targetDuplicate.uploader_role.toUpperCase() : 'STAFF',
                    uploaderEmail: targetDuplicate.uploader_email || '',
                    uploadDate: targetDuplicate.upload_date ? new Date(targetDuplicate.upload_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'recently',
                    totalStudents: targetDuplicate.total_students || regNumbers.length,
                    tempFilePath: filePath,
                    originalFileName: req.file ? req.file.originalname : 'NELFUND_List.xlsx'
                }
            });
        }

        // ── 3. Process Upload (new or confirmed overwrite)
        await connection.beginTransaction();

        let listId;
        let isUpdate = false;

        if (targetDuplicate) {
            listId = targetDuplicate.list_id;
            isUpdate = true;
            await connection.query(
                `UPDATE nelfund_approved_lists 
                 SET batch_reference = $1, upload_date = CURRENT_DATE, uploaded_by = $2, file_path = $3
                 WHERE list_id = $4`,
                [batch_reference, staffId, filePath, listId]
            );
        } else {
            const [listResult] = await connection.query(
                `INSERT INTO nelfund_approved_lists (batch_reference, upload_date, uploaded_by, file_path)
                 VALUES ($1, CURRENT_DATE, $2, $3) RETURNING list_id`,
                [batch_reference, staffId, filePath]
            );
            listId = listResult.insertId;
        }

        let studentCount = 0;

        for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const regNumber = row.getCell(1).value ? row.getCell(1).value.toString().trim() : null;
            const fullName = row.getCell(2).value ? row.getCell(2).value.toString().trim() : null;
            const department = row.getCell(3).value ? row.getCell(3).value.toString().trim() : '';
            const level = row.getCell(4).value ? row.getCell(4).value.toString().trim() : '';

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

        await logActivity(
            staffId,
            isUpdate ? 'NELFUND_UPLOAD_OVERWRITE' : 'NELFUND_UPLOAD',
            `${isUpdate ? 'Updated/Overwrote' : 'Uploaded'} NELFUND list batch '${batch_reference}' containing ${studentCount} students.`,
            req
        );

        res.render('upload-list', {
            staff: req.session.staff,
            error: null,
            duplicateWarning: null,
            success: `Successfully ${isUpdate ? 'updated and merged' : 'uploaded'} ${studentCount} student records for batch '${batch_reference}'!`
        });

    } catch (error) {
        if (connection) {
            try { await connection.rollback(); } catch (rbErr) { console.error('Rollback error:', rbErr); }
        }
        console.error('Upload error:', error);

        res.render('upload-list', {
            staff: req.session.staff,
            error: error.message,
            duplicateWarning: null,
            success: null
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PENDING REQUESTS (Scoped by staff upload)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending-requests', requireStaffAuth, async (req, res) => {
    try {
        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';

        let sql = `
            SELECT rr.*, s.full_name, s.department, rd.file_path, rd.amount_paid, rd.remita_number,
                   bd.account_name, bd.account_number, bd.bank_name, st.full_name as uploader_name
            FROM refund_requests rr
            JOIN students s ON rr.reg_number = s.reg_number
            JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
            LEFT JOIN staff st ON nal.uploaded_by = st.staff_id
            LEFT JOIN remita_documents rd ON rr.request_id = rd.request_id
            LEFT JOIN bank_details bd ON rr.request_id = bd.request_id
            WHERE rr.status = 'pending'
        `;

        const params = [];
        if (!isAdmin) {
            sql += ` AND nal.uploaded_by = $1`;
            params.push(staff.staff_id);
        }

        sql += ` ORDER BY rr.submitted_at DESC`;

        const [requests] = await db.query(sql, params);

        res.render('pending-requests', {
            staff,
            requests
        });

    } catch (error) {
        console.error('Pending requests error:', error);
        res.send('An error occurred fetching pending requests');
    }
});

// Approve / Reject request
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

            await logActivity(staffId, 'APPROVE_REFUND', `Approved refund request #${requestId}`, req);

        } else if (action === 'reject') {
            await db.query(
                `UPDATE refund_requests 
                 SET status = 'rejected', verified_by = $1, verified_at = NOW(), rejection_reason = $2
                 WHERE request_id = $3`,
                [staffId, rejection_reason, requestId]
            );

            await logActivity(staffId, 'REJECT_REFUND', `Rejected refund request #${requestId}. Reason: ${rejection_reason}`, req);
        }

        res.redirect('/staff/pending-requests');

    } catch (error) {
        console.error('Verification error:', error);
        res.send('An error occurred during verification');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// REJECTED REQUESTS (Scoped by staff upload)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/rejected-requests', requireStaffAuth, async (req, res) => {
    try {
        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';

        let sql = `
            SELECT rr.*, s.full_name, s.department, s.level,
                   st.full_name AS rejected_by_name, uploader.full_name AS uploader_name
            FROM refund_requests rr
            JOIN students s ON rr.reg_number = s.reg_number
            JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
            LEFT JOIN staff st ON rr.verified_by = st.staff_id
            LEFT JOIN staff uploader ON nal.uploaded_by = uploader.staff_id
            WHERE rr.status = 'rejected'
        `;

        const params = [];
        if (!isAdmin) {
            sql += ` AND nal.uploaded_by = $1`;
            params.push(staff.staff_id);
        }

        sql += ` ORDER BY rr.verified_at DESC`;

        const [requests] = await db.query(sql, params);

        res.render('rejected-requests', {
            staff,
            requests
        });

    } catch (error) {
        console.error('Rejected requests error:', error);
        res.send('An error occurred fetching rejected requests');
    }
});

// Export rejected requests to Excel
router.get('/rejected-requests/export', requireStaffAuth, async (req, res) => {
    try {
        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';

        let sql = `
            SELECT rr.reg_number, s.full_name, s.department, s.level,
                   rr.payment_type, rr.refund_amount, rr.rejection_reason,
                   st.full_name AS rejected_by_name, rr.verified_at
            FROM refund_requests rr
            JOIN students s ON rr.reg_number = s.reg_number
            JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
            LEFT JOIN staff st ON rr.verified_by = st.staff_id
            WHERE rr.status = 'rejected'
        `;

        const params = [];
        if (!isAdmin) {
            sql += ` AND nal.uploaded_by = $1`;
            params.push(staff.staff_id);
        }

        sql += ` ORDER BY rr.verified_at DESC`;

        const [requests] = await db.query(sql, params);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'FUTB NELFUND Refund Portal';
        workbook.created = new Date();

        const worksheet = workbook.addWorksheet('Rejected Requests');

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

        worksheet.getRow(1).eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF152C5B' } };
            cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        });
        worksheet.getRow(1).height = 30;

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

            if (i % 2 === 1) {
                row.eachCell((cell) => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
                });
            }

            row.getCell('refund_amount').numFmt = '₦#,##0.00';
            row.alignment = { wrapText: true, vertical: 'top' };
        });

        worksheet.views = [{ state: 'frozen', ySplit: 1 }];

        const fileName = `Rejected-Requests-${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).send('An error occurred while generating the export');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVED REQUESTS DIRECTORY & SEARCH (Scoped by staff upload)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/approved-requests', requireStaffAuth, async (req, res) => {
    try {
        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';
        const search = req.query.search ? req.query.search.trim() : '';
        const filter = req.query.filter ? req.query.filter.trim() : 'all';
        const notice = req.query.notice || null;

        let sql = `
            SELECT rr.*, s.full_name, s.department, s.level,
                   bd.account_name, bd.account_number, bd.bank_name,
                   rb.batch_number, rb.created_date as batch_date,
                   st.full_name AS verifier_name, uploader.full_name AS uploader_name
            FROM refund_requests rr
            JOIN students s ON rr.reg_number = s.reg_number
            JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
            LEFT JOIN bank_details bd ON rr.request_id = bd.request_id
            LEFT JOIN refund_batches rb ON rr.batch_id = rb.batch_id
            LEFT JOIN staff st ON rr.verified_by = st.staff_id
            LEFT JOIN staff uploader ON nal.uploaded_by = uploader.staff_id
            WHERE rr.status = 'approved'
        `;

        const params = [];

        if (!isAdmin) {
            params.push(staff.staff_id);
            sql += ` AND nal.uploaded_by = $${params.length}`;
        }

        if (search) {
            params.push(`%${search}%`);
            sql += ` AND (LOWER(rr.reg_number) LIKE LOWER($${params.length}) OR LOWER(s.full_name) LIKE LOWER($${params.length}))`;
        }

        if (filter === 'ready') {
            sql += ` AND rr.batch_id IS NULL`;
        } else if (filter === 'exported') {
            sql += ` AND rr.batch_id IS NOT NULL`;
        } else if (filter && !isNaN(filter)) {
            params.push(parseInt(filter));
            sql += ` AND rr.batch_id = $${params.length}`;
        }

        sql += ` ORDER BY rr.verified_at DESC NULLS LAST`;

        const [requests] = await db.query(sql, params);

        // Fetch distinct batches for dropdown filter
        const [batches] = await db.query(
            `SELECT batch_id, batch_number, student_count, total_amount, created_date
             FROM refund_batches ORDER BY batch_id DESC`
        );

        res.render('approved-requests', {
            staff,
            requests,
            batches,
            search,
            filter,
            notice
        });

    } catch (error) {
        console.error('Approved requests error:', error);
        res.send('An error occurred loading approved requests');
    }
});

// Export approved requests to Excel
router.get('/approved-requests/export', requireStaffAuth, async (req, res) => {
    try {
        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';
        const search = req.query.search ? req.query.search.trim() : '';
        const filter = req.query.filter ? req.query.filter.trim() : 'all';

        let sql = `
            SELECT rr.reg_number, s.full_name, s.department, s.level,
                   rr.payment_type, rr.refund_amount,
                   bd.account_name, bd.account_number, bd.bank_name,
                   rb.batch_number, rr.verified_at, st.full_name AS verifier_name
            FROM refund_requests rr
            JOIN students s ON rr.reg_number = s.reg_number
            JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
            LEFT JOIN bank_details bd ON rr.request_id = bd.request_id
            LEFT JOIN refund_batches rb ON rr.batch_id = rb.batch_id
            LEFT JOIN staff st ON rr.verified_by = st.staff_id
            WHERE rr.status = 'approved'
        `;

        const params = [];

        if (!isAdmin) {
            params.push(staff.staff_id);
            sql += ` AND nal.uploaded_by = $${params.length}`;
        }

        if (search) {
            params.push(`%${search}%`);
            sql += ` AND (LOWER(rr.reg_number) LIKE LOWER($${params.length}) OR LOWER(s.full_name) LIKE LOWER($${params.length}))`;
        }

        if (filter === 'ready') {
            sql += ` AND rr.batch_id IS NULL`;
        } else if (filter === 'exported') {
            sql += ` AND rr.batch_id IS NOT NULL`;
        } else if (filter && !isNaN(filter)) {
            params.push(parseInt(filter));
            sql += ` AND rr.batch_id = $${params.length}`;
        }

        sql += ` ORDER BY rr.verified_at DESC NULLS LAST`;

        const [requests] = await db.query(sql, params);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'FUTB NELFUND Refund Portal';
        workbook.created = new Date();

        const worksheet = workbook.addWorksheet('Approved Requests');

        worksheet.columns = [
            { header: 'S/N',            key: 'sn',            width: 6  },
            { header: 'Reg Number',     key: 'reg_number',    width: 20 },
            { header: 'Full Name',      key: 'full_name',     width: 28 },
            { header: 'Department',     key: 'department',    width: 25 },
            { header: 'Account Name',   key: 'account_name',  width: 28 },
            { header: 'Account Number', key: 'account_number',width: 20 },
            { header: 'Bank Name',      key: 'bank_name',     width: 22 },
            { header: 'Amount (₦)',     key: 'refund_amount', width: 16 },
            { header: 'Batch Schedule', key: 'batch_number',  width: 24 },
            { header: 'Date Approved',  key: 'date_approved', width: 22 }
        ];

        worksheet.getRow(1).eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF152C5B' } };
            cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        });

        requests.forEach((r, i) => {
            const row = worksheet.addRow({
                sn:             i + 1,
                reg_number:     r.reg_number,
                full_name:      r.full_name,
                department:     r.department,
                account_name:   r.account_name || 'N/A',
                account_number: r.account_number || 'N/A',
                bank_name:      r.bank_name || 'N/A',
                refund_amount:  r.refund_amount ? parseFloat(r.refund_amount) : 0,
                batch_number:   r.batch_number || 'Ready for Export (Unbatched)',
                date_approved:  r.verified_at ? new Date(r.verified_at).toLocaleString('en-NG') : 'N/A'
            });

            row.getCell('refund_amount').numFmt = '₦#,##0.00';
        });

        const fileName = `Approved-Requests-${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Approved export error:', error);
        res.status(500).send('Error exporting approved requests');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// BURSARY BATCH FILE GENERATION (Scoped by staff upload)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/generate-batch', requireStaffAuth, async (req, res) => {
    let connection = null;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';
        const staffId = staff.staff_id;
        const batchSize = parseInt(process.env.BATCH_SIZE) || 100;

        let sql = `
            SELECT rr.*, s.full_name, s.department, bd.account_name, bd.account_number, bd.bank_name
            FROM refund_requests rr
            JOIN students s ON rr.reg_number = s.reg_number
            JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
            JOIN bank_details bd ON rr.request_id = bd.request_id
            WHERE rr.status = 'approved' AND rr.batch_id IS NULL
        `;

        const params = [];
        if (!isAdmin) {
            sql += ` AND nal.uploaded_by = $1`;
            params.push(staffId);
        }

        sql += ` LIMIT $${params.length + 1}`;
        params.push(batchSize);

        const [requests] = await connection.query(sql, params);

        if (requests.length === 0) {
            await connection.rollback();
            return res.redirect('/staff/approved-requests?notice=no_unbatched');
        }

        const batchNumber = 'BATCH-' + Date.now();
        const totalAmount = requests.reduce((sum, r) => sum + parseFloat(r.refund_amount), 0);

        const [batchResult] = await connection.query(
            `INSERT INTO refund_batches (batch_number, student_count, total_amount, created_date, created_by)
             VALUES ($1, $2, $3, CURRENT_DATE, $4) RETURNING batch_id`,
            [batchNumber, requests.length, totalAmount, staffId]
        );

        const batchId = batchResult.insertId;

        const requestIds = requests.map(r => r.request_id);
        await connection.query(
            `UPDATE refund_requests SET batch_id = $1 WHERE request_id = ANY($2::int[])`,
            [batchId, requestIds]
        );

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Bursary Refund Schedule');

        worksheet.columns = [
            { header: 'S/N', key: 'sn', width: 10 },
            { header: 'Reg Number', key: 'reg_number', width: 20 },
            { header: 'Full Name', key: 'full_name', width: 30 },
            { header: 'Department', key: 'department', width: 25 },
            { header: 'Account Name', key: 'account_name', width: 30 },
            { header: 'Account Number', key: 'account_number', width: 20 },
            { header: 'Bank Name', key: 'bank_name', width: 25 },
            { header: 'Amount (₦)', key: 'amount', width: 18 }
        ];

        worksheet.getRow(1).eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF152C5B' } };
            cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        });

        requests.forEach((request, index) => {
            worksheet.addRow({
                sn: index + 1,
                reg_number: request.reg_number,
                full_name: request.full_name,
                department: request.department,
                account_name: request.account_name,
                account_number: request.account_number,
                bank_name: request.bank_name,
                amount: parseFloat(request.refund_amount)
            });
        });

        const fileName = `${batchNumber}.xlsx`;
        const filePath = `batches/${fileName}`;

        await workbook.xlsx.writeFile(filePath);

        await connection.query(
            `INSERT INTO batch_files (batch_id, file_name, file_path)
             VALUES ($1, $2, $3)`,
            [batchId, fileName, filePath]
        );

        await connection.commit();

        await logActivity(staffId, 'GENERATE_BURSARY_BATCH', `Generated Bursary batch file '${batchNumber}' containing ${requests.length} students (Total: ₦${totalAmount.toLocaleString()}).`, req);

        res.download(filePath, fileName);

    } catch (error) {
        if (connection) {
            try { await connection.rollback(); } catch (rbErr) { console.error('Rollback error:', rbErr); }
        }
        console.error('Batch generation error:', error);
        res.send('An error occurred while generating Bursary export file');
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPLAINTS (Scoped by staff upload)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/complaints', requireStaffAuth, async (req, res) => {
    try {
        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';

        let sql = `
            SELECT c.*, s.full_name, s.department, uploader.full_name as uploader_name
            FROM complaints c
            JOIN students s ON c.reg_number = s.reg_number
            JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
            LEFT JOIN staff uploader ON nal.uploaded_by = uploader.staff_id
        `;

        const params = [];
        if (!isAdmin) {
            sql += ` WHERE nal.uploaded_by = $1`;
            params.push(staff.staff_id);
        }

        sql += ` ORDER BY c.created_at DESC`;

        const [complaints] = await db.query(sql, params);

        res.render('staff-complaints', {
            staff,
            complaints
        });

    } catch (error) {
        console.error('Complaints list error:', error);
        res.send('An error occurred fetching complaints');
    }
});

router.get('/complaints/:id', requireStaffAuth, async (req, res) => {
    try {
        const complaintId = req.params.id;
        const staff = req.session.staff;
        const isAdmin = staff.role === 'admin';

        let sql = `
            SELECT c.*, s.full_name, s.department, s.level, st.full_name as staff_name
            FROM complaints c
            JOIN students s ON c.reg_number = s.reg_number
            JOIN nelfund_approved_lists nal ON s.list_id = nal.list_id
            LEFT JOIN staff st ON c.replied_by = st.staff_id
            WHERE c.complaint_id = $1
        `;

        const params = [complaintId];
        if (!isAdmin) {
            sql += ` AND nal.uploaded_by = $2`;
            params.push(staff.staff_id);
        }

        const [results] = await db.query(sql, params);

        if (results.length === 0) {
            return res.status(404).send('Complaint not found or unauthorized access');
        }

        res.render('staff-complaint-detail', {
            staff,
            complaint: results[0]
        });

    } catch (error) {
        console.error('Complaint detail error:', error);
        res.send('An error occurred fetching complaint details');
    }
});

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

        await logActivity(staffId, 'REPLY_COMPLAINT', `Replied to complaint #${complaintId}`, req);

        res.redirect(`/staff/complaints/${complaintId}`);

    } catch (error) {
        console.error('Reply error:', error);
        res.send('An error occurred saving reply');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ONLY: STAFF REGISTRATION & MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
router.get('/register', requireAdminAuth, (req, res) => {
    res.render('staff-register', { staff: req.session.staff, error: null, success: null });
});

router.post('/register', requireAdminAuth, async (req, res) => {
    const { full_name, username, email, password, role } = req.body;
    const adminId = req.session.staff.staff_id;

    try {
        if (!full_name || !username || !password) {
            return res.render('staff-register', {
                staff: req.session.staff,
                error: 'Full Name, Username, and Password are required fields.',
                success: null
            });
        }

        const [existing] = await db.query('SELECT staff_id FROM staff WHERE username = $1', [username]);
        if (existing.length > 0) {
            return res.render('staff-register', {
                staff: req.session.staff,
                error: `Username '${username}' is already taken. Please choose another.`,
                success: null
            });
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        const assignedRole = role === 'admin' ? 'admin' : 'staff';

        await db.query(
            `INSERT INTO staff (full_name, username, email, password_hash, role)
             VALUES ($1, $2, $3, $4, $5)`,
            [full_name, username, email || null, passwordHash, assignedRole]
        );

        await logActivity(adminId, 'REGISTER_STAFF', `Registered new ${assignedRole} account: ${username} (${full_name})`, req);

        res.render('staff-register', {
            staff: req.session.staff,
            error: null,
            success: `Staff account '${username}' created successfully as ${assignedRole.toUpperCase()}!`
        });

    } catch (error) {
        console.error('Staff registration error:', error);
        res.render('staff-register', {
            staff: req.session.staff,
            error: 'Database error creating staff account.',
            success: null
        });
    }
});

router.get('/manage', requireAdminAuth, async (req, res) => {
    try {
        const [staffMembers] = await db.query(
            `SELECT staff_id, username, full_name, email, role, is_active, created_at, last_login
             FROM staff
             ORDER BY created_at DESC`
        );

        res.render('staff-manage', {
            staff: req.session.staff,
            staffMembers,
            error: null,
            success: null
        });
    } catch (error) {
        console.error('Manage staff error:', error);
        res.send('An error occurred loading staff management');
    }
});

router.post('/toggle-status/:id', requireAdminAuth, async (req, res) => {
    const targetId = req.params.id;
    const adminId = req.session.staff.staff_id;

    try {
        if (parseInt(targetId) === adminId) {
            return res.status(400).send('You cannot deactivate your own admin account.');
        }

        await db.query(
            `UPDATE staff SET is_active = NOT is_active WHERE staff_id = $1`,
            [targetId]
        );

        await logActivity(adminId, 'TOGGLE_STAFF_STATUS', `Toggled account active status for staff ID #${targetId}`, req);

        res.redirect('/staff/manage');
    } catch (error) {
        console.error('Toggle status error:', error);
        res.send('Error updating staff status');
    }
});

router.post('/reset-password/:id', requireAdminAuth, async (req, res) => {
    const targetId = req.params.id;
    const { new_password } = req.body;
    const adminId = req.session.staff.staff_id;

    try {
        if (!new_password || new_password.trim().length < 6) {
            return res.status(400).send('Password must be at least 6 characters long.');
        }

        const passwordHash = await bcrypt.hash(new_password, 10);
        await db.query('UPDATE staff SET password_hash = $1 WHERE staff_id = $2', [passwordHash, targetId]);

        await logActivity(adminId, 'RESET_STAFF_PASSWORD', `Reset password for staff ID #${targetId}`, req);

        res.redirect('/staff/manage');
    } catch (error) {
        console.error('Reset staff password error:', error);
        res.send('Error resetting staff password');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ONLY: ACTIVITY LOGS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/activity-logs', requireAdminAuth, async (req, res) => {
    try {
        const [logs] = await db.query(
            `SELECT al.*,
                    st.username,
                    CASE
                        WHEN al.actor_type = 'student' THEN al.student_name
                        ELSE st.full_name
                    END AS full_name,
                    st.role
             FROM activity_logs al
             LEFT JOIN staff st ON al.staff_id = st.staff_id
             ORDER BY al.created_at DESC
             LIMIT 300`
        );

        res.render('activity-logs', {
            staff: req.session.staff,
            logs
        });
    } catch (error) {
        console.error('Activity log error:', error);
        res.send('An error occurred loading activity logs');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE MANAGEMENT (Staff & Admin)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/profile', requireStaffAuth, async (req, res) => {
    try {
        const staffId = req.session.staff.staff_id;
        const [results] = await db.query(
            `SELECT staff_id, username, full_name, email, role, is_active, created_at, last_login
             FROM staff WHERE staff_id = $1`,
            [staffId]
        );

        if (results.length === 0) {
            return res.status(404).send('Staff profile not found');
        }

        res.render('staff-profile', {
            staff: req.session.staff,
            profile: results[0],
            error: null,
            success: null
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.send('An error occurred loading profile');
    }
});

router.post('/profile/update', requireStaffAuth, async (req, res) => {
    const staffId = req.session.staff.staff_id;
    const { full_name, email } = req.body;

    try {
        await db.query(
            `UPDATE staff SET full_name = $1, email = $2 WHERE staff_id = $3`,
            [full_name, email || null, staffId]
        );

        req.session.staff.full_name = full_name;
        req.session.staff.email = email;

        await logActivity(staffId, 'UPDATE_PROFILE', `Updated profile details (Name: ${full_name}, Email: ${email})`, req);

        const [results] = await db.query(`SELECT * FROM staff WHERE staff_id = $1`, [staffId]);

        res.render('staff-profile', {
            staff: req.session.staff,
            profile: results[0],
            error: null,
            success: 'Profile updated successfully!'
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.send('Error updating profile');
    }
});

router.post('/profile/password', requireStaffAuth, async (req, res) => {
    const staffId = req.session.staff.staff_id;
    const { current_password, new_password, confirm_password } = req.body;

    try {
        const [results] = await db.query(`SELECT * FROM staff WHERE staff_id = $1`, [staffId]);
        const profile = results[0];

        if (new_password !== confirm_password) {
            return res.render('staff-profile', {
                staff: req.session.staff,
                profile,
                error: 'New passwords do not match.',
                success: null
            });
        }

        if (!new_password || new_password.length < 6) {
            return res.render('staff-profile', {
                staff: req.session.staff,
                profile,
                error: 'New password must be at least 6 characters long.',
                success: null
            });
        }

        const validCurrent = await bcrypt.compare(current_password, profile.password_hash);
        if (!validCurrent) {
            return res.render('staff-profile', {
                staff: req.session.staff,
                profile,
                error: 'Incorrect current password.',
                success: null
            });
        }

        const newHash = await bcrypt.hash(new_password, 10);
        await db.query(`UPDATE staff SET password_hash = $1 WHERE staff_id = $2`, [newHash, staffId]);

        await logActivity(staffId, 'CHANGE_PASSWORD', `User changed their password successfully`, req);

        res.render('staff-profile', {
            staff: req.session.staff,
            profile,
            error: null,
            success: 'Password changed successfully!'
        });

    } catch (error) {
        console.error('Password change error:', error);
        res.send('Error changing password');
    }
});

module.exports = router;
