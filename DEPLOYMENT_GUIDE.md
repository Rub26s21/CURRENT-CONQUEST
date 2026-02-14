# Deployment Workflow for Quiz Conquest v3.0 (Refactored)

This guide walks you through deploying the fully refactored, production-grade exam engine.

## 1. Database Migration (CRITICAL)

You **MUST** run the SQL script to update your database schema. This script is safe to run on existing data.

1. Go to your **Supabase Dashboard**.
2. Open the **SQL Editor**.
3. Copy the entire content of:
   `database/FINAL_RUN_THIS_IN_SUPABASE.sql`
4. Paste it into the editor and click **Run**.
5. Verify that it says "Success" and no errors occurred.

## 2. Environment Variables

Ensure your `.env` (local) and Vercel Environment Variables match:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_service_role_key
SESSION_SECRET=a_very_long_secure_random_string
NODE_ENV=production
FRONTEND_URL=https://your-vercel-app-url.vercel.app
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure_password
```

> **Note:** on Vercel, ensure `NODE_ENV` is set to `production` for secure cookies to work.

## 3. Verify Local Functionality (Optional)

You can test the system locally before deploying:

```bash
npm install
npm start
```
- Admin Panel: http://localhost:3000/admin
- Exam Page: http://localhost:3000

## 4. Deploy to Vercel

1. Push your changes to GitHub:
   ```bash
   git add .
   git commit -m "Refactor: Production-grade exam engine v3.0"
   git push origin main
   ```
2. Vercel will automatically trigger a new deployment.
3. Once deployed, verify the Admin Dashboard loads correctly.

## 5. Post-Deployment Checks

1. Log in as Admin.
2. Go to Dashboard.
3. Activate Event.
4. Attempt a test login as a participant (use a fake phone number).
5. Verify strict tab monitoring (switch tabs and see the warning).

---
**System Status:**
✅ Atomic Scoring Engine
✅ Race-Condition Safe
✅ Strict Tab Monitoring
✅ 25-User Qualification Logic
