from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import uuid, socket, asyncio, json, csv, io, pathlib
import uvicorn

from database import init_db, SessionLocal, AttentionLog, StudentSession
from managers import ConnectionManager

# ── Init ──────────────────────────────────────────────────────────────────
init_db()
app = FastAPI(title="AI Classroom Monitor")
manager = ConnectionManager()

# ── Middleware ────────────────────────────────────────────────────────────
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

class PermissionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["Permissions-Policy"] = "camera=*, microphone=*"
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        # Prevent browser from caching HTML pages so updated code always loads
        ct = response.headers.get("content-type", "")
        if "text/html" in ct:
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
        return response

app.add_middleware(PermissionMiddleware)


# ── Static / Templates ────────────────────────────────────────────────────
models_dir = pathlib.Path("models")
models_dir.mkdir(exist_ok=True)
static_dir = pathlib.Path("static")
static_dir.mkdir(exist_ok=True)

app.mount("/models", StaticFiles(directory="models"), name="models")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ── Server IP ─────────────────────────────────────────────────────────────
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

SERVER_IP = get_local_ip()
print(f"[SERVER] LAN IP: {SERVER_IP}")

# ── Pages ─────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "server_ip": SERVER_IP})

@app.post("/create_class")
async def create_class():
    class_id = str(uuid.uuid4())[:6].upper()
    return JSONResponse({"class_id": class_id, "server_ip": SERVER_IP})

@app.get("/teacher", response_class=HTMLResponse)
async def teacher_ui(request: Request, class_id: str = Query(None)):
    if not class_id:
        return RedirectResponse(url="/")
    class_id = class_id.strip().upper()
    return templates.TemplateResponse("teacher.html", {"request": request,
                                                        "class_id": class_id,
                                                        "server_ip": SERVER_IP})

@app.get("/student", response_class=HTMLResponse)
async def student_ui(request: Request, class_id: str = Query(...)):
    class_id = class_id.strip().upper()
    return templates.TemplateResponse("student.html", {"request": request,
                                                        "class_id": class_id,
                                                        "server_ip": SERVER_IP})

# ── Report ────────────────────────────────────────────────────────────────
@app.get("/api/report_html/{class_id}", response_class=HTMLResponse)
async def get_report_html(class_id: str):
    db = SessionLocal()
    try:
        rows = (db.query(AttentionLog, StudentSession)
                .join(StudentSession, AttentionLog.student_db_id == StudentSession.id)
                .filter(StudentSession.session_id == class_id)
                .order_by(AttentionLog.timestamp).all())
    finally:
        db.close()

    # Group data per student
    from collections import defaultdict
    students = defaultdict(lambda: {"name": "", "times": [], "scores": [], "states": []})
    for log, st in rows:
        sid = st.student_id
        students[sid]["name"] = st.name
        students[sid]["times"].append(log.timestamp.strftime("%H:%M:%S"))
        students[sid]["scores"].append(round(log.attention_score * 100, 1))
        students[sid]["states"].append(log.status)

    STATUS_COLORS = {
        "Focused":    "#10b981",
        "Attentive":  "#10b981",
        "Ok":         "#10b981",
        "Drowsy":     "#ef4444",
        "Distracted": "#f97316",
        "No Face":    "#8b5cf6",
        "Yawn":       "#eab308",
        "Searching":  "#6b7280",
    }
    STATE_LIST = ["Focused", "Drowsy", "Distracted", "No Face", "Yawn", "Searching"]
    STATE_COLOR_LIST = ["#10b981", "#ef4444", "#f97316", "#8b5cf6", "#eab308", "#6b7280"]

    # Build per-student summary stats
    summary_rows_html = ""
    charts_html = ""

    import json as _json

    for sid, d in students.items():
        name = d["name"]
        states = d["states"]
        total = len(states)
        if total == 0:
            continue

        counts = {s: states.count(s) for s in STATE_LIST}
        focused_pct = round(100 * (counts.get("Focused", 0) + counts.get("Attentive", 0) + counts.get("Ok", 0)) / total, 1)
        alert_count = counts.get("Drowsy", 0) + counts.get("Distracted", 0) + counts.get("No Face", 0)
        top_issue = max(["Drowsy", "Distracted", "No Face", "Yawn"], key=lambda x: counts.get(x, 0))
        if counts.get(top_issue, 0) == 0:
            top_issue = "None"

        summary_rows_html += f"""
        <tr>
            <td>{name}</td>
            <td>{focused_pct}%</td>
            <td>{alert_count}</td>
            <td>{top_issue}</td>
        </tr>"""

        # Timeline chart data
        times_js = _json.dumps(d["times"])
        scores_js = _json.dumps(d["scores"])
        point_colors = _json.dumps([STATUS_COLORS.get(s, "#6b7280") for s in states])

        # Stacked bar: group per minute bucket
        from collections import Counter
        minute_buckets = defaultdict(list)
        for t, s in zip(d["times"], states):
            bucket = t[:5]  # HH:MM
            minute_buckets[bucket].append(s)

        buckets = sorted(minute_buckets.keys())
        stacked_datasets = []
        for state, color in zip(STATE_LIST, STATE_COLOR_LIST):
            vals = [minute_buckets[b].count(state) for b in buckets]
            if any(v > 0 for v in vals):
                stacked_datasets.append({"label": state, "data": vals, "backgroundColor": color})

        buckets_js = _json.dumps(buckets)
        stacked_js = _json.dumps(stacked_datasets)

        chart_id_line = f"line_{sid.replace('-', '_')}"
        chart_id_bar = f"bar_{sid.replace('-', '_')}"

        charts_html += f"""
        <div class="student-section">
            <h2 class="student-name">{name} <span class="student-id">({sid})</span></h2>
            <div class="charts-row">
                <div class="chart-box">
                    <h3>Attention Score Over Time</h3>
                    <canvas id="{chart_id_line}"></canvas>
                </div>
                <div class="chart-box">
                    <h3>Behaviour Distribution (per Minute)</h3>
                    <canvas id="{chart_id_bar}"></canvas>
                </div>
            </div>
        </div>
        <script>
        (function(){{
            var ctxL = document.getElementById('{chart_id_line}').getContext('2d');
            new Chart(ctxL, {{
                type: 'line',
                data: {{
                    labels: {times_js},
                    datasets: [{{
                        label: 'Attention %',
                        data: {scores_js},
                        borderColor: '#6366f1',
                        backgroundColor: 'rgba(99,102,241,0.08)',
                        pointBackgroundColor: {point_colors},
                        pointRadius: 4,
                        tension: 0.35,
                        fill: true
                    }}]
                }},
                options: {{
                    responsive: true,
                    plugins: {{ legend: {{ labels: {{ color:'#ccc' }} }} }},
                    scales: {{
                        x: {{ ticks: {{ color:'#888', maxTicksLimit: 10 }}, grid: {{ color:'rgba(255,255,255,0.05)' }} }},
                        y: {{ min: 0, max: 100, ticks: {{ color:'#888' }}, grid: {{ color:'rgba(255,255,255,0.05)' }} }}
                    }}
                }}
            }});

            var ctxB = document.getElementById('{chart_id_bar}').getContext('2d');
            new Chart(ctxB, {{
                type: 'bar',
                data: {{
                    labels: {buckets_js},
                    datasets: {stacked_js}
                }},
                options: {{
                    responsive: true,
                    plugins: {{ legend: {{ labels: {{ color:'#ccc' }} }} }},
                    scales: {{
                        x: {{ stacked: true, ticks: {{ color:'#888' }}, grid: {{ color:'rgba(255,255,255,0.05)' }} }},
                        y: {{ stacked: true, ticks: {{ color:'#888' }}, grid: {{ color:'rgba(255,255,255,0.05)' }} }}
                    }}
                }}
            }});
        }})();
        </script>"""

    session_date = rows[0][1].joined_at.strftime("%d %b %Y") if rows else "N/A"
    total_students = len(students)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Session Report — {class_id}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{background:#070a13;color:#e2e8f0;font-family:'Segoe UI',Arial,sans-serif;padding:32px}}
  header{{text-align:center;margin-bottom:40px}}
  header h1{{font-size:2rem;font-weight:900;letter-spacing:-.03em;background:linear-gradient(135deg,#6366f1,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}}
  header p{{color:#6b7280;font-size:.85rem;margin-top:6px}}
  .meta-bar{{display:flex;gap:24px;justify-content:center;margin-bottom:40px;flex-wrap:wrap}}
  .meta-chip{{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 24px;text-align:center}}
  .meta-chip .val{{font-size:1.6rem;font-weight:900;color:#6366f1}}
  .meta-chip .lbl{{font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;font-weight:700}}
  .section-title{{font-size:.7rem;text-transform:uppercase;letter-spacing:.2em;color:#6366f1;font-weight:800;margin-bottom:16px}}
  table{{width:100%;border-collapse:collapse;margin-bottom:48px;background:rgba(255,255,255,0.03);border-radius:12px;overflow:hidden}}
  th{{background:rgba(99,102,241,0.15);padding:12px 16px;text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#a5b4fc;font-weight:800}}
  td{{padding:12px 16px;font-size:.85rem;border-top:1px solid rgba(255,255,255,0.05)}}
  tr:hover td{{background:rgba(255,255,255,0.03)}}
  .student-section{{margin-bottom:56px}}
  .student-name{{font-size:1.1rem;font-weight:800;margin-bottom:4px;color:#e2e8f0}}
  .student-id{{font-size:.75rem;color:#6b7280;font-weight:400}}
  .charts-row{{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:16px}}
  .chart-box{{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:20px}}
  .chart-box h3{{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;font-weight:700;margin-bottom:16px}}
  .csv-btn{{display:inline-block;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:800;font-size:.8rem;letter-spacing:.05em;box-shadow:0 4px 20px rgba(99,102,241,.35);transition:opacity .2s}}
  .csv-btn:hover{{opacity:.85}}
  .empty{{text-align:center;padding:80px;color:#6b7280;font-style:italic}}
  @media(max-width:700px){{.charts-row{{grid-template-columns:1fr}}}}
</style>
</head>
<body>
<header>
  <h1>📊 Session Behaviour Report</h1>
  <p>Class ID: <strong style="color:#6366f1">{class_id}</strong> &nbsp;|&nbsp; Date: {session_date}</p>
</header>

<div class="meta-bar">
  <div class="meta-chip"><div class="val">{total_students}</div><div class="lbl">Students</div></div>
  <div class="meta-chip"><div class="val">{len(rows)}</div><div class="lbl">Data Points</div></div>
</div>

<p class="section-title">Class Overview</p>
{"<table><thead><tr><th>Student</th><th>Focus %</th><th>Alerts</th><th>Top Issue</th></tr></thead><tbody>" + summary_rows_html + "</tbody></table>" if summary_rows_html else '<p class="empty">No data recorded for this session yet.</p>'}

<p class="section-title">Per-Student Behaviour Analysis</p>
{charts_html if charts_html else '<p class="empty">No timeline data available.</p>'}

<div style="text-align:center;margin-top:40px">
  <a class="csv-btn" href="/api/report/{class_id}" download>⬇ Download Raw CSV</a>
</div>
</body>
</html>"""
    return HTMLResponse(content=html)


@app.get("/api/report/{class_id}")
async def get_report(class_id: str):
    db = SessionLocal()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Student Name", "Student ID", "Timestamp", "Status", "Detail"])
    try:
        rows = (db.query(AttentionLog, StudentSession)
                .join(StudentSession, AttentionLog.student_db_id == StudentSession.id)
                .filter(StudentSession.session_id == class_id)
                .order_by(AttentionLog.timestamp).all())
        for log, st in rows:
            w.writerow([st.name, st.student_id,
                        log.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                        log.status, log.detail])
    finally:
        db.close()
    out.seek(0)
    return StreamingResponse(iter([out.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename=report_{class_id}.csv"})

# ── WebSocket: Student ────────────────────────────────────────────────────
@app.websocket("/ws/student/{class_id}/{student_id}")
async def ws_student(websocket: WebSocket, class_id: str, student_id: str):
    class_id = class_id.strip().upper()
    event = asyncio.Event()
    await manager.connect_student(websocket, class_id, student_id, event)

    async def receive_info():
        try:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            if msg.get("type") == "info":
                await manager.update_pending_name(class_id, student_id,
                                                  msg.get("name", "Student"))
        except Exception:
            pass

    recv_task = asyncio.create_task(receive_info())
    try:
        await asyncio.wait_for(event.wait(), timeout=300)
    except asyncio.TimeoutError:
        manager.disconnect_student(class_id, student_id)
        return

    # CRITICAL: fully cancel recv_task and await it before starting the main
    # receive loop. Without this, both coroutines race to read from the same
    # WebSocket and the first status_update messages get silently dropped.
    recv_task.cancel()
    try:
        await recv_task
    except (asyncio.CancelledError, Exception):
        pass

    if student_id not in manager.active_connections.get(class_id, {}):
        return  # Denied

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                t = msg.get("type")
                if t == "status_update":
                    data = msg.get("data", {})
                    status = data.get("status", "?")
                    name = data.get("name", "?")
                    print(f"[STATUS] {student_id} ({name}): {status}")
                    await manager.update_student_status(class_id, student_id, data)
                elif t == "summary_update":
                    await manager.broadcast_summary(class_id, student_id, msg.get("data", {}))
                elif t == "signal":
                    await manager.handle_signal(class_id, student_id,
                                                msg.get("target_id"), msg.get("data", {}),
                                                sender_type="student")
                elif t == "chat_message":
                    name = msg.get("name", "Student")
                    text = msg.get("text", "")
                    if text.strip():
                        await manager.send_chat_to_teachers(class_id, student_id, name, text)
                elif t == "poll_submission":
                    await manager.broadcast_to_teachers(class_id, {
                        "type": "poll_submission",
                        "student_id": student_id,
                        "name": msg.get("name", "Student"),
                        "score": msg.get("score"),
                        "total": msg.get("total")
                    })
            except Exception as e:
                print(f"[WS-S] msg error: {e}")
    except WebSocketDisconnect:
        manager.disconnect_student(class_id, student_id)
        await manager.broadcast_participant_count(class_id)

# ── WebSocket: Teacher ────────────────────────────────────────────────────
@app.websocket("/ws/teacher/{class_id}")
async def ws_teacher(websocket: WebSocket, class_id: str):
    class_id = class_id.strip().upper()
    await manager.connect_teacher(websocket, class_id)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                cmd = msg.get("command")
                t = msg.get("type")
                if cmd == "admit":
                    await manager.admit_student(class_id, msg.get("student_id"),
                                                msg.get("name", "Student"))
                    await manager.broadcast_participant_count(class_id)
                elif cmd == "deny":
                    await manager.deny_student(class_id, msg.get("student_id"))
                elif t == "signal":
                    tid = msg.get("target_id")
                    if tid:
                        await manager.handle_signal(class_id, "teacher", tid,
                                                    msg.get("data", {}), sender_type="teacher")
                elif t == "chat_message":
                    text = msg.get("text", "")
                    if text.strip():
                        await manager.send_chat_to_students(class_id, text)
                elif cmd == "start_poll":
                    await manager.broadcast_to_students(class_id, {
                        "type": "start_poll",
                        "questions": msg.get("questions", [])
                    })
            except Exception as e:
                print(f"[WS-T] msg error: {e}")
    except WebSocketDisconnect:
        manager.disconnect_teacher(websocket, class_id)

# ── Entry ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("Starting AI Classroom Monitor on http://0.0.0.0:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
