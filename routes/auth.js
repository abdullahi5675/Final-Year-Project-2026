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
    res.render('student-login', { error: null, setupMode: false, studentInfo: null, reg_number: '' });
});

// Alias /login to student login
router.get('/login', redirectIfLoggedIn, (req, res) => {
    res.render('student-login', { error: null, setupMode: false, studentInfo: null, reg_number: '' });
});

// Student login POST
router.post('/login', async (req, res) => {
    const { reg_number, password, new_password, confirm_password } = req.body;
    const cleanReg = reg_number ? reg_number.trim() : '';

    if (!cleanReg) {
        return res.render('student-login', {
            error: 'Please enter your Registration Number.',
            setupMode: false,
            studentInfo: null,
            reg_number: ''
        });
    }

    try {
        const [students] = await db.query(
            'SELECT * FROM students WHERE LOWER(TRIM(reg_number)) = LOWER(TRIM($1)) AND is_active = true',
            [cleanReg]
        );

        if (students.length === 0) {
            // Log failed attempt (unknown reg number)
            await logStudentActivity(cleanReg, cleanReg, 'STUDENT_LOGIN_FAILED',
                `Login attempt with unrecognized registration number: ${cleanReg}`, req);
            return res.render('student-login', {
                error: 'Registration number not found in NELFUND approved list.',
                setupMode: false,
                studentInfo: null,
                reg_number: cleanReg
            });
        }

        const student = students[0];

        // ─── FIRST-TIME LOGIN: Password Setup Mode ──────────────────────────────
        if (!student.password_hash) {
            // If student submits new password to complete setup
            if (new_password) {
                if (new_password.trim().length < 6) {
                    return res.render('student-login', {
                        error: 'Password must be at least 6 characters long.',
                        setupMode: true,
                        studentInfo: student,
                        reg_number: student.reg_number
                    });
                }

                if (new_password.trim() !== (confirm_password ? confirm_password.trim() : '')) {
                    return res.render('student-login', {
                        error: 'Passwords do not match. Please try again.',
                        setupMode: true,
                        studentInfo: student,
                        reg_number: student.reg_number
                    });
                }

                const passwordHash = await bcrypt.hash(new_password.trim(), 10);
                await db.query(
                    'UPDATE students SET password_hash = $1 WHERE reg_number = $2',
                    [passwordHash, student.reg_number]
                );

                req.session.student = {
                    reg_number: student.reg_number,
                    full_name: student.full_name,
                    department: student.department,
                    level: student.level
                };

                await logStudentActivity(
                    student.reg_number,
                    student.full_name,
                    'STUDENT_PASSWORD_SETUP',
                    `Student ${student.full_name} (${student.reg_number}) set up their password and logged in.`,
                    req
                );

                return res.redirect('/student/dashboard');
            } else {
                // Render setup password form
                return res.render('student-login', {
                    error: null,
                    setupMode: true,
                    studentInfo: student,
                    reg_number: student.reg_number
                });
            }
        }

        // ─── SUBSEQUENT LOGINS: Password Verification ──────────────────────────
        if (!password || !password.trim()) {
            return res.render('student-login', {
                error: 'Please enter your password.',
                setupMode: false,
                studentInfo: null,
                reg_number: student.reg_number
            });
        }

        const validPassword = await bcrypt.compare(password.trim(), student.password_hash);

        if (!validPassword) {
            await logStudentActivity(
                student.reg_number,
                student.full_name,
                'STUDENT_LOGIN_FAILED',
                `Invalid password attempt for student ${student.reg_number}`,
                req
            );
            return res.render('student-login', {
                error: 'Invalid password. Please try again or click Forgot Password.',
                setupMode: false,
                studentInfo: null,
                reg_number: student.reg_number
            });
        }

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

        return res.redirect('/student/dashboard');

    } catch (error) {
        console.error('Student login error:', error);
        return res.render('student-login', {
            error: 'An error occurred. Please try again.',
            setupMode: false,
            studentInfo: null,
            reg_number: cleanReg
        });
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

// ─── STUDENT SELF-SERVICE PASSWORD RESET: Step 1 — Verify Registration Number ─
router.post('/student/reset-verify-reg', async (req, res) => {
    const { reg_number } = req.body;

    if (!reg_number || !reg_number.trim()) {
        return res.json({ success: false, message: 'Registration Number is required.' });
    }

    try {
        const [rows] = await db.query(
            `SELECT reg_number, full_name, is_active
             FROM students WHERE LOWER(TRIM(reg_number)) = LOWER(TRIM($1))`,
            [reg_number.trim()]
        );

        if (rows.length === 0) {
            return res.json({ success: false, message: 'Registration number not found in approved list. Please check and try again.' });
        }

        if (!rows[0].is_active) {
            return res.json({ success: false, message: 'This student account has been deactivated. Please contact Student Affairs.' });
        }

        // Registration number verified — store it in session temporarily
        req.session.resetStudentReg = rows[0].reg_number;

        return res.json({
            success: true,
            full_name: rows[0].full_name,
            reg_number: rows[0].reg_number
        });

    } catch (error) {
        console.error('Student reset verify reg error:', error);
        return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
    }
});

// ─── STUDENT SELF-SERVICE PASSWORD RESET: Step 2 — Save New Password ──────────
router.post('/student/reset-password-self', async (req, res) => {
    const { reg_number, new_password } = req.body;

    if (!reg_number || !new_password) {
        return res.json({ success: false, message: 'Registration Number and new password are required.' });
    }

    if (new_password.trim().length < 6) {
        return res.json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    // Security check: reg number must match what was verified in Step 1
    const sessionReg = req.session.resetStudentReg;
    if (!sessionReg || sessionReg.toLowerCase() !== reg_number.trim().toLowerCase()) {
        return res.json({ success: false, message: 'Session expired or registration number mismatch. Please restart the reset process.' });
    }

    try {
        const [rows] = await db.query(
            `SELECT reg_number, full_name FROM students
             WHERE LOWER(TRIM(reg_number)) = LOWER(TRIM($1)) AND is_active = true`,
            [reg_number.trim()]
        );

        if (rows.length === 0) {
            return res.json({ success: false, message: 'Student account not found or is inactive.' });
        }

        const student = rows[0];
        const passwordHash = await bcrypt.hash(new_password.trim(), 10);

        await db.query(
            `UPDATE students SET password_hash = $1 WHERE reg_number = $2`,
            [passwordHash, student.reg_number]
        );

        // Clear reset session token
        delete req.session.resetStudentReg;

        await logStudentActivity(
            student.reg_number,
            student.full_name,
            'STUDENT_SELF_PASSWORD_RESET',
            `Student ${student.full_name} (${student.reg_number}) reset their password via self-service Forgot Password flow.`,
            req
        );

        return res.json({ success: true, message: 'Password reset successfully!' });

    } catch (error) {
        console.error('Student self password reset error:', error);
        return res.status(500).json({ success: false, message: 'Server error updating password. Please try again.' });
    }
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
