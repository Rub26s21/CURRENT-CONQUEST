/**
 * Vercel Serverless Entry Point
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

// Import sessions and routes from server structure
const { session, sessionConfig } = require('../server/config/session');
const adminRoutes = require('../server/routes/admin');
const questionRoutes = require('../server/routes/questions');
const participantRoutes = require('../server/routes/participant');
const uploadRoutes = require('../server/routes/upload');

const app = express();

// Security & CORS
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy for sessions on Vercel
app.set('trust proxy', 1);

// Session middleware
app.use(session(sessionConfig));

// API Routes - Handles both /api/admin and /admin if rewrites vary
app.use(['/api/admin', '/admin'], adminRoutes);
app.use(['/api/questions', '/questions'], questionRoutes);
app.use(['/api/participant', '/participant'], participantRoutes);
app.use(['/api/upload', '/upload'], uploadRoutes);

// Health check
app.get(['/api/health', '/health'], (req, res) => {
    res.json({ success: true, message: 'API is running', env: process.env.NODE_ENV });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('API Error:', err);
    res.status(500).json({ success: false, message: 'Internal server error: ' + err.message });
});

module.exports = app;
