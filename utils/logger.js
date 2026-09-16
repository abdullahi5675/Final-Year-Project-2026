const db = require('../config/database');

/**
 * Log a staff / admin event into the activity_logs table.
 * @param {number|null} staffId   - ID of the performing staff / admin
 * @param {string}      action    - Action category e.g. 'LOGIN_SUCCESS', 'APPROVE_REFUND'
 * @param {string}      details   - Human-readable description of the event
 * @param {object|null} req       - Express request (used for client IP)
 */
async function logActivity(staffId, action, details, req = null) {
    try {
        const ipAddress = _getIp(req);
        await db.query(
            `INSERT INTO activity_logs (staff_id, reg_number, actor_type, action, details, ip_address)
             VALUES ($1, NULL, 'staff', $2, $3, $4)`,
            [staffId || null, action, details, ipAddress]
        );
    } catch (err) {
        console.error('Failed to log staff activity:', err.message);
    }
}

/**
 * Log a student action into the activity_logs table.
 * @param {string}      regNumber - Student registration number
 * @param {string}      fullName  - Student full name (for readable log entries)
 * @param {string}      action    - Action category e.g. 'STUDENT_LOGIN', 'REFUND_SUBMITTED'
 * @param {string}      details   - Human-readable description of the event
 * @param {object|null} req       - Express request (used for client IP)
 */
async function logStudentActivity(regNumber, fullName, action, details, req = null) {
    try {
        const ipAddress = _getIp(req);
        await db.query(
            `INSERT INTO activity_logs (staff_id, reg_number, actor_type, student_name, action, details, ip_address)
             VALUES (NULL, $1, 'student', $2, $3, $4, $5)`,
            [regNumber, fullName || regNumber, action, details, ipAddress]
        );
    } catch (err) {
        console.error('Failed to log student activity:', err.message);
    }
}

/** Extract client IP from an Express request object. */
function _getIp(req) {
    if (!req) return 'Unknown';
    return (
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        req.ip ||
        'Unknown'
    );
}

module.exports = { logActivity, logStudentActivity };
