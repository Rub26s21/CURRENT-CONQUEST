# 🚀 QUIZ CONQUEST - DEPLOYMENT GUIDE (v3.1 Hardened)

This guide covers the deployment of the hardened, production-grade Quiz Conquest system.

## 🚨 MANDATORY: Database Migration (v3.1)

Before deploying the latest code, you **MUST** run the SQL migration script. This adds the atomic transaction functions (`register_participant`, `submit_exam_attempt`, `handle_tab_switch`) required for data integrity.

1.  Go to your **Supabase Dashboard**.
2.  Open the **SQL Editor**.
3.  Copy the entire content of:
    `database/v31_hardening_migration.sql`
4.  Paste it into the editor and click **Run**.
5.  Verify that it says "Success" and no errors occurred.

*(Note: If you are setting up a fresh database, run `database/final_complete_schema.sql` instead, as it includes everything including v3.1 changes.)*

---

## 2. Environment Variables

Ensure your Vercel Project Settings > Environment Variables match these keys:

```ad-note
**Security Reminder:** In production (Vercel), ensure `NODE_ENV` is set to `production`. This enforces `secure: true` cookies, which are required for modern browsers.
```

| Key | Value Description |
| :--- | :--- |
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase `service_role` key (do NOT use anon key) |
| `SESSION_SECRET` | A long, random string for session signing |
| `NODE_ENV` | `production` |
| `ADMIN_USERNAME` | Admin login username |
| `ADMIN_PASSWORD` | Admin login password |
| `FRONTEND_URL` | `https://your-app-name.vercel.app` (no trailing slash) |

---

## 3. Deploy to Vercel

The code is already pushed to GitHub. Vercel should automatically trigger a deployment.

1.  Go to your **Vercel Dashboard**.
2.  Check the latest deployment status.
3.  Once "Ready" (Green), verify the live URL.

---

## 4. Post-Deployment Verification

After deployment, perform these checks on the live site:

1.  **Admin Login:**
    - Go to `/admin`.
    - Login with your `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
    - Dashboard should load without errors.

2.  **Event Activation:**
    - Click "Activate Event" on the dashboard.
    - Confirm status changes to "Active".

3.  **Participant Registration (Atomic Test):**
    - Open the main page (`/`) in Incognito mode.
    - Register with a fake user (e.g., "Test User", "9999999999").
    - **Success:** You should be logged in immediately.
    - **Failure:** If it hangs or errors off, the `register_participant` DB function is missing. Go back to step 1.

4.  **Tab Switch Enforcer:**
    - Start the exam.
    - Switch tabs once -> Should see a warning modal.
    - Switch tabs again -> Should be auto-submitted and disqualified.

---

## 5. Troubleshooting

**Issue: "Login failed" / "Registration error"**
- **Cause:** Missing database functions.
- **Fix:** Run `database/v31_hardening_migration.sql` in Supabase.

**Issue: "Session expired" immediately after login**
- **Cause:** Cookie security mismatch.
- **Fix:** Ensure you are accessing via `https://` (not http) and `NODE_ENV=production` is set in Vercel.

**Issue: "Network Error" on submission**
- **Cause:** Vercel function timeout (10s limit on Hobby plan).
- **Fix:** The app has retry logic, but for >500 users, upgrading to Pro is recommended.
