-- ============================================================
-- QUIZ CONQUEST v3.1 — HARDENING MIGRATION
-- Run this in Supabase SQL Editor BEFORE deploying v3.1
-- ============================================================

-- ============================================================
-- UNIQUE INDEX: phone_number (prevents duplicate registrations)
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_phone_unique
    ON participants(phone_number)
    WHERE phone_number IS NOT NULL;


-- ============================================================
-- FUNCTION: register_participant(...)
--
-- ATOMIC registration with retry for system_id collision.
-- GUARANTEES:
--   • If phone already exists → returns existing participant
--   • If new → generates unique system_id with retry loop
--   • Single transaction — no partial inserts
--   • Blocks disqualified users
-- ============================================================
DROP FUNCTION IF EXISTS register_participant(TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION register_participant(
    p_name TEXT,
    p_college_name TEXT,
    p_phone_number TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_participant RECORD;
    v_system_id VARCHAR(20);
    v_session_token UUID;
    v_attempts INTEGER := 0;
    v_max_attempts INTEGER := 5;
BEGIN
    -- Trim inputs
    p_name := TRIM(p_name);
    p_college_name := TRIM(p_college_name);
    p_phone_number := TRIM(p_phone_number);

    -- Check event is active
    IF NOT (SELECT event_active FROM event_state WHERE id = 1) THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'EVENT_INACTIVE',
            'message', 'Event is not active yet'
        );
    END IF;

    -- Check for existing participant by phone
    SELECT * INTO v_participant
    FROM participants
    WHERE phone_number = p_phone_number;

    IF FOUND THEN
        -- Returning participant
        IF v_participant.is_disqualified THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'DISQUALIFIED',
                'message', 'You have been disqualified from this event'
            );
        END IF;

        -- Refresh session token
        v_session_token := gen_random_uuid();
        UPDATE participants
        SET session_token = v_session_token::TEXT,
            last_activity = NOW()
        WHERE id = v_participant.id;

        RETURN jsonb_build_object(
            'success', true,
            'is_new', false,
            'participant_id', v_participant.id,
            'system_id', v_participant.system_id,
            'name', v_participant.name,
            'college_name', v_participant.college_name,
            'current_round', v_participant.current_round,
            'session_token', v_session_token
        );
    END IF;

    -- New participant — generate unique system_id with retry
    v_session_token := gen_random_uuid();

    LOOP
        v_attempts := v_attempts + 1;

        IF v_attempts <= v_max_attempts THEN
            v_system_id := 'QC-' || LPAD(FLOOR(RANDOM() * 100000)::TEXT, 5, '0');
        ELSE
            -- UUID fallback after max attempts (guaranteed unique)
            v_system_id := 'QC-' || SUBSTRING(gen_random_uuid()::TEXT FROM 1 FOR 8);
        END IF;

        BEGIN
            INSERT INTO participants (
                system_id, name, college_name, phone_number,
                session_token, is_active, is_qualified,
                is_disqualified, current_round
            ) VALUES (
                v_system_id, p_name, p_college_name, p_phone_number,
                v_session_token::TEXT, TRUE, TRUE,
                FALSE, 1
            );

            -- Insert succeeded
            SELECT * INTO v_participant
            FROM participants WHERE system_id = v_system_id;

            RETURN jsonb_build_object(
                'success', true,
                'is_new', true,
                'participant_id', v_participant.id,
                'system_id', v_participant.system_id,
                'name', v_participant.name,
                'college_name', v_participant.college_name,
                'current_round', v_participant.current_round,
                'session_token', v_session_token
            );

        EXCEPTION WHEN unique_violation THEN
            -- system_id collision OR phone_number race condition
            IF v_attempts > v_max_attempts + 3 THEN
                RAISE EXCEPTION 'Failed to generate unique participant ID after % attempts', v_attempts;
            END IF;

            -- Check if phone_number was inserted by a concurrent request
            SELECT * INTO v_participant
            FROM participants WHERE phone_number = p_phone_number;

            IF FOUND THEN
                -- Another request registered this phone — return that participant
                v_session_token := gen_random_uuid();
                UPDATE participants
                SET session_token = v_session_token::TEXT,
                    last_activity = NOW()
                WHERE id = v_participant.id;

                RETURN jsonb_build_object(
                    'success', true,
                    'is_new', false,
                    'participant_id', v_participant.id,
                    'system_id', v_participant.system_id,
                    'name', v_participant.name,
                    'college_name', v_participant.college_name,
                    'current_round', v_participant.current_round,
                    'session_token', v_session_token
                );
            END IF;
            -- Otherwise, retry with new system_id
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- FUNCTION: submit_exam_attempt(...)
--
-- ATOMIC exam submission.
-- GUARANTEES:
--   • Responses upserted + session marked submitted in ONE transaction
--   • Idempotent: if already submitted, returns success
--   • No partial writes (all-or-nothing)
--   • Validates submission_type
-- ============================================================
DROP FUNCTION IF EXISTS submit_exam_attempt(UUID, INTEGER, JSONB, TEXT);
CREATE OR REPLACE FUNCTION submit_exam_attempt(
    p_participant_id UUID,
    p_round_number INTEGER,
    p_answers JSONB,
    p_submission_type TEXT DEFAULT 'manual'
)
RETURNS JSONB AS $$
DECLARE
    v_session RECORD;
    v_time_taken INTEGER;
    v_answer_count INTEGER := 0;
    v_valid_types TEXT[] := ARRAY['manual', 'auto_timer', 'auto_violation', 'auto_round_end'];
    v_final_type TEXT;
    v_now TIMESTAMPTZ;
BEGIN
    v_now := NOW();

    -- Validate submission type
    IF p_submission_type = ANY(v_valid_types) THEN
        v_final_type := p_submission_type;
    ELSE
        v_final_type := 'manual';
    END IF;

    -- Get exam session
    SELECT * INTO v_session
    FROM exam_sessions
    WHERE participant_id = p_participant_id
      AND round_number = p_round_number;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'No exam session found'
        );
    END IF;

    -- IDEMPOTENT: already submitted → return success
    IF v_session.is_submitted THEN
        RETURN jsonb_build_object(
            'success', true,
            'already_submitted', true,
            'message', 'Exam already submitted'
        );
    END IF;

    -- Calculate time taken
    v_time_taken := EXTRACT(EPOCH FROM (v_now - v_session.started_at))::INTEGER;

    -- STEP 1: Bulk upsert responses (atomic within this function)
    IF p_answers IS NOT NULL AND jsonb_array_length(p_answers) > 0 THEN
        INSERT INTO responses (
            participant_id, question_id, round_number,
            selected_option, answered_at
        )
        SELECT
            p_participant_id,
            (answer->>'question_id')::UUID,
            p_round_number,
            UPPER(TRIM(answer->>'selected_option')),
            v_now
        FROM jsonb_array_elements(p_answers) AS answer
        WHERE (answer->>'question_id') IS NOT NULL
          AND (answer->>'selected_option') IS NOT NULL
        ON CONFLICT (participant_id, question_id)
        DO UPDATE SET
            selected_option = EXCLUDED.selected_option,
            answered_at = EXCLUDED.answered_at;

        GET DIAGNOSTICS v_answer_count = ROW_COUNT;
    END IF;

    -- STEP 2: Mark session as submitted (same transaction)
    UPDATE exam_sessions
    SET is_submitted = TRUE,
        submitted_at = v_now,
        submission_type = v_final_type,
        time_taken_seconds = v_time_taken
    WHERE id = v_session.id
      AND is_submitted = FALSE;  -- Double-check guard

    RETURN jsonb_build_object(
        'success', true,
        'answers_recorded', v_answer_count,
        'time_taken_seconds', v_time_taken,
        'submission_type', v_final_type
    );
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- FUNCTION: handle_tab_switch(...)
--
-- ATOMIC tab switch handler.
-- GUARANTEES:
--   • 1st switch = warning only
--   • 2nd switch = auto-submit + disqualify (ONE transaction)
--   • No partial state: if disqualification fails, entire txn rolls back
--   • Idempotent for already-submitted/disqualified participants
-- ============================================================
DROP FUNCTION IF EXISTS handle_tab_switch(UUID, INTEGER, JSONB);
CREATE OR REPLACE FUNCTION handle_tab_switch(
    p_participant_id UUID,
    p_round_number INTEGER,
    p_answers JSONB DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_session RECORD;
    v_new_count INTEGER;
    v_time_taken INTEGER;
    v_now TIMESTAMPTZ;
BEGIN
    v_now := NOW();

    -- Get exam session
    SELECT * INTO v_session
    FROM exam_sessions
    WHERE participant_id = p_participant_id
      AND round_number = p_round_number;

    IF NOT FOUND OR v_session.is_submitted THEN
        RETURN jsonb_build_object(
            'success', true,
            'warning', false,
            'auto_submitted', false,
            'tab_switch_count', COALESCE(v_session.tab_switch_count, 0)
        );
    END IF;

    -- Increment tab switch count
    v_new_count := COALESCE(v_session.tab_switch_count, 0) + 1;

    UPDATE exam_sessions
    SET tab_switch_count = v_new_count
    WHERE id = v_session.id;

    -- 1st SWITCH: WARNING ONLY
    IF v_new_count = 1 THEN
        RETURN jsonb_build_object(
            'success', true,
            'warning', true,
            'auto_submitted', false,
            'disqualified', false,
            'tab_switch_count', v_new_count,
            'message', 'First warning: switching tabs again will result in disqualification'
        );
    END IF;

    -- 2nd+ SWITCH: AUTO-SUBMIT + DISQUALIFY (all atomic)
    v_time_taken := EXTRACT(EPOCH FROM (v_now - v_session.started_at))::INTEGER;

    -- Step A: Save answers if provided
    IF p_answers IS NOT NULL AND jsonb_array_length(p_answers) > 0 THEN
        INSERT INTO responses (
            participant_id, question_id, round_number,
            selected_option, answered_at
        )
        SELECT
            p_participant_id,
            (answer->>'question_id')::UUID,
            p_round_number,
            UPPER(TRIM(answer->>'selected_option')),
            v_now
        FROM jsonb_array_elements(p_answers) AS answer
        WHERE (answer->>'question_id') IS NOT NULL
          AND (answer->>'selected_option') IS NOT NULL
        ON CONFLICT (participant_id, question_id)
        DO UPDATE SET
            selected_option = EXCLUDED.selected_option,
            answered_at = EXCLUDED.answered_at;
    END IF;

    -- Step B: Mark session submitted
    UPDATE exam_sessions
    SET is_submitted = TRUE,
        submitted_at = v_now,
        submission_type = 'auto_violation',
        time_taken_seconds = v_time_taken
    WHERE id = v_session.id;

    -- Step C: Disqualify participant
    UPDATE participants
    SET is_disqualified = TRUE,
        disqualification_reason = 'Auto-disqualified: ' || v_new_count || ' tab switches (limit = 2)'
    WHERE id = p_participant_id;

    RETURN jsonb_build_object(
        'success', true,
        'warning', false,
        'auto_submitted', true,
        'disqualified', true,
        'tab_switch_count', v_new_count,
        'message', 'Disqualified due to tab switch violations'
    );
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- VERIFICATION: Check all functions exist
-- ============================================================
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
ORDER BY routine_name;
