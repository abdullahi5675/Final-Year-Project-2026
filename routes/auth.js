const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/database');
const { redirectIfLoggedIn } = require('../middleware/auth');
const { logActivity, logStudentActivity } = require('../utils/logger');

// Home page (Landing page)
router.get('/', (req, res) => {
    res.render('home');
});

// Student login page
router.get('/student/login', redirectIfLoggedIn, (req, res) => {
    res.render('student-login', { error: null });
});

// Alias /login to student login
router.get('/login', redirectIfLoggedIn, (req, res) => {
    res.render('student-login', { error: null });
});

// Student login POST
router.post('/login', async (req, res) => {
    const { reg_number } = req.body;

    try {
        const [students] = await db.query(
            'SELECT * FROM students WHERE reg_number = $1 AND is_active = true',
            [reg_number]
        );

        if (students.length === 0) {
            // Log failed attempt (unknown reg number)
            await logStudentActivity(reg_number, reg_number, 'STUDENT_LOGIN_FAILED',
                `Login attempt with unrecognized registration number: ${reg_number}`, req);
            return res.render('student-login', {
                error: 'Registration number not found in NELFUND approved list'
            });
        }

        const student = students[0];

        // Set session
        req.session.student = {
            reg_number: student.reg_number,
            full_name: student.full_name,
            department: student.department,
            level: student.level
        };

        // Log successful login
        await logStudentActivity(
            student.reg_number,
            student.full_name,
            'STUDENT_LOGIN',
            `Student ${student.full_name} (${student.reg_number}) logged into the portal.`,
            req
        );

        res.redirect('/student/dashboard');

    } catch (error) {
        console.error('Login error:', error);
        res.render('student-login', { error: 'An error occurred. Please try again.' });
    }
});

// Staff login page
router.get('/staff/login', redirectIfLoggedIn, (req, res) => {
    res.render('staff-login', { error: null });
});

// Staff login POST
router.post('/staff/login', async (req, res) => {
    const loginIdentifier = req.body.email || req.body.username || req.body.identity;
    const { password } = req.body;

    try {
        const [staff] = await db.query(
            'SELECT * FROM staff WHERE (LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)) AND is_active = true',
            [loginIdentifier ? loginIdentifier.trim() : '']
        );

        if (staff.length === 0) {
            await logActivity(null, 'LOGIN_FAILED', `Failed login attempt for email/username: ${loginIdentifier}`, req);
            return res.render('staff-login', { error: 'Invalid email address or password' });
        }

        const staffMember = staff[0];

        // Verify password
        const validPassword = await bcrypt.compare(password, staffMember.password_hash);

        if (!validPassword) {
            await logActivity(staffMember.staff_id, 'LOGIN_FAILED', `Invalid password attempt for staff ID: ${staffMember.staff_id}`, req);
            return res.render('staff-login', { error: 'Invalid username or password' });
        }

        // Update last login
        await db.query('UPDATE staff SET last_login = NOW() WHERE staff_id = $1', [staffMember.staff_id]);

        // Set session
        req.session.staff = {
            staff_id: staffMember.staff_id,
            username: staffMember.username,
            full_name: staffMember.full_name,
            role: staffMember.role,
            email: staffMember.email
        };

        // Log successful login
        await logActivity(staffMember.staff_id, 'LOGIN_SUCCESS', `Staff member ${staffMember.username} (${staffMember.role}) logged in successfully.`, req);

        res.redirect('/staff/dashboard');

    } catch (error) {
        console.error('Staff login error:', error);
        res.render('staff-login', { error: 'An error occurred. Please try again.' });
    }
});

// ─── STEP 1: Verify staff email exists ───────────────────────────────────────
router.post('/staff/reset-verify-email', async (req, res) => {
    const { email } = req.body;

    if (!email || !email.trim()) {
        return res.json({ success: false, message: 'Email address is required.' });
    }

    try {
        const [rows] = await db.query(
            `SELECT staff_id, email, full_name, is_active
             FROM staff WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
            [email.trim()]
        );

        if (rows.length === 0) {
            return res.json({ success: false, message: 'No staff account found with that email address. Please check and try again.' });
        }

        if (!rows[0].is_active) {
            return res.json({ success: false, message: 'This account has been deactivated. Please contact the administrator.' });
        }

        // Email verified — store it in session temporarily so STEP 2 can use it securely
        req.session.resetEmail = email.trim().toLowerCase();

        return res.json({ success: true });

    } catch (error) {
        console.error('Reset verify email error:', error);
        return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
    }
});

// ─── STEP 2: Save new password (self-service) ────────────────────────────────
router.post('/staff/reset-password-self', async (req, res) => {
    const { email, new_password } = req.body;

    if (!email || !new_password) {
        return res.json({ success: false, message: 'Email and new password are required.' });
    }

    if (new_password.trim().length < 6) {
        return res.json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    // Security check: email must match what was verified in STEP 1
    const sessionEmail = req.session.resetEmail;
    if (!sessionEmail || sessionEmail !== email.trim().toLowerCase()) {
        return res.json({ success: false, message: 'Session expired or email mismatch. Please restart the reset process.' });
    }

    try {
        const [rows] = await db.query(
            `SELECT staff_id, full_name, username FROM staff
             WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND is_active = true`,
            [email.trim()]
        );

        if (rows.length === 0) {
            return res.json({ success: false, message: 'Staff account not found or is inactive.' });
        }

        const staffMember = rows[0];
        const passwordHash = await bcrypt.hash(new_password.trim(), 10);

        await db.query(
            `UPDATE staff SET password_hash = $1 WHERE staff_id = $2`,
            [passwordHash, staffMember.staff_id]
        );

        // Clear reset session token
        delete req.session.resetEmail;

        await logActivity(
            staffMember.staff_id,
            'SELF_PASSWORD_RESET',
            `Staff member ${staffMember.full_name} (${staffMember.username}) reset their own password via the Forgot Password flow.`,
            req
        );

        return res.json({ success: true });

    } catch (error) {
        console.error('Self password reset error:', error);
        return res.status(500).json({ success: false, message: 'Server error updating password. Please try again.' });
    }
});

// Staff logout
router.get('/staff/logout', async (req, res) => {
    if (req.session && req.session.staff) {
        await logActivity(req.session.staff.staff_id, 'LOGOUT', `Staff member ${req.session.staff.username} logged out`, req);
    }
    req.session.destroy();
    res.redirect('/staff/login');
});

// Student logout
router.get('/logout', async (req, res) => {
    if (req.session && req.session.student) {
        const s = req.session.student;
        await logStudentActivity(s.reg_number, s.full_name, 'STUDENT_LOGOUT',
            `Student ${s.full_name} (${s.reg_number}) logged out of the portal.`, req);
    }
    req.session.destroy();
    res.redirect('/');
});

module.exports = router;
