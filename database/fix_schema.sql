-- ============================================================
-- QUIZ CONQUEST - COMPLETE Database Fix Script
-- ============================================================
-- 
-- INSTRUCTIONS:
-- 1. Go to your Supabase Dashboard: https://supabase.com/dashboard
-- 2. Select your project
-- 3. Go to SQL Editor (left sidebar)
-- 4. Copy and paste this entire script
-- 5. Click "Run" to execute
-- ============================================================

-- First, check current columns
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'participants'
ORDER BY ordinal_position;

-- Add ALL missing columns to participants table
ALTER TABLE participants ADD COLUMN IF NOT EXISTS college_name VARCHAR(150);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS session_token VARCHAR(255);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_qualified BOOLEAN DEFAULT TRUE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_disqualified BOOLEAN DEFAULT FALSE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS disqualification_reason TEXT;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS current_round INTEGER DEFAULT 1;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ DEFAULT NOW();

-- Set default values for any existing rows
UPDATE participants SET college_name = 'Not Specified' WHERE college_name IS NULL;
UPDATE participants SET phone_number = '0000000000' WHERE phone_number IS NULL;
UPDATE participants SET is_active = TRUE WHERE is_active IS NULL;
UPDATE participants SET is_qualified = TRUE WHERE is_qualified IS NULL;
UPDATE participants SET is_disqualified = FALSE WHERE is_disqualified IS NULL;
UPDATE participants SET current_round = 1 WHERE current_round IS NULL;

-- Ensure event_state has a record with event_active = TRUE for testing
INSERT INTO event_state (id, current_round, round_status, event_active)
VALUES (1, 0, 'not_started', true)
ON CONFLICT (id) DO UPDATE SET event_active = true;

-- Ensure rounds are properly set up
INSERT INTO rounds (round_number, qualification_percentage, total_questions, duration_minutes)
VALUES 
    (1, 50.00, 15, 15),
    (2, 50.00, 15, 15),
    (3, 100.00, 15, 15)
ON CONFLICT (round_number) DO UPDATE SET
    total_questions = 15,
    duration_minutes = COALESCE(rounds.duration_minutes, 15);

-- Verify the fix worked
SELECT 'Updated participants columns:' as info;
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'participants'
ORDER BY ordinal_position;

SELECT 'event_state (should show event_active = true):' as info;
SELECT * FROM event_state WHERE id = 1;

-- ============================================================
-- EXPECTED OUTPUT:
-- You should see college_name and phone_number in the columns list
-- event_active should be TRUE
-- ============================================================
