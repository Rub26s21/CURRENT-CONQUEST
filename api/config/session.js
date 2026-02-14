/**
 * Session Configuration
 * Quiz Conquest - ECE Professional Online Exam Platform
 * 
 * FIXED: Cookie config for cross-origin Vercel deployment
 * - sameSite: 'none' + secure: true for HTTPS cross-origin
 * - trust proxy must be set on the Express app
 */

const session = require('express-session');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'quiz-conquest-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: isProduction,           // true on HTTPS (Vercel)
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,   // 24 hours
        sameSite: isProduction ? 'none' : 'lax'  // 'none' for cross-origin on Vercel
    },
    name: 'qc.session'
};

module.exports = { session, sessionConfig };
