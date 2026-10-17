# WorkTrack — Office Task Manager

Employees log their tasks with **start time, expected end time and actual end time**. The admin sees live status, delays and a performance score (%) for every employee.

## Features

**Employee (from their own PC)**
- Add a task: **Start now**, **Plan for later**, or **Already done** (to log past work)
- Priority: Urgent / High / Medium / Low, plus category/project
- Enter the start time and the expected end time (their own estimate), with quick +30m / +1h / +2h buttons
- Live timer, plus a reminder 10 minutes before the expected end and again when it's crossed
- **Hold / New work**: when other work comes in between, put the current task on hold with a reason and add and start the new work in one step. Hold time is **not** counted against them.
- **Complete**: enter the actual end time. If the task is late, a **reason box** must be filled in.
- Changing the expected end after a task has started needs a reason (the admin can see it)
- My Dashboard, My Tasks (filters), and My Performance (score, stars, on-time %)

**Admin**
- Dashboard: who is working on what right now (live), overdue tasks, KPIs, recent activity
- All Tasks: filter by employee, status, priority or period; **Export to Excel (CSV)**
- Assign tasks to employees
- **Delay Reviews**: accept or reject an employee's delay reason
- **Performance**: leaderboard with score %, ★ rating, on-time rate and hours worked
- Employees: add employees, edit them, deactivate them, reset passwords, see each employee's report

## How the score works
- Finished by the expected end → 100%
- Late → planned time ÷ actual working time (hold time is excluded)
- Delay reason accepted by admin → 100%; rejected → minus 10 points
- Open tasks past their expected end also count
- Weighted by priority (Urgent ×4, High ×3, Medium ×2, Low ×1)
- 90%+ ★★★★★ Excellent · 75%+ ★★★★ Good · 60%+ ★★★ Average · 40%+ ★★ Needs improvement · below that ★ Poor

## Setup (one time)

1. Pick **one office PC as the server** (usually the admin's PC). Install **Node.js 22 or newer** from https://nodejs.org (it's already installed on this PC).
2. Copy this folder to that PC and double-click **`START-TaskManager.bat`**.
3. The black window shows addresses like:
   ```
   On this PC:        http://localhost:3000
   Employees' PCs:    http://192.168.1.25:3000
   ```
4. First login: username **`admin`**, password **`admin@123`**. You'll be asked to set a new password right away (only this first time).
5. Go to **Employees → Add Employee** and create a username and password for each person. That password works as-is. Employees cannot change their password; only the admin can (**Employees → Reset password**).

## Employee PCs (no install needed)
- On each employee PC, open Chrome or Edge and go to `http://<server-PC-IP>:3000` (the "Employees' PCs" address).
- Bookmark it, or create a desktop shortcut (Chrome → ⋮ → Cast, save and share → *Create shortcut* → tick "Open as window"). It then opens like a normal app.
- Each employee logs in with their own username and password and only sees their own tasks.

**If employee PCs cannot open it:** Windows Firewall on the server PC is blocking port 3000. When Windows shows the "Allow access" popup the first time the app runs, click **Allow** (Private networks). Or ask your IT person to allow inbound TCP port 3000.

**Tip:** give the server PC a fixed IP address on the router, so the address doesn't change.

## Use it like a desktop app (server PC)
1. Double-click **`INSTALL-Desktop-Shortcut.bat`** once. A **WorkTrack** icon appears on the Desktop.
2. Double-click the **WorkTrack** icon. The server starts silently in the background (no black window) and WorkTrack opens in its own app window.
3. Closing the window does **not** stop the server, so employees can keep working. To fully stop it, run **`STOP-WorkTrack.bat`**.
4. Server messages are written to `data/server.log`.

## Portable zip (run on any PC, nothing to install)
Double-click **`MAKE-Portable-Zip.bat`**. It creates `Portable\WorkTrack-Portable.zip` (~35 MB), which includes its own Node.js runtime, so the other PC needs no Node.js or Python. The zip is a **fresh** copy with no data from this office. On the other PC: Extract All → double-click **`Open WorkTrack.bat`** → log in with `admin` / `admin@123` and set a new password.

## Backup
Double-click **`BACKUP-Now.bat`**. It saves the full app (frontend + backend + tools) and a safe snapshot of all data into **`Backup folder`**, as a folder and as a `.zip`, with a `RESTORE-GUIDE.txt` and SHA-256 `checksums.txt`. The newest 30 backups are kept. **Automatic:** a Windows task ("WorkTrack Daily Backup", set up by `SETUP-Daily-Backup.bat`) runs the backup silently every day at 7:00 PM; if the PC is off then, it runs as soon as the PC is on. Its log is `data/backup.log`. Copy the newest `.zip` to a pendrive or private Drive regularly. The backup folder is never served over the network.

## Forgot the admin password?
On the server PC, double-click **`RESET-Admin-Password.bat`**. Enter the username (just press Enter for `admin`), then type a new password twice. No data is lost.

## Daily use
- The server PC must be ON with the black window open during office hours.
- All data is saved in `data/taskmanager.db`. **Back up this file regularly** (copy it to a pendrive or drive).
- To change the port: `set PORT=8080` before starting.

## Files
| File | Purpose |
|---|---|
| `server.js` | API server, rules, score calculation |
| `db.js` | Database tables (SQLite, built into Node) |
| `public/` | Frontend (HTML, CSS, JS) |
| `START-TaskManager.bat` | Double-click to run |
