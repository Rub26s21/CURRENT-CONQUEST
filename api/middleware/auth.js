/**
 * Authentication Middleware — V4 Architecture
 * Quiz Conquest
 *
 * DESIGN:
 *   • requireAdmin: Trusts session (DB verified at login only)
 *   • NO requireParticipant — V4 has no participant sessions
 *   • auditLog: Fire-and-forget (NEVER blocks request handlers)
 *   • audit_logs table no longer has participant_id FK
 */

const { supabase } = require('../config/database');

/**
 * requireAdmin — Trust session, no DB lookup per request
 */
const requireAdmin = (req, res, next) => {
    if (!req.session?.adminId) {
        return res.status(401).json({
            success: false,
            message: 'Admin authentication required'
        });
    }

    req.admin = {
        id: req.session.adminId,
        username: req.session.adminUsername || 'admin'
    };

    next();
};

/**
 * auditLog — Fire-and-forget, NEVER awaited
 *
 * V4: No participant_id. Uses attempt_token in metadata if needed.
 * Usage: auditLog(null, adminId, 'EVENT_TYPE', 'description', roundNumber, req, metadata)
 * Do NOT await this function.
 */
const auditLog = (unused, adminId, eventType, description, roundNumber = null, req = null, metadata = null) => {
    const logData = {
        event_type: eventType,
        event_description: description
    };

    if (adminId) logData.admin_id = adminId;
    if (roundNumber !== null && typeof roundNumber === 'number') logData.round_number = roundNumber;
    if (metadata) logData.metadata = typeof metadata === 'object' ? metadata : { value: metadata };

    supabase
        .from('audit_logs')
        .insert(logData)
        .then(() => { })
        .catch(err => {
            console.error('Audit log error (non-critical):', err.message);
        });
};

module.exports = { requireAdmin, auditLog };
