/**
 * Session Configuration
 * Current Conquest - ECE Professional Online Exam Platform
 */

const session = require('express-session');
require('dotenv').config();

const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'current-conquest-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax'
    },
    name: 'cc.session'
};

module.exports = { session, sessionConfig };
