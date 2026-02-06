/**
 * Admin Routes
 * Quiz Conquest - ECE Professional Online Exam Platform
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { supabase } = require('../config/database');
const { requireAdmin, auditLog } = require('../middleware/auth');

/**
 * POST /api/admin/login
 * Admin login with username and password
 */
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password are required'
            });
        }

        // Check against environment variables first (primary admin)
        // Check against environment variables first (primary admin)
        const envUsername = (process.env.ADMIN_USERNAME || '').trim();
        const envPassword = (process.env.ADMIN_PASSWORD || '').trim();

        if (username.trim() === envUsername && password.trim() === envPassword) {
            // Check if admin exists in DB, if not create
            let adminId;
            const { data: existingAdmin } = await supabase
                .from('admins')
                .select('id')
                .eq('username', username)
                .single();

            if (existingAdmin) {
                adminId = existingAdmin.id;
                // Update last login
                await supabase
                    .from('admins')
                    .update({ last_login: new Date().toISOString() })
                    .eq('id', adminId);
            } else {
                // Create admin record
                const passwordHash = await bcrypt.hash(password, 10);
                const { data: newAdmin, error } = await supabase
                    .from('admins')
                    .insert({
                        username: username,
                        password_hash: passwordHash,
                        last_login: new Date().toISOString()
                    })
                    .select('id')
                    .single();

                if (error) throw error;
                adminId = newAdmin.id;
            }

            // Set session
            req.session.adminId = adminId;
            req.session.adminUsername = username;
            req.session.isAdmin = true;

            await auditLog(null, adminId, 'ADMIN_LOGIN', 'Admin logged in successfully', null, req);

            return res.json({
                success: true,
                message: 'Login successful',
                admin: { username }
            });
        }

        // Check database for other admins - DISABLED
        // Only the configured admin user can login
        return res.status(401).json({
            success: false,
            message: 'Invalid credentials'
        });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({
            success: false,
            message: 'Login failed'
        });
    }
});

/**
 * POST /api/admin/logout
 * Admin logout
 */
router.post('/logout', requireAdmin, async (req, res) => {
    try {
        await auditLog(null, req.admin.id, 'ADMIN_LOGOUT', 'Admin logged out', null, req);
        req.session.destroy();
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (error) {
        console.error('Admin logout error:', error);
        res.status(500).json({
            success: false,
            message: 'Logout failed'
        });
    }
});

/**
 * GET /api/admin/session
 * Check admin session status
 */
router.get('/session', async (req, res) => {
    try {
        if (!req.session || !req.session.adminId) {
            return res.json({
                success: true,
                authenticated: false
            });
        }

        // Verify admin still exists
        const { data: admin, error } = await supabase
            .from('admins')
            .select('id, username')
            .eq('id', req.session.adminId)
            .single();

        if (error || !admin) {
            req.session.destroy();
            return res.json({
                success: true,
                authenticated: false
            });
        }

        res.json({
            success: true,
            authenticated: true,
            admin: { username: admin.username }
        });
    } catch (error) {
        console.error('Session check error:', error);
        res.status(500).json({
            success: false,
            message: 'Session check failed'
        });
    }
});

/**
 * GET /api/admin/dashboard
 * Get dashboard data
 */
router.get('/dashboard', requireAdmin, async (req, res) => {
    try {
        // Get event state
        const { data: eventState, error: eventError } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (eventError) throw eventError;

        // Get participant counts
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

        // Get question counts per round
        const { data: questionCounts } = await supabase
            .from('questions')
            .select('round_number');

        const questionsPerRound = {
            1: questionCounts?.filter(q => q.round_number === 1).length || 0,
            2: questionCounts?.filter(q => q.round_number === 2).length || 0,
            3: questionCounts?.filter(q => q.round_number === 3).length || 0
        };

        // Get rounds data
        const { data: rounds } = await supabase
            .from('rounds')
            .select('*')
            .order('round_number');

        // Get submitted count for current round
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
                    submittedCurrentRound: submittedCount
                },
                questionsPerRound,
                rounds: rounds || []
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch dashboard data'
        });
    }
});

/**
 * POST /api/admin/event/activate
 * Activate the event
 */
router.post('/event/activate', requireAdmin, async (req, res) => {
    try {
        const { error } = await supabase
            .from('event_state')
            .update({
                event_active: true,
                updated_at: new Date().toISOString()
            })
            .eq('id', 1);

        if (error) throw error;

        await auditLog(null, req.admin.id, 'EVENT_ACTIVATED', 'Event has been activated', null, req);

        res.json({
            success: true,
            message: 'Event activated successfully'
        });
    } catch (error) {
        console.error('Event activation error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to activate event'
        });
    }
});

/**
 * POST /api/admin/round/start
 * Start a round
 */
router.post('/round/start', requireAdmin, async (req, res) => {
    try {
        const { roundNumber } = req.body;

        if (!roundNumber || roundNumber < 1 || roundNumber > 3) {
            return res.status(400).json({
                success: false,
                message: 'Invalid round number'
            });
        }

        // Check if event is active
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (!eventState.event_active) {
            return res.status(400).json({
                success: false,
                message: 'Event must be activated first'
            });
        }

        // Check if previous rounds are completed
        if (roundNumber > 1) {
            const { data: previousRound } = await supabase
                .from('rounds')
                .select('*')
                .eq('round_number', roundNumber - 1)
                .single();

            if (previousRound.status !== 'completed' || !previousRound.shortlisting_completed) {
                return res.status(400).json({
                    success: false,
                    message: `Round ${roundNumber - 1} must be completed and shortlisted first`
                });
            }
        }

        // Check if 15 questions exist for this round
        const { count: questionCount } = await supabase
            .from('questions')
            .select('*', { count: 'exact', head: true })
            .eq('round_number', roundNumber);

        if (questionCount < 15) {
            return res.status(400).json({
                success: false,
                message: `Round ${roundNumber} requires exactly 15 questions. Currently has ${questionCount}.`
            });
        }

        // Get round duration
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
            .update({
                status: 'active',
                started_at: now.toISOString()
            })
            .eq('round_number', roundNumber);

        if (roundError) throw roundError;

        await auditLog(null, req.admin.id, 'ROUND_STARTED', `Round ${roundNumber} has been started`, roundNumber, req);

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
        res.status(500).json({
            success: false,
            message: 'Failed to start round'
        });
    }
});

/**
 * POST /api/admin/round/end
 * End current round
 */
router.post('/round/end', requireAdmin, async (req, res) => {
    try {
        // Get current event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (eventState.round_status !== 'running') {
            return res.status(400).json({
                success: false,
                message: 'No round is currently running'
            });
        }

        const roundNumber = eventState.current_round;

        // Auto-submit all pending exams
        const now = new Date();
        const { data: pendingSessions } = await supabase
            .from('exam_sessions')
            .select('id, participant_id, started_at')
            .eq('round_number', roundNumber)
            .eq('is_submitted', false);

        if (pendingSessions && pendingSessions.length > 0) {
            for (const session of pendingSessions) {
                const timeTaken = Math.floor((now - new Date(session.started_at)) / 1000);
                await supabase
                    .from('exam_sessions')
                    .update({
                        is_submitted: true,
                        submitted_at: now.toISOString(),
                        submission_type: 'auto_timer',
                        time_taken_seconds: timeTaken
                    })
                    .eq('id', session.id);

                await auditLog(
                    session.participant_id,
                    null,
                    'AUTO_SUBMIT_ADMIN',
                    'Exam auto-submitted by admin ending round',
                    roundNumber,
                    req
                );
            }
        }

        // Update event state
        await supabase
            .from('event_state')
            .update({
                round_status: 'completed',
                updated_at: now.toISOString()
            })
            .eq('id', 1);

        // Update round status
        await supabase
            .from('rounds')
            .update({
                status: 'completed',
                ended_at: now.toISOString()
            })
            .eq('round_number', roundNumber);

        await auditLog(null, req.admin.id, 'ROUND_ENDED', `Round ${roundNumber} has been ended`, roundNumber, req);

        res.json({
            success: true,
            message: `Round ${roundNumber} ended successfully`,
            autoSubmitted: pendingSessions?.length || 0
        });
    } catch (error) {
        console.error('Round end error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end round'
        });
    }
});

/**
 * POST /api/admin/round/shortlist
 * Perform shortlisting for a completed round
 */
router.post('/round/shortlist', requireAdmin, async (req, res) => {
    try {
        const { roundNumber } = req.body;

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

        if (round.shortlisting_completed) {
            return res.status(400).json({
                success: false,
                message: 'Shortlisting already completed for this round'
            });
        }

        // Calculate scores first
        const { error: scoreError } = await supabase.rpc('calculate_round_scores', {
            p_round_number: roundNumber
        });

        if (scoreError) {
            console.error('Score calculation error:', scoreError);
            throw scoreError;
        }

        // Perform shortlisting
        const { data: result, error: shortlistError } = await supabase.rpc('perform_shortlisting', {
            p_round_number: roundNumber
        });

        if (shortlistError) {
            console.error('Shortlisting error:', shortlistError);
            throw shortlistError;
        }

        await auditLog(
            null,
            req.admin.id,
            'SHORTLISTING_COMPLETED',
            `Round ${roundNumber} shortlisting completed`,
            roundNumber,
            req,
            result
        );

        res.json({
            success: true,
            message: `Shortlisting completed for Round ${roundNumber}`,
            data: result
        });
    } catch (error) {
        console.error('Shortlisting error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to perform shortlisting'
        });
    }
});

/**
 * GET /api/admin/results/:roundNumber
 * Get results for a round
 */
router.get('/results/:roundNumber', requireAdmin, async (req, res) => {
    try {
        const roundNumber = parseInt(req.params.roundNumber);

        // Get scores with participant details
        const { data: results, error } = await supabase
            .from('scores')
            .select(`
                *,
                participants:participant_id (
                    system_id,
                    name,
                    college_name,
                    phone_number
                )
            `)
            .eq('round_number', roundNumber)
            .order('rank');

        if (error) throw error;

        // Get audit logs for this round
        const { data: auditLogs } = await supabase
            .from('audit_logs')
            .select(`
                *,
                participants:participant_id (
                    system_id,
                    name
                )
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
        res.status(500).json({
            success: false,
            message: 'Failed to fetch results'
        });
    }
});

/**
 * GET /api/admin/participants
 * Get all participants
 */
router.get('/participants', requireAdmin, async (req, res) => {
    try {
        const { data: participants, error } = await supabase
            .from('participants')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            data: participants || []
        });
    } catch (error) {
        console.error('Participants fetch error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch participants'
        });
    }
});

/**
 * GET /api/admin/audit-logs
 * Get all audit logs
 */
router.get('/audit-logs', requireAdmin, async (req, res) => {
    try {
        const { data: logs, error } = await supabase
            .from('audit_logs')
            .select(`
                *,
                participants:participant_id (
                    system_id,
                    name
                )
            `)
            .order('created_at', { ascending: false })
            .limit(500);

        if (error) throw error;

        res.json({
            success: true,
            data: logs || []
        });
    } catch (error) {
        console.error('Audit logs fetch error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch audit logs'
        });
    }
});

/**
 * GET /api/admin/export/:roundNumber
 * Export results as CSV
 */
router.get('/export/:roundNumber', requireAdmin, async (req, res) => {
    try {
        const roundNumber = parseInt(req.params.roundNumber);

        // Check if any round is currently running
        const { data: eventState } = await supabase
            .from('event_state')
            .select('round_status')
            .eq('id', 1)
            .single();

        if (eventState.round_status === 'running') {
            return res.status(400).json({
                success: false,
                message: 'Cannot export while a round is running'
            });
        }

        // Get results with participant details
        const { data: results, error } = await supabase
            .from('scores')
            .select(`
                *,
                participants:participant_id (
                    system_id,
                    name,
                    college_name,
                    phone_number
                )
            `)
            .eq('round_number', roundNumber)
            .order('rank');

        if (error) throw error;

        // Get exam session data for violation info
        const { data: sessions } = await supabase
            .from('exam_sessions')
            .select('participant_id, tab_switch_count, submission_type')
            .eq('round_number', roundNumber);

        const sessionMap = {};
        sessions?.forEach(s => {
            sessionMap[s.participant_id] = s;
        });

        // Generate CSV
        const csvRows = [
            ['Rank', 'System ID', 'Name', 'College', 'Phone', 'Score', 'Time (seconds)', 'Tab Switches', 'Submission Type', 'Qualified']
        ];

        results?.forEach(r => {
            const session = sessionMap[r.participant_id] || {};
            csvRows.push([
                r.rank,
                r.participants?.system_id || '',
                r.participants?.name || '',
                r.participants?.college_name || '',
                r.participants?.phone_number || '',
                r.correct_answers,
                r.time_taken_seconds || '',
                session.tab_switch_count || 0,
                session.submission_type || '',
                r.qualified_for_next ? 'Yes' : 'No'
            ]);
        });

        const csvContent = csvRows.map(row =>
            row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
        ).join('\n');

        await auditLog(null, req.admin.id, 'RESULTS_EXPORTED', `Round ${roundNumber} results exported`, roundNumber, req);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="round_${roundNumber}_results.csv"`);
        res.send(csvContent);
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to export results'
        });
    }
});

/**
 * POST /api/admin/reset-event
 * Reset entire event (USE WITH CAUTION)
 */
router.post('/reset-event', requireAdmin, async (req, res) => {
    try {
        const { confirmReset } = req.body;

        if (confirmReset !== 'RESET_ALL_DATA') {
            return res.status(400).json({
                success: false,
                message: 'Invalid confirmation code'
            });
        }

        // Reset in order due to foreign keys
        await supabase.from('audit_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('scores').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('responses').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('exam_sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await supabase.from('questions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
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

        res.json({
            success: true,
            message: 'Event reset successfully'
        });
    } catch (error) {
        console.error('Reset error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset event'
        });
    }
});

/**
 * POST /api/admin/round/update
 * Update round settings (duration)
 */
router.post('/round/update', requireAdmin, async (req, res) => {
    try {
        const { roundNumber, durationMinutes } = req.body;
        console.log('Update round request:', { roundNumber, durationMinutes });

        if (!roundNumber || !durationMinutes) {
            return res.status(400).json({
                success: false,
                message: 'Round number and duration are required'
            });
        }

        const { error } = await supabase
            .from('rounds')
            .update({
                duration_minutes: parseInt(durationMinutes)
            })
            .eq('round_number', roundNumber);

        if (error) throw error;

        await auditLog(null, req.admin.id, 'ROUND_UPDATED', `Round ${roundNumber} settings updated`, { durationMinutes }, req);

        res.json({
            success: true,
            message: 'Round settings updated successfully'
        });
    } catch (error) {
        console.error('Update round error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update round settings'
        });
    }
});

module.exports = router;
