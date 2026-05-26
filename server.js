const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use((req, res, next) => {
    console.log(`\n=> [REQ START] ${req.method} ${req.url}`);
    next();
});
app.use(morgan('dev'));
app.disable('etag');
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1800000 // 30 minutes
    }
}));

// View engine setup (using EJS for simplicity, or you can use plain HTML)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make session available to all views
app.use((req, res, next) => {
    res.locals.session = req.session;
    next();
});

// Routes
const studentRoutes = require('./routes/student');
const staffRoutes = require('./routes/staff');
const authRoutes = require('./routes/auth');

app.use('/', authRoutes);
app.use('/student', studentRoutes);
app.use('/staff', staffRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).send('Page not found');
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
});

// Start server
app.listen(PORT, () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
});

// Catch unhandled promise rejections so the process never silently hangs
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
});
