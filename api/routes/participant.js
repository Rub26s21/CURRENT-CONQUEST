/**
 * Participant Routes — Production-Grade CBT Engine
 * Quiz Conquest v3.0
 *
 * DESIGN RULES:
 *   • Answers stored in frontend memory — bulk-inserted on submit only
 *   • NO per-question DB writes
 *   • NO score calculation on submit (scores calculated in finalize_round)
 *   • Tab switch: 1st = warning, 2nd = auto-submit + disqualify
 *   • Every mutation is idempotent
 *   • auditLog is fire-and-forget (never blocks response)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { supabase } = require('../config/database');
const { requireParticipant, auditLog } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────
// POST /login — Participant login
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

        // Check if event is active
        const { data: eventState } = await supabase
            .from('event_state')
            .select('event_active')
            .eq('id', 1)
            .single();

        if (!eventState?.event_active) {
            return res.status(403).json({
                success: false,
                message: 'Event is not active yet'
            });
        }

        // Check for existing participant by phone
        const { data: existing } = await supabase
            .from('participants')
            .select('*')
            .eq('phone_number', phoneNumber.trim())
            .single();

        let participant;

        if (existing) {
            // Returning participant
            if (existing.is_disqualified) {
                return res.status(403).json({
                    success: false,
                    message: 'You have been disqualified from this event'
                });
            }

            const sessionToken = uuidv4();
            await supabase
                .from('participants')
                .update({
                    session_token: sessionToken,
                    last_activity: new Date().toISOString()
                })
                .eq('id', existing.id);

            participant = existing;
            participant.session_token = sessionToken;
        } else {
            // New participant
            const systemId = 'QC-' + String(Math.floor(10000 + Math.random() * 90000));
            const sessionToken = uuidv4();

            const { data: newParticipant, error } = await supabase
                .from('participants')
                .insert({
                    system_id: systemId,
                    name: name.trim(),
                    college_name: collegeName.trim(),
                    phone_number: phoneNumber.trim(),
                    session_token: sessionToken,
                    is_active: true,
                    is_qualified: true,
                    is_disqualified: false,
                    current_round: 1
                })
                .select()
                .single();

            if (error) throw error;
            participant = newParticipant;
        }

        // Set session
        req.session.participantId = participant.id;
        req.session.systemId = participant.system_id;
        req.session.participantName = participant.name;

        auditLog(participant.id, null, 'PARTICIPANT_LOGIN', `${participant.name} logged in`, null, req);

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                systemId: participant.system_id,
                name: participant.name,
                collegeName: participant.college_name,
                currentRound: participant.current_round
            }
        });
    } catch (error) {
        console.error('Participant login error:', error);
        res.status(500).json({ success: false, message: 'Login failed' });
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
        console.error('Session check error:', error);
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
        console.error('Status check error:', error);
        res.status(500).json({ success: false, message: 'Status check failed' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /start-exam — Start exam session
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

        if (error) throw error;

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
        console.error('Start exam error:', error);
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
        console.error('Load questions error:', error);
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
        console.error('Load question error:', error);
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
// POST /submit-exam — Bulk submit all answers
//
// RULES:
//   • Idempotent: resubmit returns success without re-processing
//   • Bulk upsert into responses table
//   • NO score calculation (happens in finalize_round)
//   • 5-second grace window after round end
// ─────────────────────────────────────────────────────────────
router.post('/submit-exam', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;
        const { answers, submissionType } = req.body;
        const nowISO = new Date().toISOString();

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

        // Get exam session
        const { data: examSession } = await supabase
            .from('exam_sessions')
            .select('*')
            .eq('participant_id', participant.id)
            .eq('round_number', roundNumber)
            .single();

        if (!examSession) {
            return res.status(400).json({ success: false, message: 'No exam session found' });
        }

        // IDEMPOTENT: already submitted → return success
        if (examSession.is_submitted) {
            return res.json({
                success: true,
                message: 'Exam already submitted',
                alreadySubmitted: true
            });
        }

        // Grace window: allow submission up to 5 seconds after round end
        const roundEndTime = eventState.round_ends_at ? new Date(eventState.round_ends_at) : null;
        const graceMs = 5000;
        if (roundEndTime && Date.now() > roundEndTime.getTime() + graceMs) {
            // Round ended and grace period passed — still mark submitted
            // (finalize_round will handle via auto-submit)
        }

        // ── STEP 1: BULK UPSERT RESPONSES ────────────────────
        if (Array.isArray(answers) && answers.length > 0) {
            const rows = answers
                .filter(a => a.question_id && a.selected_option)
                .map(a => ({
                    participant_id: participant.id,
                    question_id: a.question_id,
                    round_number: roundNumber,
                    selected_option: a.selected_option.toUpperCase().trim(),
                    answered_at: nowISO
                }));

            if (rows.length > 0) {
                const { error: upsertError } = await supabase
                    .from('responses')
                    .upsert(rows, { onConflict: 'participant_id,question_id' });

                if (upsertError) {
                    console.error('Bulk upsert error:', upsertError);
                    throw upsertError;
                }
            }
        }

        // ── STEP 2: MARK SESSION AS SUBMITTED ─────────────────
        const timeTakenSeconds = Math.floor(
            (new Date(nowISO) - new Date(examSession.started_at)) / 1000
        );

        const validTypes = ['manual', 'auto_timer', 'auto_violation', 'auto_round_end'];
        const finalType = validTypes.includes(submissionType) ? submissionType : 'manual';

        const { error: sessionError } = await supabase
            .from('exam_sessions')
            .update({
                is_submitted: true,
                submitted_at: nowISO,
                submission_type: finalType,
                time_taken_seconds: timeTakenSeconds
            })
            .eq('id', examSession.id);

        if (sessionError) throw sessionError;

        auditLog(participant.id, null, 'EXAM_SUBMITTED',
            `Exam submitted (${finalType}) — ${(answers || []).length} answers, ${timeTakenSeconds}s`,
            roundNumber, req);

        res.json({
            success: true,
            message: 'Exam submitted successfully',
            data: {
                submissionType: finalType,
                answersRecorded: (answers || []).length,
                timeTakenSeconds
            }
        });

    } catch (error) {
        console.error('Submit exam error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit exam' });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /tab-switch — Report tab/window switch
//
// STRICT CBT RULES:
//   1st switch → Warning (audit logged)
//   2nd switch → Auto-submit + Disqualify
// ─────────────────────────────────────────────────────────────
router.post('/tab-switch', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;
        const { answers } = req.body;
        const nowISO = new Date().toISOString();

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

        // Get exam session
        const { data: examSession } = await supabase
            .from('exam_sessions')
            .select('*')
            .eq('participant_id', participant.id)
            .eq('round_number', roundNumber)
            .single();

        if (!examSession || examSession.is_submitted) {
            return res.json({
                success: true,
                data: { warning: false, autoSubmitted: false, tabSwitchCount: 0 }
            });
        }

        // Increment tab switch count
        const newCount = (examSession.tab_switch_count || 0) + 1;

        await supabase
            .from('exam_sessions')
            .update({ tab_switch_count: newCount })
            .eq('id', examSession.id);

        // ── 1st SWITCH: WARNING ───────────────────────────────
        if (newCount === 1) {
            auditLog(participant.id, null, 'TAB_SWITCH_WARNING',
                `1st tab switch — warning issued`, roundNumber, req);

            return res.json({
                success: true,
                data: {
                    warning: true,
                    autoSubmitted: false,
                    tabSwitchCount: newCount,
                    message: 'First warning: switching tabs again will result in disqualification'
                }
            });
        }

        // ── 2nd+ SWITCH: AUTO-SUBMIT + DISQUALIFY ─────────────
        // Step A: Bulk upsert answers (save what they had)
        if (Array.isArray(answers) && answers.length > 0) {
            const rows = answers
                .filter(a => a.question_id && a.selected_option)
                .map(a => ({
                    participant_id: participant.id,
                    question_id: a.question_id,
                    round_number: roundNumber,
                    selected_option: a.selected_option.toUpperCase().trim(),
                    answered_at: nowISO
                }));

            if (rows.length > 0) {
                await supabase
                    .from('responses')
                    .upsert(rows, { onConflict: 'participant_id,question_id' });
            }
        }

        // Step B: Mark session as submitted
        const timeTakenSeconds = Math.floor(
            (new Date(nowISO) - new Date(examSession.started_at)) / 1000
        );

        await supabase
            .from('exam_sessions')
            .update({
                is_submitted: true,
                submitted_at: nowISO,
                submission_type: 'auto_violation',
                time_taken_seconds: timeTakenSeconds
            })
            .eq('id', examSession.id);

        // Step C: Disqualify participant
        await supabase
            .from('participants')
            .update({
                is_disqualified: true,
                disqualification_reason: `Auto-disqualified: ${newCount} tab switches (violation limit = 2)`
            })
            .eq('id', participant.id);

        auditLog(participant.id, null, 'TAB_SWITCH_DISQUALIFY',
            `${newCount} tab switches — auto-submitted and disqualified`,
            roundNumber, req);

        return res.json({
            success: true,
            data: {
                warning: false,
                autoSubmitted: true,
                disqualified: true,
                tabSwitchCount: newCount,
                message: 'Disqualified due to tab switch violations'
            }
        });

    } catch (error) {
        console.error('Tab switch error:', error);
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
        console.error('Logout error:', error);
        res.status(500).json({ success: false, message: 'Logout failed' });
    }
});

module.exports = router;
