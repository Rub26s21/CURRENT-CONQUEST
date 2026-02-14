/**
 * Admin Routes — Production-Grade CBT Engine
 * Quiz Conquest v3.0
 *
 * DESIGN RULES:
 *   • Round end calls finalize_round() (single atomic DB function)
 *   • No race condition between timer-end and admin-end
 *   • Disqualified participants excluded from ranking
 *   • Top 25 qualification (not percentage)
 *   • All admin actions audit-logged (fire-and-forget)
 *   • Every mutation is idempotent
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { supabase } = require('../config/database');
const { requireAdmin, auditLog } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────
// POST /login — Admin login
// ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password are required'
            });
        }

        const envUsername = (process.env.ADMIN_USERNAME || '').trim();
        const envPassword = (process.env.ADMIN_PASSWORD || '').trim();

        if (username.trim() !== envUsername || password.trim() !== envPassword) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Ensure admin record exists in DB
        let adminId;
        const { data: existingAdmin } = await supabase
            .from('admins')
            .select('id')
            .eq('username', username.trim())
            .single();

        if (existingAdmin) {
            adminId = existingAdmin.id;
            await supabase
                .from('admins')
                .update({ last_login: new Date().toISOString() })
                .eq('id', adminId);
        } else {
            const passwordHash = await bcrypt.hash(password, 10);
            const { data: newAdmin, error } = await supabase
                .from('admins')
                .insert({
                    username: username.trim(),
                    password_hash: passwordHash,
                    last_login: new Date().toISOString()
                })
                .select('id')
                .single();
            if (error) throw error;
            adminId = newAdmin.id;
        }

        // Set session — this is the source of truth
        req.session.adminId = adminId;
        req.session.adminUsername = username.trim();
        req.session.isAdmin = true;

        auditLog(null, adminId, 'ADMIN_LOGIN', 'Admin logged in', null, req);

        res.json({
            success: true,
            message: 'Login successful',
            admin: { username: username.trim() }
        });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ success: false, message: 'Login failed' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /logout
// ─────────────────────────────────────────────────────────────
router.post('/logout', requireAdmin, (req, res) => {
    auditLog(null, req.admin.id, 'ADMIN_LOGOUT', 'Admin logged out', null, req);
    if (req.session?.destroy) req.session.destroy(() => { });
    res.json({ success: true, message: 'Logged out successfully' });
});

// ─────────────────────────────────────────────────────────────
// GET /session — Check admin session
// ─────────────────────────────────────────────────────────────
router.get('/session', async (req, res) => {
    try {
        if (!req.session?.adminId) {
            return res.json({ success: true, authenticated: false });
        }

        const { data: admin, error } = await supabase
            .from('admins')
            .select('id, username')
            .eq('id', req.session.adminId)
            .single();

        if (error || !admin) {
            if (req.session?.destroy) req.session.destroy(() => { });
            return res.json({ success: true, authenticated: false });
        }

        res.json({
            success: true,
            authenticated: true,
            admin: { username: admin.username }
        });
    } catch (error) {
        console.error('Session check error:', error);
        res.status(500).json({ success: false, message: 'Session check failed' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /dashboard — Dashboard data
// ─────────────────────────────────────────────────────────────
router.get('/dashboard', requireAdmin, async (req, res) => {
    try {
        const { data: eventState, error: eventError } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();
        if (eventError) throw eventError;

        const { count: totalParticipants } = await supabase
            .from('participants')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        const { count: qualifiedParticipants } = await supabase
            .from('participants')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true)
            .eq('is_qualified', true)
            .eq('is_disqualified', false);

        const { count: disqualifiedCount } = await supabase
            .from('participants')
            .select('*', { count: 'exact', head: true })
            .eq('is_disqualified', true);

        const { data: questionCounts } = await supabase
            .from('questions')
            .select('round_number');

        const questionsPerRound = {
            1: questionCounts?.filter(q => q.round_number === 1).length || 0,
            2: questionCounts?.filter(q => q.round_number === 2).length || 0,
            3: questionCounts?.filter(q => q.round_number === 3).length || 0
        };

        const { data: rounds } = await supabase
            .from('rounds')
            .select('*')
            .order('round_number');

        let submittedCount = 0;
        if (eventState.current_round > 0) {
            const { count } = await supabase
                .from('exam_sessions')
                .select('*', { count: 'exact', head: true })
                .eq('round_number', eventState.current_round)
                .eq('is_submitted', true);
            submittedCount = count || 0;
        }

        res.json({
            success: true,
            data: {
                eventState: {
                    currentRound: eventState.current_round,
                    roundStatus: eventState.round_status,
                    roundStartedAt: eventState.round_started_at,
                    roundEndsAt: eventState.round_ends_at,
                    eventActive: eventState.event_active
                },
                participants: {
                    total: totalParticipants || 0,
                    qualified: qualifiedParticipants || 0,
                    disqualified: disqualifiedCount || 0,
                    submittedCurrentRound: submittedCount
                },
                questionsPerRound,
                rounds: rounds || []
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard data' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /event/activate — Activate event
// ─────────────────────────────────────────────────────────────
router.post('/event/activate', requireAdmin, async (req, res) => {
    try {
        const { error } = await supabase
            .from('event_state')
            .update({ event_active: true, updated_at: new Date().toISOString() })
            .eq('id', 1);
        if (error) throw error;

        auditLog(null, req.admin.id, 'EVENT_ACTIVATED', 'Event activated', null, req);
        res.json({ success: true, message: 'Event activated successfully' });
    } catch (error) {
        console.error('Event activation error:', error);
        res.status(500).json({ success: false, message: 'Failed to activate event' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /round/start — Start a round
// ─────────────────────────────────────────────────────────────
router.post('/round/start', requireAdmin, async (req, res) => {
    try {
        const { roundNumber } = req.body;

        if (!roundNumber || roundNumber < 1 || roundNumber > 3) {
            return res.status(400).json({ success: false, message: 'Invalid round number' });
        }

        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (!eventState.event_active) {
            return res.status(400).json({ success: false, message: 'Event must be activated first' });
        }

        // Verify previous rounds completed
        if (roundNumber > 1) {
            const { data: prevRound } = await supabase
                .from('rounds')
                .select('*')
                .eq('round_number', roundNumber - 1)
                .single();

            if (!prevRound || prevRound.status !== 'completed' || !prevRound.shortlisting_completed) {
                return res.status(400).json({
                    success: false,
                    message: `Round ${roundNumber - 1} must be completed and shortlisted first`
                });
            }
        }

        // Verify 15 questions exist
        const { count: questionCount } = await supabase
            .from('questions')
            .select('*', { count: 'exact', head: true })
            .eq('round_number', roundNumber);

        if (questionCount < 15) {
            return res.status(400).json({
                success: false,
                message: `Round ${roundNumber} requires 15 questions. Currently has ${questionCount}.`
            });
        }

        const { data: round } = await supabase
            .from('rounds')
            .select('duration_minutes')
            .eq('round_number', roundNumber)
            .single();

        const now = new Date();
        const endsAt = new Date(now.getTime() + round.duration_minutes * 60 * 1000);

        // Update event state
        const { error: eventError } = await supabase
            .from('event_state')
            .update({
                current_round: roundNumber,
                round_status: 'running',
                round_started_at: now.toISOString(),
                round_ends_at: endsAt.toISOString(),
                updated_at: now.toISOString()
            })
            .eq('id', 1);
        if (eventError) throw eventError;

        // Update round status
        const { error: roundError } = await supabase
            .from('rounds')
            .update({ status: 'active', started_at: now.toISOString() })
            .eq('round_number', roundNumber);
        if (roundError) throw roundError;

        auditLog(null, req.admin.id, 'ROUND_STARTED',
            `Round ${roundNumber} started (${round.duration_minutes} min)`, roundNumber, req);

        res.json({
            success: true,
            message: `Round ${roundNumber} started successfully`,
            data: {
                roundNumber,
                startedAt: now.toISOString(),
                endsAt: endsAt.toISOString(),
                durationMinutes: round.duration_minutes
            }
        });
    } catch (error) {
        console.error('Round start error:', error);
        res.status(500).json({ success: false, message: 'Failed to start round' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /round/end — END ROUND (CRITICAL)
//
// Calls the SINGLE ATOMIC finalize_round() database function.
// This handles:
//   1. Idempotent guard (prevents double execution)
//   2. Auto-submit all pending sessions
//   3. Calculate scores (responses × questions comparison)
//   4. Generate rankings (exclude disqualified)
//   5. Shortlist Top 25
//   6. Update participants
//   7. Mark round completed
//
// Safe against race conditions — if admin clicks twice, or
// both timer-end and admin-end fire simultaneously, only
// the first call executes; the second is a no-op.
// ─────────────────────────────────────────────────────────────
router.post('/round/end', requireAdmin, async (req, res) => {
    try {
        // Get current round number
        const { data: eventState } = await supabase
            .from('event_state')
            .select('current_round, round_status')
            .eq('id', 1)
            .single();

        if (!eventState || eventState.current_round === 0) {
            return res.status(400).json({ success: false, message: 'No round to end' });
        }

        const roundNumber = eventState.current_round;

        // ── CALL ATOMIC finalize_round() ──────────────────────
        const { data: result, error } = await supabase.rpc('finalize_round', {
            p_round_number: roundNumber
        });

        if (error) {
            console.error('finalize_round RPC error:', error);
            throw error;
        }

        // Handle idempotent case
        if (result?.already_completed) {
            return res.json({
                success: true,
                message: `Round ${roundNumber} was already finalized`,
                alreadyCompleted: true,
                data: result
            });
        }

        auditLog(null, req.admin.id, 'ROUND_ENDED',
            `Round ${roundNumber} finalized — ` +
            `${result.auto_submitted} auto-submitted, ` +
            `${result.total_scored} scored, ` +
            `${result.qualified_count}/${result.total_eligible} qualified`,
            roundNumber, req, result);

        res.json({
            success: true,
            message: `Round ${roundNumber} ended successfully`,
            data: result
        });
    } catch (error) {
        console.error('Round end error:', error);
        res.status(500).json({ success: false, message: 'Failed to end round' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /round/shortlist — Manual re-shortlist
// For admin override (re-run shortlisting after manual changes)
// ─────────────────────────────────────────────────────────────
router.post('/round/shortlist', requireAdmin, async (req, res) => {
    try {
        const { roundNumber, topCount } = req.body;

        if (!roundNumber) {
            return res.status(400).json({ success: false, message: 'Round number required' });
        }

        // Verify round is completed
        const { data: round } = await supabase
            .from('rounds')
            .select('*')
            .eq('round_number', roundNumber)
            .single();

        if (!round || round.status !== 'completed') {
            return res.status(400).json({
                success: false,
                message: 'Round must be completed before shortlisting'
            });
        }

        // Recalculate scores first
        const { error: scoreErr } = await supabase.rpc('calculate_round_scores', {
            p_round_number: roundNumber
        });
        if (scoreErr) throw scoreErr;

        // Regenerate rankings
        const { error: rankErr } = await supabase.rpc('generate_rankings', {
            p_round_number: roundNumber
        });
        if (rankErr) throw rankErr;

        // Perform shortlisting with custom topCount
        const finalTopCount = topCount || 25;
        const { data: result, error: shortlistErr } = await supabase.rpc('perform_shortlisting', {
            p_round_number: roundNumber,
            p_top_count: finalTopCount
        });
        if (shortlistErr) throw shortlistErr;

        auditLog(null, req.admin.id, 'SHORTLISTING_COMPLETED',
            `Round ${roundNumber} shortlisting — Top ${finalTopCount}`,
            roundNumber, req, result);

        res.json({
            success: true,
            message: `Shortlisting completed for Round ${roundNumber}`,
            data: result
        });
    } catch (error) {
        console.error('Shortlisting error:', error);
        res.status(500).json({ success: false, message: 'Failed to perform shortlisting' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /results/:roundNumber — Get results
// ─────────────────────────────────────────────────────────────
router.get('/results/:roundNumber', requireAdmin, async (req, res) => {
    try {
        const roundNumber = parseInt(req.params.roundNumber);

        const { data: results, error } = await supabase
            .from('scores')
            .select(`
                *,
                participants:participant_id (
                    system_id, name, college_name, phone_number,
                    is_disqualified, disqualification_reason
                )
            `)
            .eq('round_number', roundNumber)
            .order('rank', { ascending: true, nullsFirst: false });

        if (error) throw error;

        const { data: auditLogs } = await supabase
            .from('audit_logs')
            .select(`
                *,
                participants:participant_id (system_id, name)
            `)
            .eq('round_number', roundNumber)
            .order('created_at', { ascending: false });

        res.json({
            success: true,
            data: {
                results: results || [],
                auditLogs: auditLogs || []
            }
        });
    } catch (error) {
        console.error('Results fetch error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch results' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /participants — Get all participants
// ─────────────────────────────────────────────────────────────
router.get('/participants', requireAdmin, async (req, res) => {
    try {
        const { data: participants, error } = await supabase
            .from('participants')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data: participants || [] });
    } catch (error) {
        console.error('Participants fetch error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch participants' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /participant/disqualify — Admin disqualification override
// ─────────────────────────────────────────────────────────────
router.post('/participant/disqualify', requireAdmin, async (req, res) => {
    try {
        const { participantId, reason } = req.body;

        if (!participantId) {
            return res.status(400).json({ success: false, message: 'Participant ID required' });
        }

        const { error } = await supabase
            .from('participants')
            .update({
                is_disqualified: true,
                disqualification_reason: reason || 'Admin manual disqualification'
            })
            .eq('id', participantId);

        if (error) throw error;

        auditLog(participantId, req.admin.id, 'ADMIN_DISQUALIFY',
            `Admin disqualified: ${reason || 'No reason given'}`, null, req);

        res.json({ success: true, message: 'Participant disqualified' });
    } catch (error) {
        console.error('Disqualify error:', error);
        res.status(500).json({ success: false, message: 'Failed to disqualify participant' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /participant/reinstate — Admin reinstatement override
// ─────────────────────────────────────────────────────────────
router.post('/participant/reinstate', requireAdmin, async (req, res) => {
    try {
        const { participantId } = req.body;

        if (!participantId) {
            return res.status(400).json({ success: false, message: 'Participant ID required' });
        }

        const { error } = await supabase
            .from('participants')
            .update({
                is_disqualified: false,
                disqualification_reason: null,
                is_qualified: true
            })
            .eq('id', participantId);

        if (error) throw error;

        auditLog(participantId, req.admin.id, 'ADMIN_REINSTATE',
            'Admin reinstated participant', null, req);

        res.json({ success: true, message: 'Participant reinstated' });
    } catch (error) {
        console.error('Reinstate error:', error);
        res.status(500).json({ success: false, message: 'Failed to reinstate participant' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /audit-logs — Get audit logs
// ─────────────────────────────────────────────────────────────
router.get('/audit-logs', requireAdmin, async (req, res) => {
    try {
        const { data: logs, error } = await supabase
            .from('audit_logs')
            .select(`
                *,
                participants:participant_id (system_id, name)
            `)
            .order('created_at', { ascending: false })
            .limit(500);
        if (error) throw error;
        res.json({ success: true, data: logs || [] });
    } catch (error) {
        console.error('Audit logs error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /export/:roundNumber — Export results as CSV
// ─────────────────────────────────────────────────────────────
router.get('/export/:roundNumber', requireAdmin, async (req, res) => {
    try {
        const roundNumber = parseInt(req.params.roundNumber);

        const { data: eventState } = await supabase
            .from('event_state')
            .select('round_status')
            .eq('id', 1)
            .single();

        if (eventState?.round_status === 'running') {
            return res.status(400).json({
                success: false,
                message: 'Cannot export while a round is running'
            });
        }

        const { data: results, error } = await supabase
            .from('scores')
            .select(`
                *,
                participants:participant_id (
                    system_id, name, college_name, phone_number,
                    is_disqualified
                )
            `)
            .eq('round_number', roundNumber)
            .order('rank', { ascending: true, nullsFirst: false });

        if (error) throw error;

        const { data: sessions } = await supabase
            .from('exam_sessions')
            .select('participant_id, tab_switch_count, submission_type')
            .eq('round_number', roundNumber);

        const sessionMap = {};
        sessions?.forEach(s => { sessionMap[s.participant_id] = s; });

        const csvRows = [
            ['Rank', 'System ID', 'Name', 'College', 'Phone', 'Score',
                'Time (sec)', 'Tab Switches', 'Submission Type', 'Qualified',
                'Disqualified']
        ];

        results?.forEach(r => {
            const sess = sessionMap[r.participant_id] || {};
            csvRows.push([
                r.rank || 'DQ',
                r.participants?.system_id || '',
                r.participants?.name || '',
                r.participants?.college_name || '',
                r.participants?.phone_number || '',
                r.correct_answers,
                r.time_taken_seconds || '',
                sess.tab_switch_count || 0,
                sess.submission_type || '',
                r.qualified_for_next ? 'Yes' : 'No',
                r.participants?.is_disqualified ? 'Yes' : 'No'
            ]);
        });

        const csvContent = csvRows.map(row =>
            row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
        ).join('\n');

        auditLog(null, req.admin.id, 'RESULTS_EXPORTED',
            `Round ${roundNumber} results exported`, roundNumber, req);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition',
            `attachment; filename="round_${roundNumber}_results.csv"`);
        res.send(csvContent);
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ success: false, message: 'Failed to export results' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /round/update — Update round settings
// ─────────────────────────────────────────────────────────────
router.post('/round/update', requireAdmin, async (req, res) => {
    try {
        const { roundNumber, durationMinutes } = req.body;

        if (!roundNumber || !durationMinutes) {
            return res.status(400).json({
                success: false,
                message: 'Round number and duration are required'
            });
        }

        const { error } = await supabase
            .from('rounds')
            .update({ duration_minutes: parseInt(durationMinutes) })
            .eq('round_number', roundNumber);
        if (error) throw error;

        auditLog(null, req.admin.id, 'ROUND_UPDATED',
            `Round ${roundNumber} duration set to ${durationMinutes} min`, roundNumber, req);

        res.json({ success: true, message: 'Round settings updated' });
    } catch (error) {
        console.error('Update round error:', error);
        res.status(500).json({ success: false, message: 'Failed to update round settings' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /reset-event — Reset entire event (DANGEROUS)
// ─────────────────────────────────────────────────────────────
router.post('/reset-event', requireAdmin, async (req, res) => {
    try {
        const { confirmReset, preserveQuestions } = req.body;

        if (confirmReset !== 'RESET_ALL_DATA') {
            return res.status(400).json({ success: false, message: 'Invalid confirmation code' });
        }

        // Delete in FK order
        await supabase.from('audit_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('scores').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('responses').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('exam_sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000');

        if (!preserveQuestions) {
            await supabase.from('questions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        }

        await supabase.from('participants').delete().neq('id', '00000000-0000-0000-0000-000000000000');

        // Reset rounds
        await supabase
            .from('rounds')
            .update({
                status: 'pending',
                started_at: null,
                ended_at: null,
                shortlisting_completed: false
            })
            .neq('round_number', 0);

        // Reset event state
        await supabase
            .from('event_state')
            .update({
                current_round: 0,
                round_status: 'not_started',
                round_started_at: null,
                round_ends_at: null,
                event_active: false,
                updated_at: new Date().toISOString()
            })
            .eq('id', 1);

        res.json({ success: true, message: 'Event reset successfully' });
    } catch (error) {
        console.error('Reset error:', error);
        res.status(500).json({ success: false, message: 'Failed to reset event' });
    }
});

module.exports = router;
