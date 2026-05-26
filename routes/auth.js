const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/database');
const { redirectIfLoggedIn } = require('../middleware/auth');

// Student login page
router.get('/', redirectIfLoggedIn, (req, res) => {
    res.render('student-login', { error: null });
});

// Student login POST
router.post('/login', async (req, res) => {
    const { reg_number } = req.body;

    try {
        // Check if student exists in NELFUND approved list
        // PG: is_active = 1 -> is_active = true
        const [students] = await db.query(
            'SELECT * FROM students WHERE reg_number = $1 AND is_active = true',
            [reg_number]
        );

        if (students.length === 0) {
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
    const { username, password } = req.body;

    try {
        const [staff] = await db.query(
            'SELECT * FROM staff WHERE username = $1 AND is_active = true',
            [username]
        );

        if (staff.length === 0) {
            return res.render('staff-login', { error: 'Invalid username or password' });
        }

        const staffMember = staff[0];

        // Verify password
        const validPassword = await bcrypt.compare(password, staffMember.password_hash);

        if (!validPassword) {
            return res.render('staff-login', { error: 'Invalid username or password' });
        }

        // Update last login
        await db.query('UPDATE staff SET last_login = NOW() WHERE staff_id = $1', [staffMember.staff_id]);

        // Set session
        req.session.staff = {
            staff_id: staffMember.staff_id,
            username: staffMember.username,
            full_name: staffMember.full_name,
            role: staffMember.role
        };

        res.redirect('/staff/dashboard');

    } catch (error) {
        console.error('Staff login error:', error);
        res.render('staff-login', { error: 'An error occurred. Please try again.' });
    }
});

// Staff logout
router.get('/staff/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/staff/login');
});

// Student logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

module.exports = router;
