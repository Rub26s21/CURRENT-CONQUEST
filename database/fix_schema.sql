-- ============================================================
-- QUIZ CONQUEST - COMPLETE Database Fix Script v2
-- ============================================================
-- 
-- This fixes the college_or_phone column issue
-- ============================================================

-- OPTION 1: If you want to keep the old column and use it
-- Uncomment the line below and comment out OPTION 2
-- ALTER TABLE participants ALTER COLUMN college_or_phone DROP NOT NULL;

-- OPTION 2: Drop the old column and use the new ones (RECOMMENDED)
-- First, make the old column nullable or drop it

-- Make college_or_phone nullable (in case it exists with NOT NULL)
DO $$
BEGIN
    ALTER TABLE participants ALTER COLUMN college_or_phone DROP NOT NULL;
EXCEPTION
    WHEN undefined_column THEN NULL;
    WHEN others THEN NULL;
END $$;

-- Add ALL columns we need
ALTER TABLE participants ADD COLUMN IF NOT EXISTS college_name VARCHAR(150);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS session_token VARCHAR(255);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_qualified BOOLEAN DEFAULT TRUE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_disqualified BOOLEAN DEFAULT FALSE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS disqualification_reason TEXT;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS current_round INTEGER DEFAULT 1;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ DEFAULT NOW();

-- Set default values
UPDATE participants SET is_active = TRUE WHERE is_active IS NULL;
UPDATE participants SET is_qualified = TRUE WHERE is_qualified IS NULL;
UPDATE participants SET is_disqualified = FALSE WHERE is_disqualified IS NULL;
UPDATE participants SET current_round = 1 WHERE current_round IS NULL;

-- Enable event for testing
UPDATE event_state SET event_active = true WHERE id = 1;

-- Verify columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'participants'
ORDER BY ordinal_position;
 