/**
 * Session Configuration
 * Quiz Conquest - ECE Professional Online Exam Platform
 * 
 * FIXED: Cookie config for cross-origin Vercel deployment
 */

const session = require('express-session');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'quiz-conquest-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: isProduction,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: isProduction ? 'none' : 'lax'
    },
    name: 'qc.session'
};

module.exports = { session, sessionConfig };
