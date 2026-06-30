# StudyConsole

> A self-hosted, offline-first management system for private study centres and libraries — handles admissions, seat allocation, billing, attendance, and parent communication entirely on the owner's own local network, with zero recurring cost.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js)
![Express](https://img.shields.io/badge/Express-4.19-black?logo=express)
![SQLite](https://img.shields.io/badge/better--sqlite3-11.3-003B57?logo=sqlite)
![Deployment](https://img.shields.io/badge/Deployment-Local%20Network%20Only-orange)
![Auth](https://img.shields.io/badge/Auth-Session%20Cookie-blue)
![Cost](https://img.shields.io/badge/Recurring%20Cost-₹0-brightgreen)

---

## What is StudyConsole?

StudyConsole is a **self-hosted, single-machine** application that lets a study centre or library owner run their entire daily operation — student admissions, seat assignment, monthly billing, fine calculation, attendance, and WhatsApp/email reminders — from one Windows machine on their local WiFi network.

There is no cloud, no monthly subscription, and no internet dependency for core operation. The admin's machine runs the server; staff and the admin connect to it from any device on the same network through a browser. Students get their own read-only portal to view their bills, attendance, and request seat changes.

**Built for:** small private study centres and libraries with a single admin, typically under 100 students, often in towns without reliable enterprise IT support.

---

## Features

| Feature | Details |
|---|---|
| **Local-Network Deployment** | Runs entirely on the owner's machine; no cloud hosting, no internet required for daily use |
| **Role-Based Access** | Separate login flows and session types for Admin and Student, fully isolated route guards |
| **Seat Allocation Engine** | Automatic seat proposal based on gender-balanced section distribution, time-slot overlap detection, and proximity scoring |
| **Combo Time-Block Support** | A single student can hold 2+ active seat allocations (e.g. morning + evening shifts) without being modeled as two students |
| **Anniversary-Style Billing** | Monthly billing records generated per student based on their individual `billing_start_month`, not a fixed calendar cycle |
| **Audit & Fine Engine** | Automatically marks bills Overdue and applies fines past a configurable audit day each month; auto-suspends students past a configurable due-months threshold |
| **3-Step Reactivation Wizard** | Suspended students are reactivated through an enforced sequence: settle past dues at old rates → select new seat → calculate current month's bill only after reallocation |
| **Combined Backup System** | One-click `.zip` backup containing both the main database and the separate student photos database, with WAL checkpointing for consistency |
| **Three-Tier Auto-Backup** | Snapshots taken automatically on server startup, every 2 hours while running, and on clean shutdown — last 5 kept per trigger type, older ones pruned automatically |
| **Public Registration Portal** | Prospective students can submit an admission request from any device without logging in; admin reviews and admits from the dashboard |
| **Profile Edit & Reallocation Requests** | Students submit edit/reallocation requests from their own portal; admin approves or rejects from a review queue — no direct student writes to core tables |
| **Attendance Logging** | One row per student per day, auto-logged on student portal login; admin dashboard shows live present/absent counts and can email absence notices |
| **WhatsApp Queue System** | Outgoing reminder messages (overdue bills, etc.) are queued in the database for the admin to send manually via WhatsApp Web, with a "mark as sent" tracker |
| **Email Notifications** | Optional SMTP integration sends welcome emails, invoices, payment receipts, overdue warnings, suspension/reactivation notices, and seat-change confirmations |
| **Real-Time Dashboard Updates** | Server-Sent Events (SSE) push live changes to all connected admin browsers — no polling, no manual refresh |
| **Brute-Force Login Protection** | In-memory rate limiter locks out an IP after repeated failed login attempts within a rolling window |
| **Seat Layout Designer** | Drag-and-drop seat grid editor with rotation and section grouping, stored as `grid_x` / `grid_y` coordinates |
| **Manual Override Logging** | Any time an admin manually overrides the system's seat proposal, the override and reason are permanently logged for audit |

---

## Project Structure

```
StudyConsole/
│
├── server/
│   ├── server.js              ← Entry point: middleware chain, route guards, auto-backup, shutdown handler
│   ├── realtime.js            ← Legacy EventEmitter (superseded by services/liveStream.js)
│   │
│   ├── db/
│   │   ├── init.js            ← Runs schema.sql, applies incremental ALTER TABLEs, seeds defaults
│   │   └── schema.sql         ← Full table definitions (students, billing, seats, sessions, etc.)
│   │
│   ├── routes/
│   │   ├── auth.js            ← Student-facing auth: login, logout, profile edits, seat requests, receipts
│   │   ├── admin.js           ← Admin-facing auth + attendance stats/notify endpoints
│   │   ├── students.js        ← Full student lifecycle: create, suspend, reactivate, archive
│   │   ├── seats.js           ← Seat layout CRUD, availability check, allocation proposal, override logging
│   │   ├── fees.js            ← Fee structure (hours/day → monthly fee) CRUD
│   │   ├── payments.js        ← Record payments, view transaction history, admission fee adjustments
│   │   ├── dashboard.js       ← Aggregated stats for the admin home screen
│   │   ├── registrations.js   ← Public intake form + admin review/admit/reject queue
│   │   ├── reallocations.js   ← Student seat-change request review queue
│   │   ├── messages.js        ← WhatsApp reminder queue (pending list + mark-as-sent)
│   │   ├── settings.js        ← Institute settings, audit/billing config, SMTP test
│   │   └── backup.js          ← Zip backup download, restore, full data reset
│   │
│   └── services/
│       ├── auth.js              ← Password hashing, session create/validate/delete, expired session cleanup
│       ├── allocator.js         ← Seat proposal algorithm: gender balance, section scoring, distance minimization
│       ├── seatAvailability.js  ← Time-range overlap detection for a given seat
│       ├── billingGenerator.js  ← Generates monthly billing_records rows, idempotent on repeated runs
│       ├── billingStartMonth.js ← Resolves a student's effective billing start month (handles transition mode)
│       ├── auditEngine.js       ← Fines Due/Partial records past the audit day, auto-suspends overdue students
│       ├── liveStream.js        ← SSE client registry + broadcastChange() used by all routes for live updates
│       └── emailService.js      ← Nodemailer wrapper + every transactional email template
│
├── public/
│   ├── login.html              ← Combined admin/student login screen
│   ├── dashboard.html          ← Admin home: live stats, quick actions
│   ├── students.html           ← Student list, search, admission form, suspend/reactivate/archive actions
│   ├── seats.html              ← Visual seat grid: layout editor + live occupancy view
│   ├── payments.html           ← Billing records table, record-payment modal, receipt generation
│   ├── reallocations.html      ← Pending seat-change request review queue
│   ├── messages.html           ← WhatsApp reminder queue
│   ├── attendance.html         ← Live present/absent view, absence email trigger
│   ├── settings.html           ← Institute config, audit/billing rules, backup & restore, danger zone
│   ├── register.html           ← Public admission intake form (no login required)
│   ├── student-portal.html     ← Student-facing: bills, attendance history, profile edit, seat request
│   ├── js/common.js            ← Shared: toast notifications, SSE client, modal helpers
│   └── css/style.css           ← Global dark-themed styling
│
├── data/
│   ├── studycenter.db          ← Main SQLite database (students, billing, seats, sessions, etc.)
│   ├── photos.db               ← Separate SQLite database, student photos only
│   └── auto-backups/           ← Rolling snapshots: startup / interval / shutdown, last 5 each kept
│
├── launch.bat                  ← Kills any stale process on port 3000, starts server, opens incognito Chrome
└── package.json
```

---

## Architecture & How It Works

### 1. Deployment Model

```
Admin's Windows PC
   │
   ├── node server/server.js  ──► Express server on :3000
   │                                │
   │                                ├── SQLite (studycenter.db + photos.db, on local disk)
   │                                └── Static files served from /public
   │
   └── Local WiFi Router
          │
          ├── Admin's own browser  ──► http://localhost:3000
          ├── Staff tablet/phone   ──► http://192.168.x.x:3000
          └── Student's own phone  ──► http://192.168.x.x:3000/student-portal.html
```

There is no public internet exposure by default — every device must be on the same WiFi network as the host machine. `launch.bat` starts the server and opens it in an incognito Chrome window so no stale login cookie is ever carried in.

---

### 2. Authentication Flow

```
Admin Login ──► POST /api/admin/login ──► session row created (user_type='admin')
                                              │
Student Login ──► POST /api/student/login ──► session row created (user_type='student')
                                              │
                                              ▼
                                    HttpOnly session_token cookie set
                                              │
                                              ▼
                      Every subsequent .html and /api request passes through:
                      ┌─────────────────────────────────────────────┐
                      │  HTML Guard (server.js)                      │
                      │  → checks session_token, redirects to login  │
                      │  → enforces role: admin pages vs portal      │
                      ├─────────────────────────────────────────────┤
                      │  API Guard (server.js)                       │
                      │  → whitelist of public endpoints only        │
                      │  → everything else requires valid session    │
                      │  → students restricted to /api/student/*     │
                      └─────────────────────────────────────────────┘
```

- All sessions are wiped from the database on every server restart — a stale cookie from a previous run will always fail validation, forcing a fresh login.
- Passwords are hashed with `bcryptjs`. Students get a temporary password on admission; `password_changed_at` tracks whether they've set their own.
- A rolling in-memory rate limiter locks out an IP after repeated failed logins within a 15-minute window.

---

### 3. Seat Allocation Engine (`services/allocator.js`)

```
Admin enters: gender, start_time, end_time, (optional) target_date
                      │
                      ▼
        buildContext() — loads all active seats + active allocations
        overlapping the requested time range
                      │
                      ▼
        classifySection() — scores each section by current
        gender balance (keeps sections from skewing heavily
        toward one gender)
                      │
                      ▼
        sectionDistance() / minDistToSections() — penalizes
        seats far from where same-gender students already sit
                      │
                      ▼
        inTierScore() — combines gender balance + proximity
        into a single ranking per candidate seat
                      │
                      ▼
        proposeSeat() returns the single best-ranked seat
                      │
                      ▼
        Admin can accept the proposal OR manually override it
        → validateSeatSelection() checks the override is still
          time-range-free before allowing it
        → log-override endpoint permanently records the
          proposed seat, the chosen seat, and the stated reason
```

This is what allows "combo" students — a student with both a 6 AM–10 AM slot and a 6 PM–10 PM slot is simply two rows in `seat_allocations` with `active = 1`, not two student records. Nothing is ever deleted from this table; reallocating a student sets the old row's `active = 0` and `valid_to`, preserving full seat history.

---

### 4. Billing Lifecycle

```
runBillingGenerator() — runs on every server startup, idempotent
        │
        ▼
For each active student:
   getBillingStartMonth() resolves their personal cycle anchor
        │
        ▼
   monthsBetween() determines if a new billing_records row
   is due for the current month
        │
        ▼
   New row created: status = 'Due', base_fee from their
   fee_structure_id, admission_fee only on their first bill
```

```
runAuditEngine() — runs on every server startup, idempotent
        │
        ▼
Pass 1a — Due records past audit_day → fine applied,
          status flips to 'Overdue' (one-time, self-limiting)
        │
        ▼
Pass 1b — Partial records past partial_exemption_months →
          fine applied ONLY if partial_fine_amount > 0,
          status flips to 'Overdue' (prevents an infinite
          ₹0 re-fine loop on every restart)
        │
        ▼
Suspension check — students with billing records overdue
beyond suspension_threshold_months are automatically
moved to status = 'Suspended'
```

`isAuditDayPassed()` clamps the configured audit day to the actual last day of the target month before comparison — so an audit day of 30 or 31 never silently rolls over into the next month for February.

---

### 5. Reactivation Wizard (`routes/students.js`)

A suspended student cannot simply be flipped back to Active — the billing logic requires a strict three-step sequence:

```
Step 1 — prepare-reactivate
   Calculates all past-due billing_records using the student's
   ORIGINAL fee_structure (rates in effect when they fell behind),
   allows partial settlement before proceeding
        │
        ▼
Step 2 — Seat Selection
   Admin runs the allocator (or manual override) to assign
   the student's new seat for the post-reactivation period
        │
        ▼
Step 3 — prepare-current-month-bill
   ONLY after a seat is confirmed does the system calculate
   the current month's bill — using the NEW fee_structure
   tied to the newly chosen seat/hours
        │
        ▼
   reactivate — commits everything: status → 'Active',
   new seat_allocations row, current month billing_records row
```

This ordering exists because billing the current month before a seat is chosen would price the bill against the student's old (possibly no-longer-valid) hours.

---

### 6. Backup & Restore (`routes/backup.js`)

```
GET /api/backup/database
        │
        ▼
   PRAGMA wal_checkpoint(TRUNCATE) on both databases
   (flushes any unwritten WAL pages into the main files)
        │
        ▼
   archiver streams studycenter.db + photos.db into a
   single .zip, sent directly to the browser — no temp
   file ever written to disk
```

```
POST /api/backup/restore (multipart .zip upload)
        │
        ▼
   adm-zip extracts both entries in memory
        │
        ▼
   Each db file is restored independently via a safe
   tmp-copy + atomic overwrite pattern — the live
   `db` connection is NEVER closed, so the server keeps
   running throughout
        │
        ▼
   On any write failure, the pre-restore copy is
   automatically rolled back
```

```
POST /api/backup/reset (danger zone)
        │
        ▼
   Single transaction clears every table including
   sessions, student_auth, registration_requests,
   whatsapp_queue, reallocation_requests, and
   profile_edit_requests — no ghost records survive a reset
        │
        ▼
   photos.db is wiped separately, then init() re-seeds
   default settings rows
```

### 6b. Three-Tier Auto-Backup (`server.js`)

Independent of the manual backup button, the server takes its own snapshots using plain `fs.copyFileSync` — no zip library, nothing async, nothing that can meaningfully fail:

```
Startup  ──► snapshot taken BEFORE billingGenerator/auditEngine
             run, so a clean pre-modification state always exists
             │
Every 2hrs ──► snapshot taken silently while the server is running
             │
Shutdown ──► snapshot taken on the first Ctrl+C, before the
             "press again to exit" reminder is shown
             │
             ▼
   Each trigger type keeps only its last 5 snapshots —
   older files are deleted automatically on every run
```

Worst-case data loss in this model is bounded at roughly 2 hours, assuming the machine isn't hard-powered-off between snapshots.

---

### 7. Real-Time Updates (`services/liveStream.js`)

```
Admin browser ──► GET /api/live-stream (auth-gated SSE connection)
                          │
Any route that mutates data ──► broadcastChange('students' | 'payments' | 'seats' | ...)
                          │
                          ▼
            All connected admin browsers receive the event
            and re-fetch only the affected section — no
            full page reload, no polling interval
```

If a session expires while an SSE connection is open, the client-side `EventSource.onerror` handler detects the resulting 401, closes the connection immediately, and redirects to login — preventing the browser from retrying every 3 seconds indefinitely.

---

### 8. WhatsApp Reminder Queue (`routes/messages.js`)

StudyConsole does not send WhatsApp messages programmatically — there is no paid WhatsApp Business API integration. Instead:

```
Audit engine / billing events ──► insert row into whatsapp_queue
                                          │
                                          ▼
            Admin opens Messages tab ──► sees pending list with
                                          pre-filled message text
                                          │
                                          ▼
            Admin manually sends via WhatsApp Web ──► clicks
                                          "Mark as Sent" ──► row
                                          updated, removed from
                                          pending view
```

This keeps the product entirely free to run — no per-message cost, no API key, no rate limits to manage.

---

## Database Schema (Full)

StudyConsole uses **two separate SQLite database files**: `studycenter.db` holds all operational data, and `photos.db` holds only student photographs. They are kept apart so the constantly-queried operational tables stay fast and small, while large photo blobs live in their own file — both are bundled together in every backup.

### `studycenter.db`

#### `students`
The core record for every admitted student.

| Field | Type | Notes |
|---|---|---|
| `student_id` | INTEGER PK | |
| `name`, `gender`, `dob` | TEXT | `gender` constrained to `Male` \| `Female` \| `Other` |
| `phone`, `whatsapp`, `email`, `aadhaar_number` | TEXT | |
| `father_name`, `mother_name`, `emergency_contact`, `address` | TEXT | |
| `joining_date`, `leaving_date` | TEXT | |
| `duration_hours` | INTEGER | Sum of hours across all active allocations — supports combo (multi-shift) students |
| `fee_structure_id` | INTEGER FK → `fee_structures` | |
| `status` | TEXT | `Active` \| `Suspended` \| `Archived` (`Overdue` is a billing-level status only, never a student-level one) |
| `billing_start_month` | TEXT | `YYYY-MM` — anchors this student's personal billing cycle |
| `form_number`, `class`, `parent_occupation`, `nationality`, `religion`, `goal` | TEXT | Admission-form fields |
| `photo_path` | TEXT | Reference key into `photos.db`, not the image data itself |
| `address_village`, `address_po`, `address_ps`, `address_district`, `address_state`, `address_pin` | TEXT | Full postal breakdown, common in rural Indian addressing |
| `education_history` | TEXT | |
| `remarks`, `created_at`, `updated_at` | TEXT | |

#### `seats`
The physical seat inventory and its visual layout.

| Field | Type | Notes |
|---|---|---|
| `seat_id` | INTEGER PK | |
| `seat_number` | TEXT UNIQUE | Display label, e.g. `1`, `2`, `3` |
| `section` | TEXT | e.g. `A`, `B`, `C` — used by the allocator for gender balancing |
| `active` | INTEGER | `1` = usable, `0` = disabled (e.g. broken chair) |
| `grid_x`, `grid_y`, `rotation`, `frame_id` | INTEGER/TEXT | Coordinates for the drag-and-drop seat layout editor |
| `created_at` | TEXT | |

#### `seat_allocations`
The most important table in the system — every row is a single time-block assignment. Nothing is ever deleted, preserving full seat history.

| Field | Type | Notes |
|---|---|---|
| `allocation_id` | INTEGER PK | |
| `student_id` | INTEGER FK → `students` | |
| `seat_id` | INTEGER FK → `seats` | |
| `start_time`, `end_time` | TEXT | `HH:MM` 24-hour; may wrap past midnight (e.g. `22:00` → `04:00`) |
| `valid_from`, `valid_to` | TEXT | |
| `active` | INTEGER | A "combo" student simply has 2+ active rows here at once. Reallocating sets the old row's `active = 0` instead of deleting it |
| `created_at` | TEXT | |

#### `fee_structures`
Defines what a given number of daily study hours costs per month.

| Field | Type | Notes |
|---|---|---|
| `fee_structure_id` | INTEGER PK | |
| `hours_per_day` | INTEGER UNIQUE | |
| `monthly_fee` | REAL | |
| `active` | INTEGER | Inactive structures stay visible for historical billing records but can't be assigned to new students |
| `created_at` | TEXT | |

#### `billing_records`
One row per student per billing month.

| Field | Type | Notes |
|---|---|---|
| `billing_id` | INTEGER PK | |
| `student_id` | INTEGER FK → `students` | |
| `billing_month` | TEXT | `YYYY-MM` |
| `base_fee`, `admission_fee`, `fine_amount` | REAL | |
| `amount_paid`, `due_amount` | REAL | |
| `bill_number` | TEXT | |
| `payment_mode` | TEXT | `Cash` \| `UPI` \| `Other` |
| `payment_date` | TEXT | |
| `status` | TEXT | `Due` \| `Paid` \| `Overdue` \| `Partial` |
| `reminder_sent` | INTEGER | `0` = not sent, `1` = sent |
| `created_at` | TEXT | |

#### `payment_transactions`
An append-only ledger of every individual payment, even partial ones, against a `billing_records` row.

| Field | Type | Notes |
|---|---|---|
| `transaction_id` | INTEGER PK | |
| `payment_id` | TEXT UNIQUE | |
| `billing_id` | INTEGER FK → `billing_records` | |
| `amount_paid` | REAL | |
| `bill_number`, `payment_mode`, `payment_date` | TEXT | |
| `created_at` | TEXT | |

#### `audit_settings`
Single-row table (`setting_id = 1` always) controlling the fine and suspension engine.

| Field | Type | Notes |
|---|---|---|
| `audit_day` | INTEGER | Clamped to ≤28 by both frontend and backend — prevents day 29/30/31 silently overflowing into the next month in February |
| `fine_amount` | REAL | Fine applied to a `Due` record past the audit day |
| `admission_fee` | REAL | Default admission fee for new students |
| `partial_fine_amount` | REAL | Fine applied to a `Partial` record past its exemption period. Guarded against `0` to prevent an infinite re-fine loop on every restart |
| `partial_exemption_months` | INTEGER | Grace period before a `Partial` record becomes fineable |
| `suspension_threshold_months` | INTEGER | Months overdue before a student is auto-suspended |
| `updated_at` | TEXT | |

#### `app_settings`
Single-row table (`setting_id = 1` always) for institute-level configuration.

| Field | Type | Notes |
|---|---|---|
| `institute_name`, `institute_address`, `institute_phone` | TEXT | Shown on the public registration form and receipts |
| `total_seats`, `section_size` | INTEGER | |
| `operational_start_month` | TEXT | `YYYY-MM` — when billing logic goes live, used during transition from a manual to digital system |
| `created_at` | TEXT | |

#### `registration_requests`
Public admission intake — anyone can submit one without logging in.

| Field | Type | Notes |
|---|---|---|
| `request_id` | INTEGER PK | |
| `name`, `gender`, `dob`, `phone`, `whatsapp`, `email`, `aadhaar_number` | TEXT | |
| `father_name`, `mother_name`, `emergency_contact`, `address` | TEXT | |
| `joining_date` | TEXT | |
| `preferred_seat`, `preferred_start_time`, `preferred_end_time` | TEXT | Student's stated preference — not binding, admin runs the allocator separately |
| `status` | TEXT | `Pending` \| (admitted → row is consumed and a real `students` row created) |
| `form_number`, `class`, `parent_occupation`, `nationality`, `religion`, `goal`, `photo_path` | TEXT | Mirrors the admission form fields on `students` |
| `address_village`, `address_po`, `address_ps`, `address_district`, `address_state`, `address_pin`, `education_history` | TEXT | |
| `remarks`, `created_at`, `updated_at` | TEXT | |

#### `email_settings`
Single-row table (`setting_id = 1` always) for optional SMTP configuration.

| Field | Type | Notes |
|---|---|---|
| `smtp_host` | TEXT | Defaults to `smtp.gmail.com` |
| `smtp_port` | INTEGER | Defaults to `465` |
| `smtp_secure` | INTEGER | `1` = TLS |
| `sender_email`, `sender_password` | TEXT | App-password, not the account password |
| `active` | INTEGER | Email sending is entirely opt-in; off by default |

#### `seat_override_logs`
Permanent audit trail every time an admin manually overrides the allocator's seat proposal.

| Field | Type | Notes |
|---|---|---|
| `override_id` | INTEGER PK | |
| `student_id` | INTEGER FK → `students` (cascade delete) | |
| `proposed_seat`, `allocated_seat` | TEXT | What the algorithm suggested vs. what the admin actually chose |
| `reason` | TEXT | Required free-text justification |
| `admin_name`, `timestamp` | TEXT | |

#### `whatsapp_queue`
Holds outgoing reminder messages for the admin to send manually via WhatsApp Web — no paid API integration.

| Field | Type | Notes |
|---|---|---|
| `queue_id` | INTEGER PK | |
| `student_id` | INTEGER FK → `students` (cascade delete) | |
| `phone` | TEXT | |
| `message_type` | TEXT | e.g. overdue reminder, welcome message |
| `message_text` | TEXT | Pre-filled, ready to copy/send |
| `status` | TEXT | `Pending` \| `Sent` |
| `reference_id` | INTEGER | Links back to the triggering record (e.g. a `billing_id`) |
| `created_at`, `updated_at` | TEXT | |

#### `reallocation_requests`
Student-submitted seat or time-slot change requests, awaiting admin review.

| Field | Type | Notes |
|---|---|---|
| `request_id` | INTEGER PK | |
| `student_id` | INTEGER FK → `students` (cascade delete) | |
| `preferred_seat`, `preferred_start_time`, `preferred_end_time` | TEXT | |
| `reason` | TEXT | |
| `status` | TEXT | `Pending` \| `Approved` \| `Rejected` |
| `created_at`, `updated_at` | TEXT | |

#### `admins`
Admin login credentials. Typically a single row per installation.

| Field | Type | Notes |
|---|---|---|
| `admin_id` | INTEGER PK | |
| `username` | TEXT UNIQUE | |
| `password_hash` | TEXT | bcrypt |
| `created_at` | TEXT | |

#### `student_auth`
Login credentials for the student portal, separate from the `students` profile table.

| Field | Type | Notes |
|---|---|---|
| `student_id` | INTEGER PK, FK → `students` (cascade delete) | |
| `password_hash` | TEXT | bcrypt |
| `last_login` | TEXT | |
| `password_changed_at` | TEXT | `NULL` if still on the temporary password issued at admission |
| `created_at` | TEXT | |

#### `sessions`
Active login sessions for both admin and student users. Fully wiped on every server restart.

| Field | Type | Notes |
|---|---|---|
| `session_id` | TEXT PK | |
| `user_type` | TEXT | `admin` \| `student` |
| `user_id` | INTEGER | `student_id` for students; the admin's `admin_id` for admin sessions |
| `expires_at`, `created_at` | TEXT | |

#### `profile_edit_requests`
Students cannot edit their own profile directly — every change goes through this approval queue, mirroring nearly every editable field on `students`.

| Field | Type | Notes |
|---|---|---|
| `request_id` | INTEGER PK | |
| `student_id` | INTEGER FK → `students` (cascade delete) | |
| `name`, `gender`, `dob`, `phone`, `whatsapp`, `email`, `aadhaar_number` | TEXT | Proposed new values |
| `father_name`, `mother_name`, `emergency_contact`, `address` | TEXT | |
| `form_number`, `class`, `parent_occupation`, `nationality`, `religion`, `goal` | TEXT | |
| `address_village`, `address_po`, `address_ps`, `address_district`, `address_state`, `address_pin`, `education_history` | TEXT | |
| `photo_data` | TEXT | Proposed new photo, base64, pending approval before being written to `photos.db` |
| `status` | TEXT | `Pending` \| `Approved` \| `Rejected` |
| `created_at` | TEXT | |

#### `attendance_log`
One row per student per day — automatically inserted the moment a student logs into the portal.

| Field | Type | Notes |
|---|---|---|
| `date` | TEXT | Composite PK with `student_id` |
| `student_id` | INTEGER | Composite PK with `date` |
| `logged_in_at` | TEXT | First login timestamp of the day; `INSERT OR IGNORE` makes this idempotent — a student logging in multiple times in one day only creates one row |

**Indexes** — `studycenter.db` maintains indexes on `payment_transactions(billing_id)`, `seat_allocations(seat_id, active)`, `seat_allocations(student_id, active)`, `billing_records(student_id, billing_month)`, `reallocation_requests(status)`, and `attendance_log(date)` to keep the most frequent dashboard and billing queries fast even as records accumulate over years.

---

### `photos.db`

#### `student_photos`
Deliberately the only table in this second database file — keeps large image blobs fully isolated from the operational tables that are queried constantly.

| Field | Type | Notes |
|---|---|---|
| `student_id` | INTEGER PK | Matches the `student_id` in `studycenter.db`, but is **not** a SQL foreign key since it lives in a different database file |
| `photo_data` | TEXT NOT NULL | Base64-encoded image data |

---

## Running Locally

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
node server/server.js
```

Or, on Windows, double-click `launch.bat` — it kills any stale process on port 3000, starts the server, and opens an incognito Chrome window automatically.

### 3. First-run setup

On first launch, `init.js` creates all tables and seeds default `app_settings` / `audit_settings` rows. Log in as admin from `login.html` using the default credentials, then immediately set a new password from Settings.

### 4. Connecting other devices on the same WiFi

Find the host machine's local IP (`ipconfig` on Windows), then on any other device on the same network visit:

```
http://<host-machine-IP>:3000/student-portal.html
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | better-sqlite3 (synchronous, single-file, WAL mode) |
| Auth | Custom session-cookie system, bcryptjs password hashing |
| Real-time | Server-Sent Events (no WebSocket dependency) |
| Backup | archiver (zip write) + adm-zip (zip read) |
| Email | Nodemailer (optional SMTP, off by default) |
| Frontend | Vanilla HTML, CSS, JavaScript — no framework, no build step |
| Deployment | Single Windows machine, local WiFi network, no cloud hosting |

---

## Key Engineering Decisions

**Why local-only instead of cloud-hosted?**
The target customer is a small study centre, often in a town with inconsistent internet. A cloud dependency would mean the admin can't take attendance or record a payment during an outage. Running entirely on local hardware means the system works regardless of internet status; backups are the only thing that occasionally needs to leave the machine.

**Why a separate `photos.db` instead of storing photos inline in `studycenter.db`?**
Keeps the main operational database lean and fast for the queries that run constantly (billing, seat lookups), while photo blobs — which are large and rarely queried — live in their own file. Both are included together in every backup/restore so they never drift out of sync.

**Why `fs.copyFileSync` for auto-backup instead of zipping on every snapshot?**
Auto-backup runs unattended, with no admin watching. Plain file copy has effectively nothing that can fail beyond disk space — no archiver dependency, no async error surface, no risk of a half-written zip. The manual backup button (which the admin actively triggers) is where the zip format and photo bundling are worth the added complexity.

**Why does the audit engine clamp the audit day to ≤28?**
JavaScript's `Date` constructor silently overflows invalid day values — day 30 in February resolves to March 2 with no error or warning. An admin who set the audit day to "30" expecting end-of-month enforcement would see fines fire mysteriously late every February. Clamping at both the frontend input and the backend calculation removes the entire class of bug rather than patching one symptom.

**Why is partial-fine application guarded against `partial_fine_amount = 0`?**
The original fine logic always flipped a billing record's status to `Overdue` after fining it — except when the fine amount was 0, in which case adding 0 to the existing fine is a no-op and the status never changes. The record stayed `Partial` forever and was silently "re-fined" with ₹0 on every server restart. Guarding the fine application on `partial_fine_amount > 0` closes the loop entirely.

**Why does restore never call `db.close()`?**
`better-sqlite3`'s `db` handle is a module-level singleton shared by every route. Closing it to release the file lock during a restore meant every subsequent API call for the rest of that server session threw "Database is closed" — the server kept running but was completely non-functional until manually restarted. Restoring via a safe temp-file copy and atomic overwrite achieves the same goal without ever touching the live connection.

---

## Author

**Abhinav Kishore**

---

## License

Proprietary. Licensed per-installation to the purchasing study centre or library under a signed undertaking. Not licensed for redistribution, resale, or source code modification.
