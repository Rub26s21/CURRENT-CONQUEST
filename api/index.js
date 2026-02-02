/**
 * Vercel Serverless Entry Point - Robust Version
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();

// Security & CORS
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
    origin: true,
    credentials: true
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy for sessions on Vercel
app.set('trust proxy', 1);

// Import sessions and routes
// Note: Using path.resolve to be extra sure about locations in Vercel's lambda
const { session, sessionConfig } = require(path.resolve(__dirname, 'config/session'));
const adminRoutes = require(path.resolve(__dirname, 'routes/admin'));
const questionRoutes = require(path.resolve(__dirname, 'routes/questions'));
const participantRoutes = require(path.resolve(__dirname, 'routes/participant'));
const uploadRoutes = require(path.resolve(__dirname, 'routes/upload'));

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
        message: 'Quiz Conquest API is running',
        timestamp: new Date().toISOString(),
        env: {
            hasUrl: !!process.env.SUPABASE_URL,
            hasKey: !!process.env.SUPABASE_SERVICE_KEY,
            nodeEnv: process.env.NODE_ENV
        }
    });
});

// Catch-all API 404
app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, message: 'API Route Not Found' });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('SERVER_FATAL_ERROR:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error: ' + err.message,
        error_type: err.name
    });
});

module.exports = app;
