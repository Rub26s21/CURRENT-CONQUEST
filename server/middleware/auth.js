/**
 * Authentication Middleware — Production CBT Engine
 * Quiz Conquest v3.0
 *
 * DESIGN:
 *   • requireAdmin: Trusts session (DB verified at login only)
 *   • requireParticipant: Session + DB verification + disqualification check
 *   • auditLog: Fire-and-forget (NEVER blocks request handlers)
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
 * requireParticipant — Verify participant exists and is eligible
 */
const requireParticipant = async (req, res, next) => {
    try {
        if (!req.session?.participantId) {
            return res.status(401).json({
                success: false,
                message: 'Participant authentication required'
            });
        }

        const { data: participant, error } = await supabase
            .from('participants')
            .select('*')
            .eq('id', req.session.participantId)
            .single();

        if (error || !participant) {
            if (req.session?.destroy) req.session.destroy(() => { });
            return res.status(401).json({
                success: false,
                message: 'Invalid session — please log in again'
            });
        }

        if (!participant.is_active) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been deactivated'
            });
        }

        // Attach participant to request
        req.participant = participant;

        // Update last_activity (fire-and-forget)
        supabase
            .from('participants')
            .update({ last_activity: new Date().toISOString() })
            .eq('id', participant.id)
            .then(() => { })
            .catch(() => { });

        next();
    } catch (error) {
        console.error('Participant auth error:', error);
        res.status(500).json({ success: false, message: 'Authentication error' });
    }
};

/**
 * auditLog — Fire-and-forget, NEVER awaited
 *
 * Usage: auditLog(participantId, adminId, 'EVENT_TYPE', 'description', roundNumber, req, metadata)
 * Do NOT await this function.
 */
const auditLog = (participantId, adminId, eventType, description, roundNumber = null, req = null, metadata = null) => {
    const logData = {
        event_type: eventType,
        event_description: description
    };

    if (participantId) logData.participant_id = participantId;
    if (adminId) logData.admin_id = adminId;
    if (roundNumber !== null && typeof roundNumber === 'number') logData.round_number = roundNumber;
    if (metadata) logData.metadata = typeof metadata === 'object' ? metadata : { value: metadata };

    if (req) {
        logData.ip_address = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
            || req.connection?.remoteAddress || null;
        logData.user_agent = req.headers?.['user-agent'] || null;
    }

    supabase
        .from('audit_logs')
        .insert(logData)
        .then(() => { })
        .catch(err => {
            console.error('Audit log error (non-critical):', err.message);
        });
};

module.exports = { requireAdmin, requireParticipant, auditLog };
