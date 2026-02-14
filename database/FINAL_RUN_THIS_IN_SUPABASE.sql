-- ============================================================
-- QUIZ CONQUEST — PRODUCTION DATABASE SCHEMA
-- Version: 3.0 (Full Refactor)
-- ============================================================
--
-- SAFE TO RUN on fresh OR existing databases.
--
-- KEY DESIGN DECISIONS:
--   • Scoring compares responses.selected_option to questions.correct_option
--     (NEVER relies on responses.is_correct)
--   • Qualification = Top 25 per round (not percentage)
--   • Disqualified participants are EXCLUDED from ranking
--   • finalize_round() is a single atomic function for both
--     timer-end and admin-end (prevents race conditions)
--   • Every critical function is idempotent
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE: admins
-- ============================================================
CREATE TABLE IF NOT EXISTS admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);

-- ============================================================
-- TABLE: event_state  (Singleton — exactly 1 row, id=1)
-- ============================================================
CREATE TABLE IF NOT EXISTS event_state (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    current_round INTEGER DEFAULT 0,
    round_status VARCHAR(20) DEFAULT 'not_started'
        CHECK (round_status IN ('not_started', 'running', 'completed')),
    round_started_at TIMESTAMPTZ,
    round_ends_at TIMESTAMPTZ,
    event_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO event_state (id, current_round, round_status, event_active)
VALUES (1, 0, 'not_started', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- TABLE: rounds
-- ============================================================
CREATE TABLE IF NOT EXISTS rounds (
    id SERIAL PRIMARY KEY,
    round_number INTEGER UNIQUE NOT NULL CHECK (round_number BETWEEN 1 AND 3),
    total_questions INTEGER DEFAULT 15,
    duration_minutes INTEGER DEFAULT 15,
    top_qualify_count INTEGER DEFAULT 25,
    qualification_percentage DECIMAL(5,2) DEFAULT 50.00,
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'completed')),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    shortlisting_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add top_qualify_count if missing on existing DB
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS top_qualify_count INTEGER DEFAULT 25;

INSERT INTO rounds (round_number, qualification_percentage, top_qualify_count) VALUES
    (1, 50.00, 25),
    (2, 50.00, 25),
    (3, 100.00, 25)
ON CONFLICT (round_number) DO UPDATE SET top_qualify_count = EXCLUDED.top_qualify_count;

-- ============================================================
-- TABLE: participants
-- ============================================================
CREATE TABLE IF NOT EXISTS participants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    system_id VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    college_name VARCHAR(150),
    phone_number VARCHAR(20),
    session_token VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    current_round INTEGER DEFAULT 1,
    is_qualified BOOLEAN DEFAULT TRUE,
    is_disqualified BOOLEAN DEFAULT FALSE,
    disqualification_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add columns if they don't exist
ALTER TABLE participants ADD COLUMN IF NOT EXISTS college_name VARCHAR(150);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS session_token VARCHAR(255);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_qualified BOOLEAN DEFAULT TRUE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_disqualified BOOLEAN DEFAULT FALSE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS disqualification_reason TEXT;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS current_round INTEGER DEFAULT 1;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ DEFAULT NOW();

UPDATE participants SET is_active = TRUE WHERE is_active IS NULL;
UPDATE participants SET is_qualified = TRUE WHERE is_qualified IS NULL;
UPDATE participants SET is_disqualified = FALSE WHERE is_disqualified IS NULL;
UPDATE participants SET current_round = 1 WHERE current_round IS NULL;

-- Legacy column safety
DO $$ BEGIN
    ALTER TABLE participants ALTER COLUMN college_or_phone DROP NOT NULL;
EXCEPTION WHEN undefined_column THEN NULL; WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_participants_system_id ON participants(system_id);
CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_token);
CREATE INDEX IF NOT EXISTS idx_participants_qualified ON participants(is_qualified, current_round);
CREATE INDEX IF NOT EXISTS idx_participants_disqualified ON participants(is_disqualified);

-- ============================================================
-- TABLE: questions
-- ============================================================
CREATE TABLE IF NOT EXISTS questions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_number INTEGER NOT NULL REFERENCES rounds(round_number),
    question_number INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT NOT NULL,
    option_d TEXT NOT NULL,
    correct_option CHAR(1) NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(round_number, question_number)
);

CREATE INDEX IF NOT EXISTS idx_questions_round ON questions(round_number, question_number);

-- ============================================================
-- TABLE: responses  (participant answers — bulk-inserted on submit)
-- ============================================================
CREATE TABLE IF NOT EXISTS responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    participant_id UUID NOT NULL REFERENCES participants(id),
    question_id UUID NOT NULL REFERENCES questions(id),
    round_number INTEGER NOT NULL,
    selected_option CHAR(1) CHECK (selected_option IN ('A', 'B', 'C', 'D')),
    is_correct BOOLEAN,          -- kept for debugging only, NEVER used for scoring
    answered_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(participant_id, question_id)
);

ALTER TABLE responses ADD COLUMN IF NOT EXISTS is_correct BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_responses_participant ON responses(participant_id, round_number);
CREATE INDEX IF NOT EXISTS idx_responses_question ON responses(question_id);

-- ============================================================
-- TABLE: exam_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS exam_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    participant_id UUID NOT NULL REFERENCES participants(id),
    round_number INTEGER NOT NULL,
    current_question_number INTEGER DEFAULT 1,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    is_submitted BOOLEAN DEFAULT FALSE,
    submission_type VARCHAR(20),
    tab_switch_count INTEGER DEFAULT 0,
    time_taken_seconds INTEGER,
    UNIQUE(participant_id, round_number)
);

-- CRITICAL: Fix submission_type constraint
ALTER TABLE exam_sessions DROP CONSTRAINT IF EXISTS exam_sessions_submission_type_check;
ALTER TABLE exam_sessions ADD CONSTRAINT exam_sessions_submission_type_check
    CHECK (submission_type IN ('manual', 'auto_timer', 'auto_violation', 'auto_round_end'));

CREATE INDEX IF NOT EXISTS idx_exam_sessions_participant ON exam_sessions(participant_id, round_number);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_round_submitted ON exam_sessions(round_number, is_submitted);

-- ============================================================
-- TABLE: scores
-- ============================================================
CREATE TABLE IF NOT EXISTS scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    participant_id UUID NOT NULL REFERENCES participants(id),
    round_number INTEGER NOT NULL,
    correct_answers INTEGER DEFAULT 0,
    total_questions INTEGER DEFAULT 15,
    time_taken_seconds INTEGER,
    rank INTEGER,
    qualified_for_next BOOLEAN DEFAULT FALSE,
    calculated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(participant_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_scores_round ON scores(round_number, correct_answers DESC, time_taken_seconds ASC);
CREATE INDEX IF NOT EXISTS idx_scores_participant ON scores(participant_id);
CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores(round_number, rank);

-- ============================================================
-- TABLE: audit_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    participant_id UUID REFERENCES participants(id),
    admin_id UUID REFERENCES admins(id),
    event_type VARCHAR(50) NOT NULL,
    event_description TEXT,
    round_number INTEGER,
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_participant ON audit_logs(participant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);


-- ============================================================
-- FUNCTION: generate_participant_id()
-- ============================================================
CREATE OR REPLACE FUNCTION generate_participant_id()
RETURNS VARCHAR(20) AS $$
DECLARE
    new_id VARCHAR(20);
    exists_count INTEGER;
BEGIN
    LOOP
        new_id := 'QC-' || LPAD(FLOOR(RANDOM() * 100000)::TEXT, 5, '0');
        SELECT COUNT(*) INTO exists_count FROM participants WHERE system_id = new_id;
        IF exists_count = 0 THEN RETURN new_id; END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- FUNCTION: calculate_round_scores(p_round_number)
--
-- SCORING RULE:
--   +1 for correct (selected_option = correct_option, case-insensitive)
--    0 for incorrect or unanswered
--   No negative marking
--
-- SOURCE OF TRUTH: responses.selected_option vs questions.correct_option
-- NEVER uses responses.is_correct
--
-- IDEMPOTENT: safe to call multiple times
-- ============================================================
DROP FUNCTION IF EXISTS calculate_round_scores(INTEGER);
CREATE OR REPLACE FUNCTION calculate_round_scores(p_round_number INTEGER)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    INSERT INTO scores (
        participant_id, round_number, correct_answers,
        total_questions, time_taken_seconds, calculated_at
    )
    SELECT
        es.participant_id,
        es.round_number,
        COALESCE(
            COUNT(*) FILTER (
                WHERE UPPER(TRIM(r.selected_option)) = UPPER(TRIM(q.correct_option))
            ),
            0
        ) AS correct_answers,
        15,
        es.time_taken_seconds,
        NOW()
    FROM exam_sessions es
    LEFT JOIN responses r
        ON r.participant_id = es.participant_id
        AND r.round_number = es.round_number
    LEFT JOIN questions q
        ON q.id = r.question_id
    WHERE es.round_number = p_round_number
      AND es.is_submitted = TRUE
    GROUP BY es.participant_id, es.round_number, es.time_taken_seconds
    ON CONFLICT (participant_id, round_number)
    DO UPDATE SET
        correct_answers = EXCLUDED.correct_answers,
        time_taken_seconds = EXCLUDED.time_taken_seconds,
        calculated_at = NOW();

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- FUNCTION: generate_rankings(p_round_number)
--
-- RANKING ORDER (deterministic):
--   1. correct_answers DESC
--   2. time_taken_seconds ASC NULLS LAST
--   3. participant_id ASC  (tiebreaker for stability)
--
-- Disqualified participants get rank = NULL
-- ============================================================
DROP FUNCTION IF EXISTS generate_rankings(INTEGER);
CREATE OR REPLACE FUNCTION generate_rankings(p_round_number INTEGER)
RETURNS VOID AS $$
BEGIN
    -- Rank only non-disqualified participants
    WITH ranked AS (
        SELECT
            s.id,
            ROW_NUMBER() OVER (
                ORDER BY
                    s.correct_answers DESC,
                    s.time_taken_seconds ASC NULLS LAST,
                    s.participant_id ASC
            ) AS new_rank
        FROM scores s
        JOIN participants p ON p.id = s.participant_id
        WHERE s.round_number = p_round_number
          AND p.is_disqualified = FALSE
    )
    UPDATE scores s
    SET rank = r.new_rank
    FROM ranked r
    WHERE s.id = r.id;

    -- Disqualified → rank NULL, never qualified
    UPDATE scores s
    SET rank = NULL, qualified_for_next = FALSE
    FROM participants p
    WHERE s.participant_id = p.id
      AND s.round_number = p_round_number
      AND p.is_disqualified = TRUE;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- FUNCTION: perform_shortlisting(p_round_number, p_top_count)
--
-- QUALIFICATION RULES:
--   • Top p_top_count (default 25) eligible participants qualify
--   • If total eligible < p_top_count → all qualify
--   • Disqualified = EXCLUDED (rank IS NULL, never qualifies)
--
-- IDEMPOTENT: safe to call multiple times
-- ============================================================
DROP FUNCTION IF EXISTS perform_shortlisting(INTEGER, INTEGER);
CREATE OR REPLACE FUNCTION perform_shortlisting(
    p_round_number INTEGER,
    p_top_count INTEGER DEFAULT 25
)
RETURNS TABLE (
    qualified_count INTEGER,
    total_participants INTEGER
) AS $$
DECLARE
    v_total INTEGER;
    v_qualified INTEGER;
BEGIN
    -- Reset all qualified flags for this round
    UPDATE scores
    SET qualified_for_next = FALSE
    WHERE round_number = p_round_number;

    -- Count eligible (non-disqualified, ranked) participants
    SELECT COUNT(*) INTO v_total
    FROM scores s
    JOIN participants p ON p.id = s.participant_id
    WHERE s.round_number = p_round_number
      AND s.rank IS NOT NULL
      AND p.is_disqualified = FALSE;

    -- Mark Top N as qualified
    UPDATE scores
    SET qualified_for_next = TRUE
    WHERE round_number = p_round_number
      AND rank IS NOT NULL
      AND rank <= p_top_count;

    -- Count how many actually qualified
    SELECT COUNT(*) INTO v_qualified
    FROM scores
    WHERE round_number = p_round_number
      AND qualified_for_next = TRUE;

    -- Update participant qualification status
    -- Disqualify participants who didn't make the cut
    UPDATE participants p
    SET is_qualified = FALSE,
        current_round = p_round_number
    WHERE p.id IN (
        SELECT s.participant_id FROM scores s
        WHERE s.round_number = p_round_number
          AND s.qualified_for_next = FALSE
    )
    AND p.is_disqualified = FALSE;

    -- Advance qualified participants
    UPDATE participants p
    SET current_round = p_round_number + 1,
        is_qualified = TRUE
    WHERE p.id IN (
        SELECT s.participant_id FROM scores s
        WHERE s.round_number = p_round_number
          AND s.qualified_for_next = TRUE
    );

    -- Mark round shortlisting as completed
    UPDATE rounds
    SET shortlisting_completed = TRUE
    WHERE round_number = p_round_number;

    RETURN QUERY SELECT v_qualified, v_total;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- FUNCTION: finalize_round(p_round_number)
--
-- THE SINGLE ATOMIC ENTRY POINT for ending a round.
-- Called by BOTH:
--   1. Admin "End Round" button
--   2. Timer auto-end (via backend API)
--
-- GUARANTEES:
--   • Idempotent: double calls are no-ops
--   • Atomic: PostgreSQL function = single transaction
--   • No race condition: UPDATE WHERE status != 'completed'
--   • No partial state: if anything fails, entire txn rolls back
--
-- SEQUENCE:
--   1. Lock round (prevent double execution)
--   2. Auto-submit pending sessions
--   3. Calculate scores
--   4. Generate rankings
--   5. Shortlist Top 25
--   6. Update event_state
--   7. Return summary
-- ============================================================
DROP FUNCTION IF EXISTS finalize_round(INTEGER);
CREATE OR REPLACE FUNCTION finalize_round(p_round_number INTEGER)
RETURNS JSONB AS $$
DECLARE
    v_rows_affected INTEGER;
    v_auto_submitted INTEGER;
    v_scored INTEGER;
    v_qualified INTEGER;
    v_total INTEGER;
    v_top_count INTEGER;
    v_now TIMESTAMPTZ;
BEGIN
    v_now := NOW();

    -- ─── STEP 1: IDEMPOTENT GUARD ───────────────────────────
    -- Atomically mark round as completed.
    -- If already completed, no rows updated → exit early.
    UPDATE rounds
    SET status = 'completed', ended_at = v_now
    WHERE round_number = p_round_number
      AND status != 'completed';

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    IF v_rows_affected = 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'already_completed', true,
            'message', 'Round already finalized'
        );
    END IF;

    -- ─── STEP 2: UPDATE EVENT STATE ─────────────────────────
    UPDATE event_state
    SET round_status = 'completed',
        updated_at = v_now
    WHERE id = 1;

    -- ─── STEP 3: AUTO-SUBMIT PENDING SESSIONS ───────────────
    WITH auto_sub AS (
        UPDATE exam_sessions
        SET is_submitted = TRUE,
            submitted_at = v_now,
            submission_type = 'auto_round_end',
            time_taken_seconds = EXTRACT(EPOCH FROM (v_now - started_at))::INTEGER
        WHERE round_number = p_round_number
          AND is_submitted = FALSE
        RETURNING id
    )
    SELECT COUNT(*) INTO v_auto_submitted FROM auto_sub;

    -- ─── STEP 4: CALCULATE SCORES ───────────────────────────
    SELECT calculate_round_scores(p_round_number) INTO v_scored;

    -- ─── STEP 5: GENERATE RANKINGS ──────────────────────────
    PERFORM generate_rankings(p_round_number);

    -- ─── STEP 6: SHORTLIST TOP 25 ───────────────────────────
    SELECT top_qualify_count INTO v_top_count
    FROM rounds WHERE round_number = p_round_number;

    IF v_top_count IS NULL THEN v_top_count := 25; END IF;

    SELECT qualified_count, total_participants
    INTO v_qualified, v_total
    FROM perform_shortlisting(p_round_number, v_top_count);

    -- ─── STEP 7: RETURN SUMMARY ─────────────────────────────
    RETURN jsonb_build_object(
        'success', true,
        'round_number', p_round_number,
        'auto_submitted', v_auto_submitted,
        'total_scored', v_scored,
        'qualified_count', v_qualified,
        'total_eligible', v_total,
        'top_count', v_top_count
    );
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_state ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE tbl TEXT;
BEGIN
    FOR tbl IN SELECT unnest(ARRAY[
        'admins','participants','questions','responses',
        'scores','audit_logs','exam_sessions','rounds','event_state'
    ]) LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Service role full access" ON %I', tbl);
    END LOOP;
END $$;

CREATE POLICY "Service role full access" ON admins FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON participants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON questions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON responses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON scores FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON audit_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON exam_sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON rounds FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON event_state FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- VERIFICATION
-- ============================================================

-- Check submission_type constraint
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'exam_sessions'::regclass AND contype = 'c'
AND conname LIKE '%submission%';

-- Check all functions exist
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
ORDER BY routine_name;

-- Check all tables
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
