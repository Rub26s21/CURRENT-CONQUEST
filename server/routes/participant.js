/**
 * Participant Routes
 * Quiz Conquest - ECE Professional Online Exam Platform
 * Optimized for 100+ concurrent participants
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { supabase, getEventState } = require('../config/database');
const { requireParticipant, auditLog } = require('../middleware/auth');

/**
 * POST /api/participant/login
 * Participant login/registration
 */
router.post('/login', async (req, res) => {
    try {
        const { name, collegeName, phoneNumber } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Name is required'
            });
        }

        if (!collegeName || !collegeName.trim()) {
            return res.status(400).json({
                success: false,
                message: 'College name is required'
            });
        }

        if (!phoneNumber || !phoneNumber.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        // Validate phone number format (10 digits)
        if (!/^[0-9]{10}$/.test(phoneNumber.trim())) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid 10-digit phone number'
            });
        }

        // Check if event is active
        const { data: eventState } = await supabase
            .from('event_state')
            .select('event_active, current_round, round_status')
            .eq('id', 1)
            .single();

        if (!eventState || !eventState.event_active) {
            return res.status(403).json({
                success: false,
                message: 'Event is not active yet. Please wait for the coordinator.'
            });
        }

        // Generate unique system ID
        const { data: systemIdResult } = await supabase.rpc('generate_participant_id');
        const systemId = systemIdResult || `QC-${Date.now().toString().slice(-5)}`;

        // Generate session token
        const sessionToken = uuidv4();

        // Create participant
        const { data: participant, error } = await supabase
            .from('participants')
            .insert({
                system_id: systemId,
                name: name.trim(),
                college_name: collegeName.trim(),
                phone_number: phoneNumber.trim(),
                session_token: sessionToken,
                is_active: true,
                is_qualified: true,
                current_round: 1
            })
            .select()
            .single();

        if (error) throw error;

        // Set session
        req.session.participantId = participant.id;
        req.session.systemId = systemId;
        req.session.isParticipant = true;

        auditLog(
            participant.id,
            null,
            'PARTICIPANT_LOGIN',
            `Participant ${name} from ${collegeName} logged in`,
            null,
            req
        );

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                systemId: participant.system_id,
                name: participant.name,
                currentRound: eventState.current_round,
                roundStatus: eventState.round_status
            }
        });
    } catch (error) {
        console.error('Participant login error:', error);
        res.status(500).json({
            success: false,
            message: 'Login failed. Please try again.'
        });
    }
});

/**
 * GET /api/participant/session
 * Check participant session status
 */
router.get('/session', async (req, res) => {
    try {
        if (!req.session || !req.session.participantId) {
            return res.json({
                success: true,
                authenticated: false
            });
        }

        // Verify participant still exists and is active
        const { data: participant, error } = await supabase
            .from('participants')
            .select('*')
            .eq('id', req.session.participantId)
            .eq('is_active', true)
            .single();

        if (error || !participant) {
            req.session.destroy();
            return res.json({
                success: true,
                authenticated: false
            });
        }

        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        // Get exam session if exists
        const { data: examSession } = await supabase
            .from('exam_sessions')
            .select('*')
            .eq('participant_id', participant.id)
            .eq('round_number', eventState.current_round)
            .single();

        res.json({
            success: true,
            authenticated: true,
            data: {
                systemId: participant.system_id,
                name: participant.name,
                isQualified: participant.is_qualified,
                isDisqualified: participant.is_disqualified,
                disqualificationReason: participant.disqualification_reason,
                currentRound: eventState.current_round,
                roundStatus: eventState.round_status,
                roundEndsAt: eventState.round_ends_at,
                examSession: examSession ? {
                    currentQuestion: examSession.current_question_number,
                    isSubmitted: examSession.is_submitted,
                    tabSwitchCount: examSession.tab_switch_count
                } : null
            }
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
 * GET /api/participant/status
 * Get current status (waiting screen polling)
 */
router.get('/status', requireParticipant, async (req, res) => {
    try {
        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        // Check if participant is qualified for current round
        const participant = req.participant;
        const canParticipate = participant.is_qualified &&
            !participant.is_disqualified &&
            participant.current_round <= eventState.current_round;

        // Get exam session if exists
        const { data: examSession } = await supabase
            .from('exam_sessions')
            .select('*')
            .eq('participant_id', participant.id)
            .eq('round_number', eventState.current_round)
            .single();

        res.json({
            success: true,
            data: {
                currentRound: eventState.current_round,
                roundStatus: eventState.round_status,
                roundEndsAt: eventState.round_ends_at,
                eventActive: eventState.event_active,
                canParticipate,
                isQualified: participant.is_qualified,
                participantRound: participant.current_round,
                examSession: examSession ? {
                    currentQuestion: examSession.current_question_number,
                    isSubmitted: examSession.is_submitted,
                    startedAt: examSession.started_at
                } : null
            }
        });
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({
            success: false,
            message: 'Status check failed'
        });
    }
});

/**
 * POST /api/participant/start-exam
 * Start exam for current round
 */
router.post('/start-exam', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;

        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        // Validate round is running
        if (eventState.round_status !== 'running') {
            return res.status(400).json({
                success: false,
                message: 'No round is currently running'
            });
        }

        // Check if qualified
        if (!participant.is_qualified || participant.is_disqualified) {
            return res.status(403).json({
                success: false,
                message: 'You are not qualified for this round'
            });
        }

        // Check if participant is eligible for this round
        if (participant.current_round > eventState.current_round) {
            return res.status(400).json({
                success: false,
                message: 'This round is not available for you'
            });
        }

        const roundNumber = eventState.current_round;

        // Check if exam session already exists
        const { data: existingSession } = await supabase
            .from('exam_sessions')
            .select('*')
            .eq('participant_id', participant.id)
            .eq('round_number', roundNumber)
            .single();

        if (existingSession) {
            // Return existing session
            if (existingSession.is_submitted) {
                return res.status(400).json({
                    success: false,
                    message: 'You have already submitted this exam'
                });
            }

            return res.json({
                success: true,
                message: 'Exam session resumed',
                data: {
                    sessionId: existingSession.id,
                    currentQuestion: existingSession.current_question_number,
                    roundNumber,
                    roundEndsAt: eventState.round_ends_at,
                    tabSwitchCount: existingSession.tab_switch_count
                }
            });
        }

        // Create new exam session
        const { data: newSession, error } = await supabase
            .from('exam_sessions')
            .insert({
                participant_id: participant.id,
                round_number: roundNumber,
                current_question_number: 1,
                started_at: new Date().toISOString(),
                tab_switch_count: 0
            })
            .select()
            .single();

        if (error) throw error;

        auditLog(
            participant.id,
            null,
            'EXAM_STARTED',
            `Participant started Round ${roundNumber} exam`,
            roundNumber,
            req
        );

        res.json({
            success: true,
            message: 'Exam started',
            data: {
                sessionId: newSession.id,
                currentQuestion: 1,
                roundNumber,
                roundEndsAt: eventState.round_ends_at,
                tabSwitchCount: 0
            }
        });
    } catch (error) {
        console.error('Start exam error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start exam'
        });
    }
});

/**
 * GET /api/participant/question/:questionNumber
 * Get a single question (NO correct answer sent)
 */
router.get('/question/:questionNumber', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;
        const questionNumber = parseInt(req.params.questionNumber);

        if (!questionNumber || questionNumber < 1 || questionNumber > 15) {
            return res.status(400).json({
                success: false,
                message: 'Invalid question number'
            });
        }

        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (eventState.round_status !== 'running') {
            return res.status(400).json({
                success: false,
                message: 'Round is not running'
            });
        }

        const roundNumber = eventState.current_round;

        // Verify exam session exists and not submitted
        const { data: examSession } = await supabase
            .from('exam_sessions')
            .select('*')
            .eq('participant_id', participant.id)
            .eq('round_number', roundNumber)
            .single();

        if (!examSession) {
            return res.status(400).json({
                success: false,
                message: 'Exam session not found. Please start exam first.'
            });
        }

        if (examSession.is_submitted) {
            return res.status(400).json({
                success: false,
                message: 'Exam already submitted'
            });
        }

        // Verify question number is valid (can only access current or previous)
        if (questionNumber > examSession.current_question_number) {
            return res.status(400).json({
                success: false,
                message: 'Cannot access future questions'
            });
        }

        // Get question WITHOUT correct answer
        const { data: question, error } = await supabase
            .from('questions')
            .select('id, question_number, question_text, option_a, option_b, option_c, option_d')
            .eq('round_number', roundNumber)
            .eq('question_number', questionNumber)
            .single();

        if (error || !question) {
            return res.status(404).json({
                success: false,
                message: 'Question not found'
            });
        }

        // Get previous response if any
        const { data: response } = await supabase
            .from('responses')
            .select('selected_option')
            .eq('participant_id', participant.id)
            .eq('question_id', question.id)
            .single();

        // Get count of answered questions for this round
        const { count: answeredCount } = await supabase
            .from('responses')
            .select('*', { count: 'exact', head: true })
            .eq('participant_id', participant.id)
            .eq('round_number', roundNumber)
            .not('selected_option', 'is', null);

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
                },
                selectedOption: response?.selected_option || null,
                totalQuestions: 15,
                currentQuestion: examSession.current_question_number,
                answeredCount: answeredCount || 0
            }
        });
    } catch (error) {
        console.error('Get question error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch question'
        });
    }
});

/**
 * GET /api/participant/all-questions
 * MNC STYLE: Return ALL questions for the current round in a single call
 * This enables instant client-side navigation with zero network latency
 */
router.get('/all-questions', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;

        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('current_round, round_status')
            .eq('id', 1)
            .single();

        if (!eventState || eventState.round_status !== 'running') {
            return res.status(400).json({
                success: false,
                message: 'Round is not running'
            });
        }

        const roundNumber = eventState.current_round;

        // Get exam session
        const { data: examSession } = await supabase
            .from('exam_sessions')
            .select('id, is_submitted')
            .eq('participant_id', participant.id)
            .eq('round_number', roundNumber)
            .single();

        if (!examSession) {
            return res.status(400).json({
                success: false,
                message: 'Exam session not found'
            });
        }

        if (examSession.is_submitted) {
            return res.status(400).json({
                success: false,
                message: 'Exam already submitted'
            });
        }

        // Get ALL questions for this round (without correct answers)
        const { data: questions, error } = await supabase
            .from('questions')
            .select('id, question_number, question_text, option_a, option_b, option_c, option_d')
            .eq('round_number', roundNumber)
            .order('question_number', { ascending: true });

        if (error) throw error;

        // Format questions for frontend
        const formattedQuestions = questions.map(q => ({
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
                questions: formattedQuestions,
                totalQuestions: formattedQuestions.length
            }
        });
    } catch (error) {
        console.error('Get all questions error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch questions'
        });
    }
});

/**
 * POST /api/participant/answer
 * DEPRECATED: Individual answer submission (kept for backward compatibility)
 * With bulk submission model, answers are stored client-side and sent all at once
 * This endpoint now just returns success immediately
 */
router.post('/answer', requireParticipant, (req, res) => {
    // With bulk submission, individual answers are stored client-side
    // This endpoint is kept for backward compatibility only
    res.json({
        success: true,
        message: 'Answer received (bulk submission in use)'
    });
});



/**
 * POST /api/participant/submit-exam
 * BULK SUBMISSION: Receive ALL answers at once, insert in single query
 * Responds immediately, score calculation happens in background
 */
router.post('/submit-exam', requireParticipant, async (req, res) => {
    const participant = req.participant;
    const { submissionType = 'manual', answers = [] } = req.body;
    const now = new Date();
    const nowISO = now.toISOString();

    try {
        // Get event state and exam session in parallel
        const [eventStateResult, examSessionResult] = await Promise.all([
            supabase.from('event_state').select('current_round, round_status, round_end_time').eq('id', 1).single(),
            supabase.from('exam_sessions').select('*').eq('participant_id', participant.id).order('created_at', { ascending: false }).limit(1).single()
        ]);

        const eventState = eventStateResult.data;
        const examSession = examSessionResult.data;
        const roundNumber = eventState?.current_round || 1;

        // IDEMPOTENT: If already submitted, return success immediately
        if (examSession?.is_submitted) {
            return res.json({
                success: true,
                message: 'Exam already submitted',
                alreadySubmitted: true
            });
        }

        // Grace window: Accept submissions up to 5 seconds after round end
        const roundEndTime = eventState?.round_end_time ? new Date(eventState.round_end_time) : null;
        const graceMs = 5000; // 5 second grace window
        if (roundEndTime && now > new Date(roundEndTime.getTime() + graceMs) && submissionType !== 'auto_timer') {
            return res.status(400).json({
                success: false,
                message: 'Round has ended'
            });
        }

        // Calculate time taken
        const startTime = examSession?.started_at ? new Date(examSession.started_at) : now;
        const timeTakenSeconds = Math.floor((now - startTime) / 1000);

        // CRITICAL: Update exam session as submitted FIRST (fast response)
        const { error: sessionError } = await supabase
            .from('exam_sessions')
            .update({
                is_submitted: true,
                submitted_at: nowISO,
                submission_type: submissionType,
                time_taken_seconds: timeTakenSeconds
            })
            .eq('id', examSession.id);

        if (sessionError) throw sessionError;

        // RESPOND IMMEDIATELY TO CLIENT
        res.json({
            success: true,
            message: 'Exam submitted successfully',
            data: { timeTakenSeconds, submissionType }
        });

        // ============================================================
        // ALL HEAVY OPERATIONS RUN IN BACKGROUND (non-blocking)
        // ============================================================
        setImmediate(async () => {
            try {
                // 1. BULK INSERT ALL ANSWERS (single query)
                if (answers && answers.length > 0) {
                    // Get all questions for this round to check correct answers
                    const { data: questions } = await supabase
                        .from('questions')
                        .select('id, correct_option')
                        .eq('round_number', roundNumber);

                    const questionMap = {};
                    if (questions) {
                        questions.forEach(q => { questionMap[q.id] = q.correct_option; });
                    }

                    // Prepare bulk insert data with correct answer checking
                    const responsesToInsert = answers.map(ans => {
                        const correctOption = questionMap[ans.question_id];
                        const selectedOption = ans.selected_option?.toUpperCase() || null;
                        const isCorrect = selectedOption && correctOption ? selectedOption === correctOption : null;

                        return {
                            participant_id: participant.id,
                            question_id: ans.question_id,
                            round_number: roundNumber,
                            selected_option: selectedOption,
                            is_correct: isCorrect,
                            answered_at: nowISO
                        };
                    });

                    // SINGLE BULK UPSERT (much faster than individual inserts)
                    await supabase
                        .from('responses')
                        .upsert(responsesToInsert, { onConflict: 'participant_id,question_id' });
                }

                // 2. Calculate and store score (background)
                const { data: responses } = await supabase
                    .from('responses')
                    .select('is_correct')
                    .eq('participant_id', participant.id)
                    .eq('round_number', roundNumber);

                const correctAnswers = responses?.filter(r => r.is_correct === true).length || 0;

                // Update exam session with score
                await supabase
                    .from('exam_sessions')
                    .update({ correct_answers: correctAnswers })
                    .eq('id', examSession.id);

                // 3. Update participant last activity (background)
                supabase.from('participants')
                    .update({ last_activity: nowISO })
                    .eq('id', participant.id)
                    .then(() => { });

                // 4. Audit log (fire-and-forget)
                auditLog(
                    participant.id,
                    null,
                    'EXAM_SUBMITTED',
                    `Exam submitted (${submissionType}) for Round ${roundNumber} - Score: ${correctAnswers}/15`,
                    roundNumber,
                    req,
                    { timeTakenSeconds, submissionType, score: correctAnswers }
                );

            } catch (bgError) {
                console.error('Background submission processing error:', bgError);
            }
        });

    } catch (error) {
        console.error('Submit exam error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit exam'
        });
    }
});

/**
 * POST /api/participant/tab-switch
 * Report tab switch violation - includes answers for potential auto-submit
 */
router.post('/tab-switch', requireParticipant, async (req, res) => {
    try {
        const participant = req.participant;
        const { violationType = 'tab_switch', answers = [] } = req.body;
        const now = new Date();
        const nowISO = now.toISOString();

        // Get event state
        const { data: eventState } = await supabase
            .from('event_state')
            .select('current_round, round_status')
            .eq('id', 1)
            .single();

        if (eventState.round_status !== 'running') {
            return res.json({
                success: true,
                message: 'Round not running, violation ignored'
            });
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
                message: 'No active session'
            });
        }

        const newTabSwitchCount = (examSession.tab_switch_count || 0) + 1;
        const shouldAutoSubmit = newTabSwitchCount >= 2;

        // Update tab switch count
        await supabase
            .from('exam_sessions')
            .update({
                tab_switch_count: newTabSwitchCount
            })
            .eq('id', examSession.id);

        // Audit log (fire-and-forget)
        auditLog(
            participant.id,
            null,
            'TAB_SWITCH_VIOLATION',
            `Tab switch violation #${newTabSwitchCount} (${violationType})`,
            roundNumber,
            req,
            { violationType, count: newTabSwitchCount }
        );

        if (shouldAutoSubmit) {
            // Auto-submit the exam with BULK answers
            const startTime = new Date(examSession.started_at);
            const timeTakenSeconds = Math.floor((now - startTime) / 1000);

            await supabase
                .from('exam_sessions')
                .update({
                    is_submitted: true,
                    submitted_at: nowISO,
                    submission_type: 'auto_violation',
                    time_taken_seconds: timeTakenSeconds
                })
                .eq('id', examSession.id);

            // Respond immediately
            res.json({
                success: true,
                data: {
                    tabSwitchCount: newTabSwitchCount,
                    warning: false,
                    autoSubmitted: true
                }
            });

            // Process bulk answers in background
            setImmediate(async () => {
                try {
                    if (answers && answers.length > 0) {
                        // Get all questions for this round
                        const { data: questions } = await supabase
                            .from('questions')
                            .select('id, correct_option')
                            .eq('round_number', roundNumber);

                        const questionMap = {};
                        if (questions) {
                            questions.forEach(q => { questionMap[q.id] = q.correct_option; });
                        }

                        // Prepare bulk insert data
                        const responsesToInsert = answers.map(ans => {
                            const correctOption = questionMap[ans.question_id];
                            const selectedOption = ans.selected_option?.toUpperCase() || null;
                            const isCorrect = selectedOption && correctOption ? selectedOption === correctOption : null;

                            return {
                                participant_id: participant.id,
                                question_id: ans.question_id,
                                round_number: roundNumber,
                                selected_option: selectedOption,
                                is_correct: isCorrect,
                                answered_at: nowISO
                            };
                        });

                        // Bulk upsert
                        await supabase
                            .from('responses')
                            .upsert(responsesToInsert, { onConflict: 'participant_id,question_id' });

                        // Calculate score
                        const { data: responses } = await supabase
                            .from('responses')
                            .select('is_correct')
                            .eq('participant_id', participant.id)
                            .eq('round_number', roundNumber);

                        const correctAnswers = responses?.filter(r => r.is_correct === true).length || 0;

                        await supabase
                            .from('exam_sessions')
                            .update({ correct_answers: correctAnswers })
                            .eq('id', examSession.id);
                    }

                    auditLog(
                        participant.id,
                        null,
                        'AUTO_SUBMIT_VIOLATION',
                        `Exam auto-submitted due to tab switch violations`,
                        roundNumber,
                        req
                    );
                } catch (bgError) {
                    console.error('Background violation submit error:', bgError);
                }
            });
        } else {
            res.json({
                success: true,
                data: {
                    tabSwitchCount: newTabSwitchCount,
                    warning: newTabSwitchCount === 1,
                    autoSubmitted: false
                }
            });
        }
    } catch (error) {
        console.error('Tab switch error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to record violation'
        });
    }
});

/**
 * POST /api/participant/logout
 * Participant logout (only when not in exam)
 */
router.post('/logout', async (req, res) => {
    try {
        if (req.session) {
            req.session.destroy();
        }
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            success: false,
            message: 'Logout failed'
        });
    }
});

module.exports = router;
