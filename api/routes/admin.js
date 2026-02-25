/**
 * Admin Routes — V4 Architecture
 * Quiz Conquest
 *
 * DESIGN RULES:
 *   • No participants table — submissions keyed by attempt_token
 *   • Round end calls finalize_round_v4() (single atomic DB function)
 *   • No race condition between timer-end and admin-end
 *   • Deterministic ranking via rank_round()
 *   • Top 25 qualification via shortlist_round()
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
// GET /dashboard — Dashboard data (V4: uses submissions/results)
// ─────────────────────────────────────────────────────────────
router.get('/dashboard', requireAdmin, async (req, res) => {
    try {
        const { data: eventState, error: eventError } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();
        if (eventError) throw eventError;

        // Count submissions for current round
        let submittedCount = 0;
        let totalSubmissions = 0;
        if (eventState.current_round > 0) {
            const { count } = await supabase
                .from('submissions')
                .select('*', { count: 'exact', head: true })
                .eq('round_number', eventState.current_round);
            submittedCount = count || 0;
        }

        // Total submissions across all rounds
        const { count: globalCount } = await supabase
            .from('submissions')
            .select('*', { count: 'exact', head: true });
        totalSubmissions = globalCount || 0;

        // Question counts per round
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

        // Result counts per round
        const { data: resultCounts } = await supabase
            .from('results')
            .select('round_number, qualified_for_next');

        const qualifiedPerRound = {};
        (resultCounts || []).forEach(r => {
            if (!qualifiedPerRound[r.round_number]) qualifiedPerRound[r.round_number] = { total: 0, qualified: 0 };
            qualifiedPerRound[r.round_number].total++;
            if (r.qualified_for_next) qualifiedPerRound[r.round_number].qualified++;
        });

        // Calculate total qualified across all rounds for display
        let totalQualified = 0;
        Object.values(qualifiedPerRound).forEach(r => {
            totalQualified += r.qualified || 0;
        });

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
                // Frontend expects this shape:
                participants: {
                    total: totalSubmissions,
                    qualified: totalQualified,
                    submittedCurrentRound: submittedCount
                },
                submissions: {
                    currentRound: submittedCount,
                    total: totalSubmissions
                },
                qualifiedPerRound,
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
// POST /event/pause — Pause event (Deactivate)
// ─────────────────────────────────────────────────────────────
router.post('/event/pause', requireAdmin, async (req, res) => {
    try {
        const { error } = await supabase
            .from('event_state')
            .update({ event_active: false, updated_at: new Date().toISOString() })
            .eq('id', 1);
        if (error) throw error;

        auditLog(null, req.admin.id, 'EVENT_PAUSED', 'Event paused', null, req);
        res.json({ success: true, message: 'Event paused successfully' });
    } catch (error) {
        console.error('Event pause error:', error);
        res.status(500).json({ success: false, message: 'Failed to pause event' });
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
// POST /round/end — END ROUND (V4)
//
// ONLY marks the round as completed and stops accepting submissions.
// Does NOT evaluate or rank answers.
// Evaluation + ranking happens when admin clicks "Shortlist".
// IDEMPOTENT: double calls are no-ops.
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

        // Check if already completed (idempotent)
        const { data: round } = await supabase
            .from('rounds')
            .select('status')
            .eq('round_number', roundNumber)
            .single();

        if (round && round.status === 'completed') {
            return res.json({
                success: true,
                message: `Round ${roundNumber} was already ended`,
                alreadyCompleted: true
            });
        }

        const now = new Date().toISOString();

        // Mark round as completed
        const { error: roundError } = await supabase
            .from('rounds')
            .update({ status: 'completed', ended_at: now })
            .eq('round_number', roundNumber);
        if (roundError) throw roundError;

        // Update event state
        const { error: eventError } = await supabase
            .from('event_state')
            .update({
                round_status: 'completed',
                updated_at: now
            })
            .eq('id', 1);
        if (eventError) throw eventError;

        // Count submissions for this round
        const { count: submissionCount } = await supabase
            .from('submissions')
            .select('*', { count: 'exact', head: true })
            .eq('round_number', roundNumber);

        auditLog(null, req.admin.id, 'ROUND_ENDED',
            `Round ${roundNumber} ended — ${submissionCount || 0} submissions collected. Awaiting shortlist.`,
            roundNumber, req);

        res.json({
            success: true,
            message: `Round ${roundNumber} ended. ${submissionCount || 0} submissions collected. Click "Shortlist" to evaluate and rank.`,
            data: {
                roundNumber,
                submissionCount: submissionCount || 0,
                endedAt: now,
                note: 'Answers will be evaluated when you click Shortlist'
            }
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

        // Re-evaluate
        const { error: evalErr } = await supabase.rpc('evaluate_round', {
            p_round_number: roundNumber
        });
        if (evalErr) throw evalErr;

        // Re-rank
        const { error: rankErr } = await supabase.rpc('rank_round', {
            p_round_number: roundNumber
        });
        if (rankErr) throw rankErr;

        // Re-shortlist with custom topCount
        const finalTopCount = topCount || 25;
        const { data: result, error: shortlistErr } = await supabase.rpc('shortlist_round', {
            p_round_number: roundNumber,
            p_top_count: finalTopCount
        });
        if (shortlistErr) throw shortlistErr;

        // Mark shortlisting as completed
        await supabase
            .from('rounds')
            .update({ shortlisting_completed: true })
            .eq('round_number', roundNumber);

        auditLog(null, req.admin.id, 'SHORTLISTING_COMPLETED',
            `Round ${roundNumber} re-shortlisted — Top ${finalTopCount}`,
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
// GET /results/:roundNumber — Get results (V4: from results table)
// ─────────────────────────────────────────────────────────────
router.get('/results/:roundNumber', requireAdmin, async (req, res) => {
    try {
        const roundNumber = parseInt(req.params.roundNumber);

        const { data: results, error } = await supabase
            .from('results')
            .select('*')
            .eq('round_number', roundNumber)
            .order('rank', { ascending: true, nullsFirst: false });

        if (error) throw error;

        // Fetch participant names from participant_details
        const { data: participants } = await supabase
            .from('participant_details')
            .select('attempt_token, name');

        const nameMap = {};
        if (participants) {
            participants.forEach(p => {
                if (p.attempt_token) nameMap[p.attempt_token] = p.name || 'Unknown';
            });
        }

        // Enrich results with participant names
        const enrichedResults = (results || []).map(r => ({
            ...r,
            participant_name: nameMap[r.attempt_token] || 'Unknown'
        }));

        const { data: auditLogs } = await supabase
            .from('audit_logs')
            .select('*')
            .eq('round_number', roundNumber)
            .order('created_at', { ascending: false });

        res.json({
            success: true,
            data: {
                results: enrichedResults,
                auditLogs: auditLogs || []
            }
        });
    } catch (error) {
        console.error('Results fetch error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch results' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /submissions/:roundNumber — Get submissions for a round
// ─────────────────────────────────────────────────────────────
router.get('/submissions/:roundNumber', requireAdmin, async (req, res) => {
    try {
        const roundNumber = parseInt(req.params.roundNumber);

        const { data: submissions, error } = await supabase
            .from('submissions')
            .select('*')
            .eq('round_number', roundNumber)
            .order('submitted_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            data: submissions || []
        });
    } catch (error) {
        console.error('Submissions fetch error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch submissions' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /participants — Get all submissions with results (V4)
// Returns submission data enriched with evaluation results
// ─────────────────────────────────────────────────────────────
router.get('/participants', requireAdmin, async (req, res) => {
    try {
        // Get all submissions
        const { data: submissions, error: subErr } = await supabase
            .from('submissions')
            .select('*')
            .order('submitted_at', { ascending: false })
            .limit(500);

        if (subErr) throw subErr;

        // Get all results for enrichment
        const { data: results, error: resErr } = await supabase
            .from('results')
            .select('attempt_token, round_number, score, rank, qualified_for_next')
            .limit(500);

        if (resErr) throw resErr;

        // Get participant names from participant_details
        const { data: participants } = await supabase
            .from('participant_details')
            .select('attempt_token, name');

        const nameMap = {};
        if (participants) {
            participants.forEach(p => {
                if (p.attempt_token) nameMap[p.attempt_token] = p.name || 'Unknown';
            });
        }

        // Build a lookup map: token_round -> result
        const resultMap = {};
        if (results) {
            results.forEach(r => {
                resultMap[`${r.attempt_token}_${r.round_number}`] = r;
            });
        }

        // Enrich submissions with results and participant names
        const enrichedParticipants = (submissions || []).map(s => {
            const key = `${s.attempt_token}_${s.round_number}`;
            const result = resultMap[key] || {};
            const answerCount = Array.isArray(s.answers) ? s.answers.length : 0;

            return {
                id: s.id,
                attempt_token: s.attempt_token,
                participant_name: nameMap[s.attempt_token] || 'Unknown',
                round_number: s.round_number,
                answer_count: answerCount,
                time_taken_seconds: s.time_taken_seconds,
                submitted_at: s.submitted_at,
                score: result.score !== undefined ? result.score : null,
                rank: result.rank || null,
                qualified_for_next: result.qualified_for_next || false
            };
        });

        res.json({
            success: true,
            data: enrichedParticipants,
            total: enrichedParticipants.length
        });
    } catch (error) {
        console.error('Participants fetch error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch participants' });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /audit-logs — Get audit logs
// ─────────────────────────────────────────────────────────────
router.get('/audit-logs', requireAdmin, async (req, res) => {
    try {
        const { data: logs, error } = await supabase
            .from('audit_logs')
            .select('*')
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
// GET /export/:roundNumber — Export results as CSV (V4)
// No personal data — only attempt_token, score, time, rank
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
            .from('results')
            .select('*')
            .eq('round_number', roundNumber)
            .order('rank', { ascending: true, nullsFirst: false });

        if (error) throw error;

        // Fetch participant names
        const { data: participants } = await supabase
            .from('participant_details')
            .select('attempt_token, name');

        const nameMap = {};
        if (participants) {
            participants.forEach(p => {
                if (p.attempt_token) nameMap[p.attempt_token] = p.name || 'Unknown';
            });
        }

        const csvRows = [
            ['Rank', 'Participant Name', 'Score', 'Time (sec)', 'Qualified']
        ];

        results?.forEach(r => {
            csvRows.push([
                r.rank || '-',
                nameMap[r.attempt_token] || 'Unknown',
                r.score,
                r.time_taken_seconds || '',
                r.qualified_for_next ? 'Yes' : 'No'
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
// POST /round/reset — Reset a specific round
// Clears submissions and results for the round, resets status to pending
// ─────────────────────────────────────────────────────────────
router.post('/round/reset', requireAdmin, async (req, res) => {
    try {
        const { roundNumber } = req.body;

        if (!roundNumber || isNaN(roundNumber)) {
            return res.status(400).json({ success: false, message: 'Invalid round number' });
        }

        // Get current event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        // Safety check: Can only reset current round or the immediate previous one if current is not started
        // Actually, for full control, let's allow resetting any round provided future rounds are not running? 
        // For simplicity: Allow resetting the 'current_round' pointer or any round >= current_round.

        // 1. Delete submissions for this round
        await supabase.from('submissions').delete().eq('round_number', roundNumber);

        // 2. Delete results for this round
        await supabase.from('results').delete().eq('round_number', roundNumber);

        // 3. Delete audit logs for this round (optional, but cleaner for a "hard reset")
        // await supabase.from('audit_logs').delete().eq('round_number', roundNumber);

        // 4. Reset round status in 'rounds' table
        await supabase
            .from('rounds')
            .update({
                status: 'pending',
                started_at: null,
                ended_at: null,
                shortlisting_completed: false
            })
            .eq('round_number', roundNumber);

        // 5. If this is the active current round, update event_state
        if (eventState.current_round === roundNumber) {
            await supabase
                .from('event_state')
                .update({
                    round_status: 'not_started',
                    round_started_at: null,
                    round_ends_at: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', 1);
        }

        auditLog(null, req.admin.id, 'ROUND_RESET', `Round ${roundNumber} has been reset`, roundNumber, req);

        res.json({ success: true, message: `Round ${roundNumber} reset successfully` });

    } catch (error) {
        console.error('Reset round error:', error);
        res.status(500).json({ success: false, message: 'Failed to reset round' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /reset-event — Reset entire event
// ─────────────────────────────────────────────────────────────
router.post('/reset-event', requireAdmin, async (req, res) => {
    try {
        // 1. Delete all submissions (safe delete)
        const { error: subError } = await supabase
            .from('submissions')
            .delete()
            .neq('id', -1); // Delete all rows
        if (subError) throw subError;

        // 2. Delete all results
        const { error: resError } = await supabase
            .from('results')
            .delete()
            .neq('id', -1);
        if (resError) throw resError;

        // 3. Reset rounds to pending
        const { error: roundError } = await supabase
            .from('rounds')
            .update({
                status: 'pending',
                started_at: null,
                ended_at: null,
                shortlisting_completed: false
            })
            .gt('round_number', 0);
        if (roundError) throw roundError;

        // 4. Reset event state
        const { error: eventError } = await supabase
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
        if (eventError) throw eventError;

        auditLog(null, req.admin.id, 'EVENT_RESET', 'Entire event has been reset', null, req);

        res.json({ success: true, message: 'Event has been fully reset' });
    } catch (error) {
        console.error('Reset event error:', error);
        res.status(500).json({ success: false, message: 'Failed to reset event' });
    }
});

module.exports = router;
