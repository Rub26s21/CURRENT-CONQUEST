-- ============================================================
-- QUIZ CONQUEST - ECE Professional Online Exam Platform
-- Database Schema for Supabase (PostgreSQL)
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ADMINS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);

-- ============================================================
-- EVENT STATE TABLE (Singleton for event management)
-- ============================================================
CREATE TABLE IF NOT EXISTS event_state (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    current_round INTEGER DEFAULT 0,
    round_status VARCHAR(20) DEFAULT 'not_started' CHECK (round_status IN ('not_started', 'running', 'completed')),
    round_started_at TIMESTAMPTZ,
    round_ends_at TIMESTAMPTZ,
    event_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize event state
INSERT INTO event_state (id, current_round, round_status, event_active)
VALUES (1, 0, 'not_started', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- ROUNDS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS rounds (
    id SERIAL PRIMARY KEY,
    round_number INTEGER UNIQUE NOT NULL CHECK (round_number BETWEEN 1 AND 3),
    total_questions INTEGER DEFAULT 15,
    duration_minutes INTEGER DEFAULT 15,
    qualification_percentage DECIMAL(5,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed')),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    shortlisting_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize rounds
INSERT INTO rounds (round_number, qualification_percentage) VALUES
    (1, 50.00),
    (2, 50.00),
    (3, 100.00)
ON CONFLICT (round_number) DO NOTHING;

-- ============================================================
-- PARTICIPANTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS participants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    system_id VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    college_name VARCHAR(150) NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    session_token VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    current_round INTEGER DEFAULT 1,
    is_qualified BOOLEAN DEFAULT TRUE,
    is_disqualified BOOLEAN DEFAULT FALSE,
    disqualification_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_participants_system_id ON participants(system_id);
CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_token);
CREATE INDEX IF NOT EXISTS idx_participants_qualified ON participants(is_qualified, current_round);

-- ============================================================
-- QUESTIONS TABLE
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

-- Index for question retrieval
CREATE INDEX IF NOT EXISTS idx_questions_round ON questions(round_number, question_number);

-- ============================================================
-- RESPONSES TABLE (Individual answer submissions)
-- ============================================================
CREATE TABLE IF NOT EXISTS responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    participant_id UUID NOT NULL REFERENCES participants(id),
    question_id UUID NOT NULL REFERENCES questions(id),
    round_number INTEGER NOT NULL,
    selected_option CHAR(1) CHECK (selected_option IN ('A', 'B', 'C', 'D')),
    is_correct BOOLEAN,
    answered_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(participant_id, question_id)
);

-- Index for response lookups
CREATE INDEX IF NOT EXISTS idx_responses_participant ON responses(participant_id, round_number);
CREATE INDEX IF NOT EXISTS idx_responses_question ON responses(question_id);

-- ============================================================
-- EXAM SESSIONS TABLE (Tracks participant exam state)
-- ============================================================
CREATE TABLE IF NOT EXISTS exam_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    participant_id UUID NOT NULL REFERENCES participants(id),
    round_number INTEGER NOT NULL,
    current_question_number INTEGER DEFAULT 1,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    is_submitted BOOLEAN DEFAULT FALSE,
    submission_type VARCHAR(20) CHECK (submission_type IN ('manual', 'auto_timer', 'auto_violation', 'auto_round_end')),
    tab_switch_count INTEGER DEFAULT 0,
    time_taken_seconds INTEGER,
    UNIQUE(participant_id, round_number)
);

-- Index for session lookups
CREATE INDEX IF NOT EXISTS idx_exam_sessions_participant ON exam_sessions(participant_id, round_number);

-- ============================================================
-- SCORES TABLE (Round-wise scores)
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

-- Index for score lookups and ranking
CREATE INDEX IF NOT EXISTS idx_scores_round ON scores(round_number, correct_answers DESC, time_taken_seconds ASC);
CREATE INDEX IF NOT EXISTS idx_scores_participant ON scores(participant_id);

-- ============================================================
-- AUDIT LOGS TABLE
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

-- Index for audit log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_participant ON audit_logs(participant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Function to generate unique participant system ID
CREATE OR REPLACE FUNCTION generate_participant_id()
RETURNS VARCHAR(20) AS $$
DECLARE
    new_id VARCHAR(20);
    exists_count INTEGER;
BEGIN
    LOOP
        new_id := 'QC-' || LPAD(FLOOR(RANDOM() * 100000)::TEXT, 5, '0');
        SELECT COUNT(*) INTO exists_count FROM participants WHERE system_id = new_id;
        IF exists_count = 0 THEN
            RETURN new_id;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to calculate and update scores for a round
CREATE OR REPLACE FUNCTION calculate_round_scores(p_round_number INTEGER)
RETURNS VOID AS $$
BEGIN
    -- Insert or update scores for all participants who took the exam
    INSERT INTO scores (participant_id, round_number, correct_answers, total_questions, time_taken_seconds)
    SELECT 
        es.participant_id,
        es.round_number,
        COALESCE(SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END), 0),
        15,
        es.time_taken_seconds
    FROM exam_sessions es
    LEFT JOIN responses r ON r.participant_id = es.participant_id AND r.round_number = es.round_number
    WHERE es.round_number = p_round_number AND es.is_submitted = TRUE
    GROUP BY es.participant_id, es.round_number, es.time_taken_seconds
    ON CONFLICT (participant_id, round_number) 
    DO UPDATE SET 
        correct_answers = EXCLUDED.correct_answers,
        time_taken_seconds = EXCLUDED.time_taken_seconds,
        calculated_at = NOW();

    -- Update ranks based on score and time
    WITH ranked AS (
        SELECT 
            id,
            ROW_NUMBER() OVER (
                ORDER BY correct_answers DESC, time_taken_seconds ASC NULLS LAST
            ) as new_rank
        FROM scores
        WHERE round_number = p_round_number
    )
    UPDATE scores s
    SET rank = r.new_rank
    FROM ranked r
    WHERE s.id = r.id;
END;
$$ LANGUAGE plpgsql;

-- Function to perform shortlisting after a round
CREATE OR REPLACE FUNCTION perform_shortlisting(p_round_number INTEGER)
RETURNS TABLE (
    qualified_count INTEGER,
    total_participants INTEGER
) AS $$
DECLARE
    v_qualification_pct DECIMAL(5,2);
    v_total_participants INTEGER;
    v_qualify_count INTEGER;
BEGIN
    -- Get qualification percentage for this round
    SELECT qualification_percentage INTO v_qualification_pct
    FROM rounds WHERE round_number = p_round_number;
    
    -- Get total participants who submitted this round
    SELECT COUNT(*) INTO v_total_participants
    FROM scores WHERE round_number = p_round_number;
    
    -- Calculate how many should qualify
    IF p_round_number = 3 THEN
        v_qualify_count := 3; -- Top 3 for final round
    ELSE
        v_qualify_count := GREATEST(1, CEIL(v_total_participants * v_qualification_pct / 100));
    END IF;
    
    -- Mark qualified participants
    UPDATE scores s
    SET qualified_for_next = TRUE
    WHERE s.round_number = p_round_number
    AND s.rank <= v_qualify_count;
    
    -- Update participant qualification status
    UPDATE participants p
    SET is_qualified = FALSE,
        current_round = p_round_number
    WHERE p.id NOT IN (
        SELECT participant_id FROM scores 
        WHERE round_number = p_round_number AND qualified_for_next = TRUE
    )
    AND p.id IN (
        SELECT participant_id FROM scores WHERE round_number = p_round_number
    );
    
    -- Advance qualified participants
    UPDATE participants p
    SET current_round = p_round_number + 1
    WHERE p.id IN (
        SELECT participant_id FROM scores 
        WHERE round_number = p_round_number AND qualified_for_next = TRUE
    );
    
    -- Mark shortlisting as completed
    UPDATE rounds SET shortlisting_completed = TRUE WHERE round_number = p_round_number;
    
    RETURN QUERY SELECT v_qualify_count, v_total_participants;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ROW LEVEL SECURITY (Disabled for service role access)
-- ============================================================
-- Note: We use service role key which bypasses RLS
-- This is intentional as all access goes through our backend

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_state ENABLE ROW LEVEL SECURITY;

-- Service role policies (full access)
CREATE POLICY "Service role full access" ON admins FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON participants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON questions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON responses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON scores FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON audit_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON exam_sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON rounds FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON event_state FOR ALL USING (true) WITH CHECK (true);
