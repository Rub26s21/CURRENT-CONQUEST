/**
 * Server Entry Point — V4 Architecture
 * Quiz Conquest - ECE Professional Online Exam Platform
 *
 * ARCHITECTURE:
 *   • Admin routes: session-based (login/logout/round control)
 *   • Participant routes: NO sessions, NO auth
 *   • All participant identification via attempt_token (UUID)
 *   • No personal data storage
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
const uploadRoutes = require('./routes/upload');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (required for secure cookies behind reverse proxy/Vercel)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
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
            /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}:\d+$/,
            /^https:\/\/.*\.vercel\.app$/
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

// Session middleware (only needed for admin panel)
app.use(session(sessionConfig));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// ──── API Routes ────────────────────────────────────────────

// Admin routes (session-based auth)
app.use('/api/admin', adminRoutes);

// Question management (admin-only)
app.use('/api/questions', questionRoutes);

// File upload (admin-only)
app.use('/api/upload', uploadRoutes);

// Participant/exam routes (NO sessions, NO auth)
app.use('/api/exam', participantRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Quiz Conquest V4 API is running',
        version: '4.0.0',
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

// ──── Frontend Routes ───────────────────────────────────────

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
║     QUIZ CONQUEST V4 - ECE Online Exam Platform              ║
║     Architecture: Token-based, Zero Personal Data            ║
║                                                              ║
║     Server running on:                                       ║
║     → Local:   http://localhost:${PORT}                        ║
║     → Network: http://<YOUR_IP>:${PORT}                        ║
║                                                              ║
║     Admin Panel: http://localhost:${PORT}/admin                ║
║     Exam:        http://localhost:${PORT}/exam                 ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
