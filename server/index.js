/**
 * Server Entry Point
 * Current Conquest - ECE Professional Online Exam Platform
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { session, sessionConfig } = require('./config/session');

// Import routes
const adminRoutes = require('./routes/admin');
const questionRoutes = require('./routes/questions');
const participantRoutes = require('./routes/participant');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable for local development
    crossOriginEmbedderPolicy: false
}));

// CORS configuration for local network access
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);

        // Allow localhost and local network IPs
        const allowedOrigins = [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/,
            /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
            /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}:\d+$/
        ];

        const allowed = allowedOrigins.some(pattern => {
            if (pattern instanceof RegExp) {
                return pattern.test(origin);
            }
            return origin === pattern;
        });

        if (allowed) {
            callback(null, true);
        } else {
            callback(null, true); // Allow all for local network setup
        }
    },
    credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session middleware
app.use(session(sessionConfig));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/admin', adminRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/participant', participantRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Current Conquest API is running',
        timestamp: new Date().toISOString()
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

// Serve frontend pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin/index.html'));
});

app.get('/admin/*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin/index.html'));
});

app.get('/exam', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/exam.html'));
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({
            success: false,
            message: 'API endpoint not found'
        });
    } else {
        res.sendFile(path.join(__dirname, '../public/index.html'));
    }
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error'
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║     CURRENT CONQUEST - ECE Online Exam Platform              ║
║                                                              ║
║     Server running on:                                       ║
║     → Local:   http://localhost:${PORT}                        ║
║     → Network: http://<YOUR_IP>:${PORT}                        ║
║                                                              ║
║     Admin Panel: http://localhost:${PORT}/admin                ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
