# 🧠 AI Classroom Monitor — Student Live Behaviour Monitoring

> A real-time, AI-powered virtual classroom attention tracking system built with **FastAPI**, **face-api.js**, and **WebSockets**.

---

## 📌 Overview

AI Classroom Monitor detects and logs student behaviour during live virtual classes using the student's own webcam — **no server-side camera required**. The teacher gets a live dashboard with per-student attention scores, alerts, a built-in chat, and an exportable session report.

| Role | What they see |
|------|---------------|
| **Teacher** | Live grid of student status cards, attention score bars, alert feed, chat, poll creator, session report |
| **Student** | Join page → webcam-based behaviour analysis running entirely in the browser |

---

## 🚀 Features

- 🎯 **Real-time attention scoring** — face detection, eye-blink rate, yawn detection, gaze estimation
- 👁️ **6-state classification** — Focused · Drowsy · Distracted · No Face · Yawn · Searching
- 📊 **Session reports** — per-student timeline chart + behaviour distribution chart + CSV export
- 💬 **Bi-directional chat** — teacher ↔ all students
- 📝 **Live polls / quizzes** — teacher creates, students answer, scores appear instantly
- 🔔 **Smart alerts** — teacher is notified when a student is drowsy/distracted repeatedly
- 🌐 **LAN + Tunnel support** — works on local network; Cloudflare tunnel for remote access
- 🗄️ **SQLite persistence** — every session and attention log stored in `classroom.db`

---

## 🗂️ Project Structure

```
classroom_monitor/
├── main.py              # FastAPI app — routes, WebSocket handlers, report generator
├── managers.py          # ConnectionManager — student admit/deny, status broadcast
├── database.py          # SQLAlchemy models & DB init
├── download_models.py   # Downloads face-api.js model weights into /models
├── requirements.txt     # Python dependencies
├── run.bat              # One-click Windows launcher
├── start_with_tunnel.py # Starts app + Cloudflare tunnel for remote access
├── models/              # face-api.js weight files (auto-downloaded)
├── static/              # CSS, JS, CNN model assets
└── templates/
    ├── index.html       # Landing page — create / join class
    ├── teacher.html     # Teacher dashboard
    └── student.html     # Student monitoring page
```

---

## ⚙️ Setup & Run

### Prerequisites
- Python 3.9+
- A modern browser (Chrome / Edge recommended for camera API)

### 1 — Clone the repository
```bash
git clone https://github.com/<your-username>/ai-classroom-monitor.git
cd ai-classroom-monitor/classroom_monitor
```

### 2 — Create a virtual environment
```bash
python -m venv venv
# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate
```

### 3 — Install dependencies
```bash
pip install -r requirements.txt
```

### 4 — Download face-api.js model weights
```bash
python download_models.py
```

### 5 — Run the server
```bash
python main.py
# or on Windows:
run.bat
```

Open **http://localhost:8000** in your browser.

---

## 🌐 Remote Access (Cloudflare Tunnel)

To let students join from outside your LAN:

1. Download `cloudflared.exe` from [Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) and place it next to `start_with_tunnel.py`.
2. Run:
   ```bash
   python start_with_tunnel.py
   ```
3. Share the generated `https://` URL with students.

---

## 📡 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Landing page |
| `POST` | `/create_class` | Generate a new class ID |
| `GET` | `/teacher?class_id=XXX` | Teacher dashboard |
| `GET` | `/student?class_id=XXX` | Student monitoring page |
| `WS` | `/ws/teacher/{class_id}` | Teacher WebSocket |
| `WS` | `/ws/student/{class_id}/{student_id}` | Student WebSocket |
| `GET` | `/api/report_html/{class_id}` | HTML session report with charts |
| `GET` | `/api/report/{class_id}` | CSV raw data export |

---

## 🧬 How the AI Works

All inference runs **client-side in the browser** using [face-api.js](https://github.com/justadudewhohacks/face-api.js):

1. **Tiny Face Detector** — locates the face in each webcam frame
2. **68-point Landmark Model** — maps eyes, mouth, jaw, eyebrows
3. **Face Expression Model** — classifies expression (happy, sad, angry, surprised, …)
4. Custom JS logic computes:
   - **EAR** (Eye Aspect Ratio) → drowsiness / blink rate
   - **MAR** (Mouth Aspect Ratio) → yawn detection
   - **Head pose** via landmark symmetry → distracted / searching
5. An **attention score (0–100%)** is derived from a weighted combination of the above signals and sent to the server every few seconds via WebSocket.

---

## 🗄️ Database Schema

```
class_sessions      — session_id, created_at
student_sessions    — id, session_id, student_id, name, joined_at
attention_logs      — id, student_db_id, status, detail, attention_score, timestamp
```

---

## 📦 Dependencies

See [requirements.txt](requirements.txt)

| Package | Purpose |
|---------|---------|
| `fastapi` | Async web framework |
| `uvicorn` | ASGI server |
| `jinja2` | HTML templating |
| `sqlalchemy` | ORM & DB management |
| `websockets` | WebSocket support |
| `aiofiles` | Async file I/O |
| `python-multipart` | Form data parsing |

---

## 🤝 Contributing

1. Fork the repo
2. Create your branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "feat: add my feature"`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

---

## 📜 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 👩‍💻 Authors

- Developed as a Deep Learning Mini Project
- Face detection powered by [face-api.js](https://github.com/justadudewhohacks/face-api.js)
- Backend powered by [FastAPI](https://fastapi.tiangolo.com/)
