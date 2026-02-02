/**
 * Vercel Serverless Entry Point - Consolidated
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();

// Security & CORS
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy for sessions on Vercel
app.set('trust proxy', 1);

// Import sessions and routes from the local api/ folder
// This ensures Vercel finds them during building
const { session, sessionConfig } = require('./config/session');
const adminRoutes = require('./routes/admin');
const questionRoutes = require('./routes/questions');
const participantRoutes = require('./routes/participant');
const uploadRoutes = require('./routes/upload');

// Session middleware
app.use(session(sessionConfig));

// API Routes
app.use('/api/admin', adminRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/participant', participantRoutes);
app.use('/api/upload', uploadRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'API is running',
        env: {
            hasUrl: !!process.env.SUPABASE_URL,
            hasKey: !!process.env.SUPABASE_SERVICE_KEY,
            nodeEnv: process.env.NODE_ENV
        }
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('API Error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error: ' + err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

module.exports = app;
