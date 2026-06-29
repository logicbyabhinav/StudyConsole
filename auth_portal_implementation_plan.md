# Implementation Plan: Authentication, Login Portal, Student Portal, and Profile Edit Requests

This plan details the implementation of security guarding, local multi-role authentication (Admin and Student), a student portal with profile edit/seat change requests, and Wifi desk QR support for the StudyCenter Admin Console.

---

## Proposed Changes

### 1. Database Schema Extensions

We will add migrations to the SQLite database to store sessions, administrator accounts, student authentication credentials, and request types.

#### [MODIFY] [schema.sql](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/server/db/schema.sql)
We will define the new tables and database schemas:
```sql
CREATE TABLE IF NOT EXISTS admins (
  admin_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS student_auth (
  student_id            INTEGER PRIMARY KEY,
  password_hash         TEXT NOT NULL,
  last_login            TEXT,
  password_changed_at   TEXT, -- NULL if temp password, timestamp when updated
  created_at            TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  user_type     TEXT NOT NULL, -- 'admin' | 'student'
  user_id       INTEGER,         -- student_id (null if admin)
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_edit_requests (
  request_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id        INTEGER NOT NULL,
  name              TEXT NOT NULL,
  gender            TEXT NOT NULL,
  dob               TEXT NOT NULL,
  phone             TEXT NOT NULL,
  whatsapp          TEXT,
  email             TEXT,
  aadhaar_number    TEXT,
  father_name       TEXT,
  mother_name       TEXT,
  emergency_contact TEXT,
  address           TEXT,
  status            TEXT NOT NULL DEFAULT 'Pending', -- 'Pending' | 'Approved' | 'Rejected'
  created_at        TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS seat_change_requests (
  request_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id            INTEGER NOT NULL,
  preferred_seat        TEXT NOT NULL,
  preferred_start_time  TEXT NOT NULL,
  preferred_end_time    TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'Pending', -- 'Pending' | 'Approved' | 'Rejected'
  created_at            TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
);
```

#### [MODIFY] [init.js](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/server/db/init.js)
* Implement `migrateAuthTables()` to:
  * Create `admins`, `student_auth`, `sessions`, `profile_edit_requests`, and `seat_change_requests` tables.
  * Seed a default administrator credential:
    * Username: `admin`
    * Password: `admin123` (hashed with bcrypt)
  * Backfill existing student records:
    * For each student missing a record in `student_auth`, generate a temporary password (format: `Study@` + random 4-digit number), hash it using bcrypt, and save it in `student_auth` with `password_changed_at = NULL`.

---

### 2. Backend Security & Route Guarding

We will create helper functions and Express middleware to handle token parsing, session lookup, and route protection.

#### [NEW] [auth.js](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/server/services/auth.js)
Create helper service for session checking:
* Hashing passwords using **bcryptjs**.
* Creating session records.
* Validating request cookies and parsing session timeouts.
* Implement `cleanupExpiredSessions()` running on startup and hourly to prune old sessions from the database.

#### [MODIFY] [server.js](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/server/server.js)
Add route protection middlewares **before** static folders are served:
1. **HTML Guard**:
   * Inspect requests for `.html` files and root `/`.
   * Allow access to `/login.html` and `/register.html` without credentials.
   * If a session is valid:
     * Allow admin pages for `admin` role.
     * Allow `/student-portal.html` for both `student` and `admin` roles.
     * Otherwise redirect to `/login.html`.
2. **API Guard**:
   * Guard all `/api/...` routes except public ones (`/api/auth/login`, `/api/registrations`, `/api/registrations/config`, `/api/app-settings` [GET only], `/api/seats/available`).
   * Verify session expiration. Custom timeouts:
     * **Student Portal Session**: **60 minutes**
     * **Admin Console Session**: **4 hours**
   * Return a `401 Unauthorized` JSON payload to unauthorized/expired clients.

---

### 3. Security & Access Control Architecture

We will implement strict server-side safeguards to guarantee student data privacy and prevent database manipulation over the shared local Wi-Fi:

* **HttpOnly Session Cookies**: The `session_token` cookie is set with `HttpOnly; SameSite=Strict; Path=/` to prevent client-side script access and CSRF exploits.
* **Server-Side Ownership Binding**: The backend extracts the authenticated student ID directly from the validated session record rather than trusting client-provided query parameters.
* **Role-Based API Guarding**: Admin-only APIs check `session.user_type === 'admin'` and reject all other request headers with `403 Forbidden`.
* **Staging Writes Only**: Students are restricted from writing to production tables. Submitting profile updates or seat changes executes inserts strictly to staging tables, requiring explicit admin console approval.

---

### 4. New Authentication and Student API Routes

We will build the endpoints for logging in, logging out, retrieving student portal data, submitting requests, and changing passwords.

#### [NEW] [auth.js](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/server/routes/auth.js)
Expose standard router routes:
* `POST /api/auth/login` -> Authenticates credentials, issues cookie. (Forces students with `password_changed_at IS NULL` to change their password).
* `POST /api/auth/logout` -> Clears cookie and deletes session from DB.
* `GET /api/student/me` -> Serves current logged-in student profiles, seat allocations, billing registers, and message histories.
* `POST /api/student/change-password` -> Allows logged-in students to change their portal password. Sets `password_changed_at = timestamp`.
* `POST /api/student/edit-profile` -> Creates a pending profile edit request inside the `profile_edit_requests` table (overwriting any existing pending request for this student).
* `POST /api/student/request-seat` -> Creates a pending seat change request inside `seat_change_requests` table (overwriting any existing pending request for this student).
* `POST /api/admin/change-password` -> Allows authenticated admins to update their console password.

#### [MODIFY] [registrations.js](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/server/routes/registrations.js)
* Update registrations listing endpoint to return:
  * **New Admission Requests** (type: `New Admission`)
  * **Profile Update Requests** (type: `Profile Update`)
  * **Seat Change Requests** (type: `Seat Change`)
* Add endpoints to approve and reject profile edit and seat change requests:
  * `POST /api/registrations/edit/:id/approve` / `reject` -> Handles student profile edits.
  * `POST /api/registrations/seat/:id/approve` / `reject` -> Approves the seat change (checks override parameters and logs overrides if applicable).

#### [MODIFY] [students.js](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/server/routes/students.js)
* **Admit Approval Flow Update**:
  * When admitting a student, automatically generate a temporary password (format: `Study@` + random 4-digit number).
  * Save the hashed temporary password inside the `student_auth` table.
  * Include this temporary password and their generated Student ID inside the welcome confirmation email:
    > *Temporary Password:* `Study@1234`
    > *(Please change your temporary password upon logging into the student portal for the first time)*

---

### 5. Frontend & User Interface Upgrades

#### [NEW] [login.html](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/public/login.html)
* Design a premium, fully responsive, glassmorphic login interface.
* Features tabs to switch between **Student Desk Portal** (default) and **Admin Access**.
* Student mode: Input Student ID (e.g. `STC-0006` or `6`) and Password.
* Forces redirection to a **Change Default Password** screen on the student portal if they are still using their temporary credentials.

#### [NEW] [student-portal.html](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/public/student-portal.html)
* Build a premium, card-based interface for student self-service.
* Sections:
  1. **My Desk & Timings**: Displays currently allocated seats and shift schedules. Includes a prominent **Request Seat Change** button.
  2. **My Details (Edit Profile)**: Form displaying their full digital profile. Students can edit their personal/family fields (name, phone, address, parents) and click "Submit Profile Update".
  3. **Fees & Ledger History**: Full table of expected, paid, and outstanding dues. Allows students to open and print payment receipts locally.
  4. **Official Notices & Logs**: Displays sent payment reminders and a chronological log of registration/profile/seat request state transitions (e.g., `[Date] - Profile edit request APPROVED by Admin`).
  5. **Security Settings**: Allows students to update their password.
* Modal overlays for **Seat Change Request** (selecting preferred seat slot).

#### [MODIFY] [common.js](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/public/js/common.js)
* Update `api(...)` helper function: if status is `401`, automatically redirect to `/login.html`.
* Inject a **Logout** button dynamically in the admin sidebar.
* Wire it up to trigger `/api/auth/logout`.

#### [MODIFY] [students.html](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/public/students.html)
* Update the "Requests" tab of the admin console:
  * Render card list showing **New Admission Requests**, **Profile Update Requests**, and **Seat Change Requests**.
  * Highlight details differences cleanly.
  * Provide **Approve** and **Reject** action buttons.

#### [MODIFY] [settings.html](file:///d:/Dev/StudyCentrre_ManagementSystem/New%20folder/prototype/public/settings.html)
* Add a card panel under the Administrator settings to update the admin console password.

---

## Edge Case Scenarios

| Edge Case | Scenario | Resolution |
| :--- | :--- | :--- |
| **Session Expired Mid-Action** | Student clicks "Submit Profile Update" or Admin clicks "Approve" after the session limit. | The request is rejected with `401 Unauthorized` by the backend API. The client-side `api()` helper redirects the browser to `login.html` with a message. |
| **Multiple Profile Requests** | Student submits multiple edit requests before the administrator takes action on the first one. | The backend executes an `INSERT OR REPLACE` (or deletes the previous pending request for that student). Only the latest requested diff is shown to the admin, keeping the queue clean. |
| **Status Changes** | Student is Suspended or Archived while logged in or attempting to submit edits. | 1. If Suspended/Archived, the portal blocks the "Submit" button and displays their billing ledger. <br>2. The backend route `/api/student/edit-profile` verifies the student's status is `'Active'` and rejects calls with `403 Forbidden` if they are suspended/archived. |
| **Forgotten Admin Password** | Administrator changes password from Settings and forgets it. | Since it is a local app, we will provide a manual reset command in the documentation: `node reset_admin_password.js` to reset it back to `admin123`. |

---

## Verification Plan

### Automated Verification
* Start server and verify migrations complete without error.
* Check that opening `http://localhost:3000/dashboard.html` redirects to `/login.html`.
* Check that fetching `/api/students` directly returns status `401`.

### Manual Verification
* Log in as admin (`admin`/`admin123`). Verify successful navigation to the dashboard.
* Log in as a student using their Student ID (e.g. `6` or `STC-0006`) and default password (their Aadhaar number).
* In the Student Portal, modify details (e.g. change phone or address) and click "Submit Profile Update".
* Verify that details are not directly updated on their profile.
* Log in as admin, go to the **Requests** tab under Students, and verify that the edit request is visible with a clear diff.
* Approve the edit request as admin, and verify that the student's profile is updated instantly in real-time.
