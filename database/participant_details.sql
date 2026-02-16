-- ============================================================
-- PARTICIPANT DETAILS — Admin-managed personal data
-- ============================================================
-- This table stores participant personal details that are
-- managed ONLY by the admin. This data is NOT collected
-- during the exam — it is entered/edited by the admin.
--
-- Linked to attempt_token for cross-referencing with submissions.
-- ============================================================

CREATE TABLE IF NOT EXISTS participant_details (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    attempt_token UUID,
    name VARCHAR(255) NOT NULL DEFAULT '',
    college VARCHAR(255) DEFAULT '',
    phone VARCHAR(20) DEFAULT '',
    email VARCHAR(255) DEFAULT '',
    department VARCHAR(100) DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_participant_details_token 
    ON participant_details(attempt_token);
CREATE INDEX IF NOT EXISTS idx_participant_details_name 
    ON participant_details(name);

-- Enable RLS
ALTER TABLE participant_details ENABLE ROW LEVEL SECURITY;

-- Only service role (admin backend) can access
CREATE POLICY "Service role full access" 
    ON participant_details FOR ALL 
    USING (true) WITH CHECK (true);
