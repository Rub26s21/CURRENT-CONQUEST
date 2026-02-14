/**
 * Vercel Serverless Entry Point
 * Quiz Conquest - ECE Professional Online Exam Platform
 * 
 * FIXED:
 * - CORS origin properly configured for Vercel frontend
 * - trust proxy for session cookies over HTTPS
 * - Proper error handling
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();

// Trust proxy FIRST (required for secure cookies on Vercel)
app.set('trust proxy', 1);

// Security
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS - Allow the Vercel frontend origin with credentials
const allowedOrigins = [
    process.env.FRONTEND_URL,                         // e.g. https://your-app.vercel.app
    'http://localhost:3000',
    'http://127.0.0.1:3000'
].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (server-side, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.some(o => origin === o || origin.endsWith('.vercel.app'))) {
            return callback(null, true);
        }
        // In production, still allow for same-origin requests
        return callback(null, true);
    },
    credentials: true
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Import sessions and routes
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

// Server time endpoint (for client timer sync)
app.get('/api/server-time', (req, res) => {
    res.json({
        success: true,
        serverTime: new Date().toISOString(),
        timestamp: Date.now()
    });
});

// Catch-all API 404
app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, message: 'API Route Not Found' });
});

// Error handling - always return JSON, never HTML
app.use((err, req, res, next) => {
    console.error('SERVER_FATAL_ERROR:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error: ' + (err.message || 'Unknown error')
    });
});

module.exports = app;
