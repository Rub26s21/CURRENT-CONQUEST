/**
 * Participant Routes — Production-Grade CBT Engine (Hardened v3.1)
 * Quiz Conquest
 *
 * DESIGN RULES:
 *   • Answers stored in frontend memory — bulk-inserted on submit only
 *   • NO per-question DB writes
 *   • NO score calculation on submit (scores calculated in finalize_round)
 *   • Tab switch: 1st = warning, 2nd = auto-submit + disqualify
 *   • Every mutation is idempotent
 *   • auditLog is fire-and-forget (never blocks response)
 *
 * HARDENING (v3.1):
 *   • Registration uses atomic DB function with retry + UUID fallback
 *   • Submission uses atomic DB function (responses + session in 1 txn)
 *   • Tab switch uses atomic DB function (submit + disqualify in 1 txn)
 *   • All DB errors logged with context
 *   • Connection timeout handling on every call
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { requireParticipant, auditLog } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────
// HELPER: Retry wrapper for critical Supabase RPC calls
// Exponential backoff: 200ms → 400ms → 800ms
// ─────────────────────────────────────────────────────────────
async function withRetry(fn, { maxRetries = 2, label = 'DB call' } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = 200 * Math.pow(2, attempt);
                console.warn(`[RETRY] ${label} attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}


// ─────────────────────────────────────────────────────────────
// POST /login — Participant login (ATOMIC via DB function)
//
// Uses register_participant() RPC which:
//   • Checks event active status
//   • Handles returning participants (refreshes session)
//   • Generates unique system_id with retry + UUID fallback
//   • Blocks disqualified users
//   • Prevents race conditions on phone_number
// ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { name, collegeName, phoneNumber } = req.body;

        if (!name || !collegeName || !phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Name, college name, and phone number are required'
            });
        }

        // Call atomic registration function with retry
        const result = await withRetry(async () => {
            const { data, error } = await supabase.rpc('register_participant', {
                p_name: name.trim(),
                p_college_name: collegeName.trim(),
                p_phone_number: phoneNumber.trim()
            });

            if (error) throw error;
            return data;
        }, { maxRetries: 2, label: 'register_participant' });

        // Handle error responses from the DB function
        if (!result.success) {
            const statusMap = {
                'EVENT_INACTIVE': 403,
                'DISQUALIFIED': 403
            };
            return res.status(statusMap[result.code] || 400).json({
                success: false,
                message: result.message
            });
        }

        // Set session — use the session token from the DB
        req.session.participantId = result.participant_id;
        req.session.systemId = result.system_id;
        req.session.participantName = result.name;
        req.session.sessionToken = result.session_token;

        auditLog(
            result.participant_id, null,
            result.is_new ? 'PARTICIPANT_REGISTERED' : 'PARTICIPANT_LOGIN',
            `${result.name} ${result.is_new ? 'registered' : 'logged in'}`,
            null, req
        );

        res.json({
            success: true,
            message: result.is_new ? 'Registration successful' : 'Login successful',
            data: {
                systemId: result.system_id,
                name: result.name,
                collegeName: result.college_name,
                currentRound: result.current_round
            }
        });
    } catch (error) {
        console.error('Participant login error:', error.message, error.details || '');
        res.status(500).json({
            success: false,
            message: 'Registration failed. Please try again.'
        });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /session — Check participant session
// ─────────────────────────────────────────────────────────────
router.get('/session', async (req, res) => {
    try {
        if (!req.session?.participantId) {
            return res.json({ success: true, authenticated: false });
        }

        const { data: participant, error } = await supabase
            .from('participants')
            .select('*')
            .eq('id', req.session.participantId)
            .single();

        if (error || !participant) {
            if (req.session?.destroy) req.session.destroy(() => { });
            return res.json({ success: true, authenticated: false });
        }

        // Get current exam session for this participant
        const { data: eventState } = await supabase
            .from('event_state')
            .select('current_round')
            .eq('id', 1)
            .single();

        let examSession = null;
        if (eventState?.current_round > 0) {
            const { data: session } = await supabase
                .from('exam_sessions')
                .select('id, is_submitted, tab_switch_count')
                .eq('participant_id', participant.id)
                .eq('round_number', eventState.current_round)
                .single();
            examSession = session;
        }

        res.json({
            success: true,
            authenticated: true,
            data: {
                systemId: participant.system_id,
                name: participant.name,
                collegeName: participant.college_name,
                isQualified: participant.is_qualified,
                isDisqualified: participant.is_disqualified,
                disqualificationReason: participant.disqualification_reason,
                currentRound: participant.current_round,
                examSession: examSession ? {
                    isSubmitted: examSession.is_submitted,
                    tabSwitchCount: examSession.tab_switch_count
                } : null
            }
        });
    } catch (error) {
        console.error('Session check error:', error.message);
        res.status(500).json({ success: false, message: 'Session check failed' });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /status — Get exam/round status
// ─────────────────────────────────────────────────────────────
router.get('/status', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;

        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (!eventState) {
            return res.status(500).json({ success: false, message: 'Event state not found' });
        }

        // Get exam session if round is active
        let examSession = null;
        if (eventState.current_round > 0) {
            const { data: session } = await supabase
                .from('exam_sessions')
                .select('id, current_question_number, is_submitted, tab_switch_count')
                .eq('participant_id', participant.id)
                .eq('round_number', eventState.current_round)
                .single();
            examSession = session;
        }

        const canParticipate =
            participant.is_qualified &&
            !participant.is_disqualified &&
            participant.current_round <= eventState.current_round;

        res.json({
            success: true,
            data: {
                currentRound: eventState.current_round,
                roundStatus: eventState.round_status,
                roundEndsAt: eventState.round_ends_at,
                eventActive: eventState.event_active,
                isQualified: participant.is_qualified,
                isDisqualified: participant.is_disqualified,
                canParticipate,
                examSession: examSession ? {
                    sessionId: examSession.id,
                    currentQuestion: examSession.current_question_number,
                    isSubmitted: examSession.is_submitted,
                    tabSwitchCount: examSession.tab_switch_count
                } : null
            }
        });
    } catch (error) {
        console.error('Status check error:', error.message);
        res.status(500).json({ success: false, message: 'Status check failed' });
    }
});


// ─────────────────────────────────────────────────────────────
// POST /start-exam — Start exam session (idempotent)
// ─────────────────────────────────────────────────────────────
router.post('/start-exam', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;

        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (!eventState || eventState.round_status !== 'running') {
            return res.status(400).json({
                success: false,
                message: 'No round is currently running'
            });
        }

        if (participant.is_disqualified) {
            return res.status(403).json({ success: false, message: 'You are disqualified' });
        }

        if (!participant.is_qualified || participant.current_round > eventState.current_round) {
            return res.status(403).json({ success: false, message: 'Not qualified for this round' });
        }

        const roundNumber = eventState.current_round;

        // Check for existing session (idempotent)
        const { data: existingSession } = await supabase
            .from('exam_sessions')
            .select('*')
            .eq('participant_id', participant.id)
            .eq('round_number', roundNumber)
            .single();

        if (existingSession) {
            // Already started — return existing session
            return res.json({
                success: true,
                message: 'Exam session resumed',
                data: {
                    sessionId: existingSession.id,
                    roundNumber,
                    roundEndsAt: eventState.round_ends_at,
                    currentQuestion: existingSession.current_question_number,
                    tabSwitchCount: existingSession.tab_switch_count,
                    isSubmitted: existingSession.is_submitted
                }
            });
        }

        // Create new session
        const { data: newSession, error } = await supabase
            .from('exam_sessions')
            .insert({
                participant_id: participant.id,
                round_number: roundNumber,
                current_question_number: 1,
                is_submitted: false,
                tab_switch_count: 0
            })
            .select()
            .single();

        if (error) {
            // Handle race condition: session created by concurrent request
            if (error.code === '23505') { // unique_violation
                const { data: raceSession } = await supabase
                    .from('exam_sessions')
                    .select('*')
                    .eq('participant_id', participant.id)
                    .eq('round_number', roundNumber)
                    .single();

                if (raceSession) {
                    return res.json({
                        success: true,
                        message: 'Exam session resumed',
                        data: {
                            sessionId: raceSession.id,
                            roundNumber,
                            roundEndsAt: eventState.round_ends_at,
                            currentQuestion: raceSession.current_question_number,
                            tabSwitchCount: raceSession.tab_switch_count,
                            isSubmitted: raceSession.is_submitted
                        }
                    });
                }
            }
            throw error;
        }

        auditLog(participant.id, null, 'EXAM_STARTED',
            `Started exam for round ${roundNumber}`, roundNumber, req);

        res.json({
            success: true,
            message: 'Exam started',
            data: {
                sessionId: newSession.id,
                roundNumber,
                roundEndsAt: eventState.round_ends_at,
                currentQuestion: 1,
                tabSwitchCount: 0,
                isSubmitted: false
            }
        });
    } catch (error) {
        console.error('Start exam error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to start exam' });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /all-questions — Get all questions for current round
// Single API call, loaded into frontend memory
// ─────────────────────────────────────────────────────────────
router.get('/all-questions', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;

        const { data: eventState } = await supabase
            .from('event_state')
            .select('current_round, round_status')
            .eq('id', 1)
            .single();

        if (!eventState || eventState.round_status !== 'running') {
            return res.status(400).json({ success: false, message: 'No round running' });
        }

        // Verify participant has an active session
        const { data: session } = await supabase
            .from('exam_sessions')
            .select('id, is_submitted')
            .eq('participant_id', participant.id)
            .eq('round_number', eventState.current_round)
            .single();

        if (!session) {
            return res.status(400).json({ success: false, message: 'No exam session found' });
        }

        if (session.is_submitted) {
            return res.status(400).json({ success: false, message: 'Exam already submitted' });
        }

        // Get all questions (WITHOUT correct_option — never sent to client)
        const { data: questions, error } = await supabase
            .from('questions')
            .select('id, question_number, question_text, option_a, option_b, option_c, option_d')
            .eq('round_number', eventState.current_round)
            .order('question_number');

        if (error) throw error;

        const formattedQuestions = (questions || []).map(q => ({
            questionId: q.id,
            questionNumber: q.question_number,
            questionText: q.question_text,
            options: {
                A: q.option_a,
                B: q.option_b,
                C: q.option_c,
                D: q.option_d
            }
        }));

        res.json({
            success: true,
            data: {
                roundNumber: eventState.current_round,
                totalQuestions: formattedQuestions.length,
                questions: formattedQuestions
            }
        });
    } catch (error) {
        console.error('Load questions error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to load questions' });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /question/:questionNumber — Individual question fetch
// ─────────────────────────────────────────────────────────────
router.get('/question/:questionNumber', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;
        const questionNumber = parseInt(req.params.questionNumber);

        const { data: eventState } = await supabase
            .from('event_state')
            .select('current_round, round_status')
            .eq('id', 1)
            .single();

        if (!eventState || eventState.round_status !== 'running') {
            return res.status(400).json({ success: false, message: 'No round running' });
        }

        const { data: question, error } = await supabase
            .from('questions')
            .select('id, question_number, question_text, option_a, option_b, option_c, option_d')
            .eq('round_number', eventState.current_round)
            .eq('question_number', questionNumber)
            .single();

        if (error || !question) {
            return res.status(404).json({ success: false, message: 'Question not found' });
        }

        res.json({
            success: true,
            data: {
                questionId: question.id,
                questionNumber: question.question_number,
                questionText: question.question_text,
                options: {
                    A: question.option_a,
                    B: question.option_b,
                    C: question.option_c,
                    D: question.option_d
                }
            }
        });
    } catch (error) {
        console.error('Load question error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to load question' });
    }
});


// ─────────────────────────────────────────────────────────────
// POST /answer — NO-OP (answers stored in frontend memory)
// This endpoint exists only for backward compatibility.
// ─────────────────────────────────────────────────────────────
router.post('/answer', requireParticipant, (req, res) => {
    res.json({ success: true, message: 'Answer stored in memory' });
});


// ─────────────────────────────────────────────────────────────
// POST /submit-exam — Bulk submit all answers (ATOMIC via DB)
//
// Uses submit_exam_attempt() RPC which:
//   • Upserts all responses in ONE transaction
//   • Marks session as submitted in SAME transaction
//   • Idempotent: resubmit returns success without re-processing
//   • No partial writes: all-or-nothing
//   • 5-second grace window after round end
// ─────────────────────────────────────────────────────────────
router.post('/submit-exam', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;
        const { answers, submissionType } = req.body;

        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (!eventState) {
            return res.status(500).json({ success: false, message: 'Event state not found' });
        }

        const roundNumber = eventState.current_round;

        // Prepare answers as JSONB array
        const answersJson = Array.isArray(answers) ? answers
            .filter(a => a.question_id && a.selected_option)
            .map(a => ({
                question_id: a.question_id,
                selected_option: a.selected_option.toUpperCase().trim()
            })) : [];

        // Call atomic submission function with retry
        const result = await withRetry(async () => {
            const { data, error } = await supabase.rpc('submit_exam_attempt', {
                p_participant_id: participant.id,
                p_round_number: roundNumber,
                p_answers: answersJson,
                p_submission_type: submissionType || 'manual'
            });

            if (error) throw error;
            return data;
        }, { maxRetries: 1, label: 'submit_exam_attempt' });

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message || 'Submission failed'
            });
        }

        // Handle idempotent case
        if (result.already_submitted) {
            return res.json({
                success: true,
                message: 'Exam already submitted',
                alreadySubmitted: true
            });
        }

        auditLog(participant.id, null, 'EXAM_SUBMITTED',
            `Exam submitted (${result.submission_type}) — ${result.answers_recorded} answers, ${result.time_taken_seconds}s`,
            roundNumber, req);

        res.json({
            success: true,
            message: 'Exam submitted successfully',
            data: {
                submissionType: result.submission_type,
                answersRecorded: result.answers_recorded,
                timeTakenSeconds: result.time_taken_seconds
            }
        });

    } catch (error) {
        console.error('Submit exam error:', error.message, error.details || '');
        res.status(500).json({ success: false, message: 'Failed to submit exam' });
    }
});


// ─────────────────────────────────────────────────────────────
// POST /tab-switch — Report tab/window switch (ATOMIC via DB)
//
// Uses handle_tab_switch() RPC which:
//   • 1st switch → warning (audit logged)
//   • 2nd switch → auto-submit + disqualify (ONE transaction)
//   • No partial state possible
// ─────────────────────────────────────────────────────────────
router.post('/tab-switch', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;
        const { answers } = req.body;

        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('current_round, round_status')
            .eq('id', 1)
            .single();

        if (!eventState || eventState.round_status !== 'running') {
            return res.json({ success: true, data: { warning: false, autoSubmitted: false } });
        }

        const roundNumber = eventState.current_round;

        // Prepare answers for DB function
        const answersJson = Array.isArray(answers) ? answers
            .filter(a => a.question_id && a.selected_option)
            .map(a => ({
                question_id: a.question_id,
                selected_option: a.selected_option.toUpperCase().trim()
            })) : [];

        // Call atomic tab switch handler
        const { data: result, error } = await supabase.rpc('handle_tab_switch', {
            p_participant_id: participant.id,
            p_round_number: roundNumber,
            p_answers: answersJson
        });

        if (error) throw error;

        // Fire audit log
        if (result.warning) {
            auditLog(participant.id, null, 'TAB_SWITCH_WARNING',
                `1st tab switch — warning issued`, roundNumber, req);
        } else if (result.disqualified) {
            auditLog(participant.id, null, 'TAB_SWITCH_DISQUALIFY',
                `${result.tab_switch_count} tab switches — auto-submitted and disqualified`,
                roundNumber, req);
        }

        return res.json({
            success: true,
            data: result
        });

    } catch (error) {
        console.error('Tab switch error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to process tab switch' });
    }
});


// ─────────────────────────────────────────────────────────────
// POST /logout — Participant logout
// ─────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
    try {
        if (req.session?.participantId) {
            auditLog(req.session.participantId, null, 'PARTICIPANT_LOGOUT',
                'Participant logged out', null, req);
        }

        if (req.session?.destroy) {
            req.session.destroy(() => { });
        }

        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error.message);
        res.status(500).json({ success: false, message: 'Logout failed' });
    }
});

module.exports = router;
