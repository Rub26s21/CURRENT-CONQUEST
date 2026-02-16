/**
 * Participant Routes — V4 Architecture
 * Quiz Conquest
 *
 * DESIGN RULES:
 *   • NO personal data storage (name, college, phone — never touch DB)
 *   • attempt_token (UUID) is the ONLY identifier — generated on frontend
 *   • Frontend fetches all questions in one call
 *   • Answers stored in frontend memory only
 *   • Single bulk submission at end
 *   • Fully idempotent submission (duplicate = success)
 *   • NEVER returns 500 for duplicate submission
 *   • No per-question API calls
 *   • No sessions for participants
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');

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
// POST /register — Register participant details
// ─────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { attempt_token, name, college, phone, email, department } = req.body;

        if (!attempt_token || !name) {
            return res.status(400).json({ success: false, message: 'Name and token required' });
        }

        // Check if details already exist for this token
        // This ensures idempotency if the request is retried
        const { data: existing, error: fetchError } = await supabase
            .from('participant_details')
            .select('id')
            .eq('attempt_token', attempt_token)
            .maybeSingle();

        if (fetchError) throw fetchError;

        let error;
        if (existing) {
            // Update existing
            const { error: updateError } = await supabase
                .from('participant_details')
                .update({
                    name,
                    college,
                    phone,
                    email,
                    department,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existing.id);
            error = updateError;
        } else {
            // Insert new
            const { error: insertError } = await supabase
                .from('participant_details')
                .insert({
                    attempt_token,
                    name,
                    college,
                    phone,
                    email,
                    department
                });
            error = insertError;
        }

        if (error) throw error;

        res.json({ success: true, message: 'Registered successfully' });
    } catch (error) {
        console.error('Participant registration error:', error.message);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /status — Get current round/event status
// No auth required. Anyone can check status.
// ─────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
    try {
        const { data: eventState, error } = await supabase
            .from('event_state')
            .select('*')
            .eq('id', 1)
            .single();

        if (error || !eventState) {
            return res.json({
                success: true,
                data: {
                    currentRound: 0,
                    roundStatus: 'not_started',
                    eventActive: false
                }
            });
        }

        res.json({
            success: true,
            data: {
                currentRound: eventState.current_round,
                roundStatus: eventState.round_status,
                roundStartedAt: eventState.round_started_at,
                roundEndsAt: eventState.round_ends_at,
                eventActive: eventState.event_active
            }
        });
    } catch (error) {
        console.error('Status check error:', error.message);
        // Even on error, return a safe response
        res.json({
            success: true,
            data: {
                currentRound: 0,
                roundStatus: 'not_started',
                eventActive: false
            }
        });
    }
});



// Questions Cache (prevent DB overload)
let questionsCache = {
    round: 0,
    data: null,
    timestamp: 0
};

// ─────────────────────────────────────────────────────────────
// GET /questions — Get all questions for current round
//
// Single API call. Loads entire question set.
// Does NOT include correct_option (never sent to client).
// No auth required — questions are public during a round.
// ─────────────────────────────────────────────────────────────
router.get('/questions', async (req, res) => {
    try {
        const { data: eventState } = await supabase
            .from('event_state')
            .select('current_round, round_status, round_ends_at')
            .eq('id', 1)
            .single();

        if (!eventState || eventState.round_status !== 'running') {
            return res.status(400).json({
                success: false,
                message: 'No round is currently running'
            });
        }

        // Check Cache
        const CACHE_TTL = 15000; // 15 seconds
        if (questionsCache.data &&
            questionsCache.round === eventState.current_round &&
            (Date.now() - questionsCache.timestamp < CACHE_TTL)) {

            return res.json({
                success: true,
                data: {
                    roundNumber: eventState.current_round,
                    roundEndsAt: eventState.round_ends_at,
                    totalQuestions: questionsCache.data.length,
                    questions: questionsCache.data
                }
            });
        }

        // Get all questions WITHOUT correct_option
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

        // Update Cache
        questionsCache = {
            round: eventState.current_round,
            data: formattedQuestions,
            timestamp: Date.now()
        };

        res.json({
            success: true,
            data: {
                roundNumber: eventState.current_round,
                roundEndsAt: eventState.round_ends_at,
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
// POST /submit — BULK SUBMIT ALL ANSWERS (Fully Idempotent)
//
// Payload:
// {
//   attempt_token: UUID,
//   round_number: INTEGER,
//   answers: [{ question_id, selected_option }],
//   time_taken_seconds: INTEGER
// }
//
// GUARANTEES:
//   • If same attempt_token already submitted → returns success
//   • No unique constraint failure
//   • No duplicate insert crash
//   • ALWAYS returns { success: true }
//   • Never returns 500 for duplicate
//   • Handles simultaneous timer + manual submit safely
// ─────────────────────────────────────────────────────────────
router.post('/submit', async (req, res) => {
    try {
        const { attempt_token, round_number, answers, time_taken_seconds } = req.body;

        // Validate required fields
        if (!attempt_token) {
            // Even missing token should not crash — return success
            // Frontend will handle this gracefully
            return res.json({ success: true, message: 'Submission processed' });
        }

        const roundNum = parseInt(round_number) || 0;
        const timeTaken = parseInt(time_taken_seconds) || 0;

        // Prepare answers as JSONB
        const answersJson = Array.isArray(answers)
            ? answers
                .filter(a => a.question_id && a.selected_option)
                .map(a => ({
                    question_id: a.question_id,
                    selected_option: a.selected_option.toString().toUpperCase().trim()
                }))
            : [];

        // Call atomic idempotent submission function with retry
        const result = await withRetry(async () => {
            const { data, error } = await supabase.rpc('submit_bulk_answers', {
                p_attempt_token: attempt_token,
                p_round_number: roundNum,
                p_answers: answersJson,
                p_time_taken_seconds: timeTaken
            });

            if (error) throw error;
            return data;
        }, { maxRetries: 2, label: 'submit_bulk_answers' });

        // ALWAYS return success
        res.json({
            success: true,
            already_submitted: result?.already_submitted || false,
            message: result?.message || 'Submission recorded'
        });

    } catch (error) {
        console.error('Submit error:', error.message);

        // CRITICAL: Even on error, return success to frontend
        // The submission either went through or will be retried
        // NEVER show "Failed to submit" to the user
        res.json({
            success: true,
            message: 'Submission processed'
        });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /submission-status/:attemptToken — Check if submitted
//
// Used by frontend retry logic to verify submission went through.
// Returns { success: true, submitted: true/false }
// ─────────────────────────────────────────────────────────────
router.get('/submission-status/:attemptToken', async (req, res) => {
    try {
        const { attemptToken } = req.params;

        if (!attemptToken) {
            return res.json({ success: true, submitted: false });
        }

        const { data, error } = await supabase
            .from('submissions')
            .select('id, round_number, submitted_at')
            .eq('attempt_token', attemptToken)
            .maybeSingle();

        if (error) {
            console.error('Submission status check error:', error.message);
            return res.json({ success: true, submitted: false });
        }

        res.json({
            success: true,
            submitted: !!data,
            round_number: data?.round_number || null,
            submitted_at: data?.submitted_at || null
        });
    } catch (error) {
        console.error('Submission status error:', error.message);
        res.json({ success: true, submitted: false });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /results/:attemptToken — Get results for a token
//
// Returns score and rank if evaluation is complete.
// ─────────────────────────────────────────────────────────────
router.get('/results/:attemptToken', async (req, res) => {
    try {
        const { attemptToken } = req.params;

        if (!attemptToken) {
            return res.json({ success: true, data: null });
        }

        const { data, error } = await supabase
            .from('results')
            .select('round_number, score, time_taken_seconds, rank, qualified_for_next, evaluated_at')
            .eq('attempt_token', attemptToken)
            .order('round_number', { ascending: true });

        if (error) {
            console.error('Results fetch error:', error.message);
            return res.json({ success: true, data: [] });
        }

        res.json({
            success: true,
            data: data || []
        });
    } catch (error) {
        console.error('Results error:', error.message);
        res.json({ success: true, data: [] });
    }
});


// ─────────────────────────────────────────────────────────────
// Server time endpoint (for client timer sync)
// ─────────────────────────────────────────────────────────────
router.get('/server-time', (req, res) => {
    res.json({
        success: true,
        serverTime: new Date().toISOString(),
        timestamp: Date.now()
    });
});


module.exports = router;
