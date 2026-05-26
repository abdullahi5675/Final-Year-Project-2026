// Middleware to check if student is authenticated
function requireStudentAuth(req, res, next) {
    if (req.session && req.session.student) {
        return next();
    }
    res.redirect('/');
}

// Middleware to check if staff is authenticated
function requireStaffAuth(req, res, next) {
    if (req.session && req.session.staff) {
        return next();
    }
    res.redirect('/staff/login');
}

// Middleware to redirect if already logged in
function redirectIfLoggedIn(req, res, next) {
    if (req.session && req.session.student) {
        return res.redirect('/student/dashboard');
    }
    if (req.session && req.session.staff) {
        return res.redirect('/staff/dashboard');
    }
    next();
}

module.exports = {
    requireStudentAuth,
    requireStaffAuth,
    redirectIfLoggedIn
};
