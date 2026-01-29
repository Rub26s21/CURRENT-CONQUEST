/**
 * Authentication Middleware
 * Current Conquest - ECE Professional Online Exam Platform
 */

const { supabase } = require('../config/database');

/**
 * Middleware to verify admin session
 */
const requireAdmin = async (req, res, next) => {
    try {
        if (!req.session || !req.session.adminId) {
            return res.status(401).json({
                success: false,
                message: 'Admin authentication required'
            });
        }

        // Verify admin exists in database
        const { data: admin, error } = await supabase
            .from('admins')
            .select('id, username')
            .eq('id', req.session.adminId)
            .single();

        if (error || !admin) {
            req.session.destroy();
            return res.status(401).json({
                success: false,
                message: 'Invalid admin session'
            });
        }

        req.admin = admin;
        next();
    } catch (error) {
        console.error('Admin auth error:', error);
        res.status(500).json({
            success: false,
            message: 'Authentication error'
        });
    }
};

/**
 * Middleware to verify participant session
 */
const requireParticipant = async (req, res, next) => {
    try {
        if (!req.session || !req.session.participantId) {
            return res.status(401).json({
                success: false,
                message: 'Participant authentication required'
            });
        }

        // Verify participant exists and is active
        const { data: participant, error } = await supabase
            .from('participants')
            .select('*')
            .eq('id', req.session.participantId)
            .eq('is_active', true)
            .single();

        if (error || !participant) {
            req.session.destroy();
            return res.status(401).json({
                success: false,
                message: 'Invalid participant session'
            });
        }

        // Check if disqualified
        if (participant.is_disqualified) {
            return res.status(403).json({
                success: false,
                message: 'You have been disqualified',
                reason: participant.disqualification_reason
            });
        }

        req.participant = participant;
        next();
    } catch (error) {
        console.error('Participant auth error:', error);
        res.status(500).json({
            success: false,
            message: 'Authentication error'
        });
    }
};

/**
 * Middleware to log audit events
 */
const auditLog = async (participantId, adminId, eventType, description, roundNumber = null, req = null, metadata = null) => {
    try {
        await supabase.from('audit_logs').insert({
            participant_id: participantId,
            admin_id: adminId,
            event_type: eventType,
            event_description: description,
            round_number: roundNumber,
            ip_address: req ? (req.ip || req.connection?.remoteAddress) : null,
            user_agent: req ? req.get('User-Agent') : null,
            metadata: metadata
        });
    } catch (error) {
        console.error('Audit log error:', error);
    }
};

module.exports = {
    requireAdmin,
    requireParticipant,
    auditLog
};
