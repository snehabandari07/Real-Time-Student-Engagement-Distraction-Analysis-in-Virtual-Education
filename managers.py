from typing import List, Dict, Any
from fastapi import WebSocket
import json
import asyncio
from database import SessionLocal, ClassSession, StudentSession, AttentionLog
from datetime import datetime


class ConnectionManager:
    def __init__(self):
        # Active connections: {class_id: {student_id: WebSocket}}
        self.active_connections: Dict[str, Dict[str, WebSocket]] = {}
        # Teacher connections: {class_id: List[WebSocket]}
        self.teacher_connections: Dict[str, List[WebSocket]] = {}
        # Latest status per student: {class_id: {student_id: dict}}
        self.student_statuses: Dict[str, Dict[str, Any]] = {}
        # Pending (not yet admitted): {class_id: {student_id: WebSocket}}
        self.pending_connections: Dict[str, Dict[str, WebSocket]] = {}
        self.pending_names: Dict[str, Dict[str, str]] = {}
        self.admission_events: Dict[str, Dict[str, Any]] = {}

    def _db(self):
        return SessionLocal()

    # ── Student lifecycle ────────────────────────────────────────────────
    async def connect_student(self, ws: WebSocket, class_id: str, student_id: str, event=None):
        await ws.accept()
        for d in [self.pending_connections, self.pending_names,
                  self.admission_events, self.student_statuses]:
            d.setdefault(class_id, {})
        self.pending_connections[class_id][student_id] = ws
        if event:
            self.admission_events[class_id][student_id] = event
        print(f"[JOIN] {student_id} requesting class {class_id}")
        await self.broadcast_to_teachers(class_id, {
            "type": "join_request",
            "student_id": student_id,
            "data": {"name": "Requesting..."}
        })

    async def update_pending_name(self, class_id: str, student_id: str, name: str):
        self.pending_names.setdefault(class_id, {})[student_id] = name
        teachers = self.teacher_connections.get(class_id, [])
        if not teachers:
            # Auto-admit when no teacher online
            print(f"[AUTO-ADMIT] {student_id} (no teacher)")
            await self.admit_student(class_id, student_id, name)
            return
        await self.broadcast_to_teachers(class_id, {
            "type": "join_request",
            "student_id": student_id,
            "data": {"name": name}
        })

    async def admit_student(self, class_id: str, student_id: str, name: str = "Student"):
        pending = self.pending_connections.get(class_id, {})
        if student_id not in pending:
            return False
        ws = pending.pop(student_id)
        self.active_connections.setdefault(class_id, {})[student_id] = ws
        name = self.pending_names.get(class_id, {}).pop(student_id, name)

        self.student_statuses[class_id][student_id] = {
            "status": "Connected", "detail": "Just joined",
            "last_seen": "now", "name": name
        }
        # DB
        db = self._db()
        try:
            if not db.query(ClassSession).filter_by(id=class_id).first():
                db.add(ClassSession(id=class_id)); db.commit()
            st = StudentSession(student_id=student_id, session_id=class_id, name=name)
            db.add(st); db.commit()
            self.student_statuses[class_id][student_id]["db_id"] = st.id
        except Exception as e:
            print(f"[DB] admit error: {e}")
        finally:
            db.close()

        # Tell student they're admitted
        others = [
            {"id": sid, "name": self.student_statuses[class_id][sid].get("name", "?")}
            for sid in self.active_connections.get(class_id, {})
            if sid != student_id
        ]
        await ws.send_json({"type": "admitted", "students": others})

        # Tell other students a peer joined
        for sid, sw in self.active_connections.get(class_id, {}).items():
            if sid != student_id:
                try:
                    await sw.send_json({"type": "student_joined", "student_id": student_id, "name": name})
                except: pass

        # Unblock waiting coroutine
        evt = self.admission_events.get(class_id, {}).pop(student_id, None)
        if evt:
            evt.set()

        await self.broadcast_to_teachers(class_id, {
            "type": "student_admitted",
            "student_id": student_id,
            "data": self.student_statuses[class_id][student_id]
        })
        print(f"[ADMIT] {student_id} ({name}) → class {class_id}")
        return True

    async def deny_student(self, class_id: str, student_id: str):
        ws = self.pending_connections.get(class_id, {}).pop(student_id, None)
        if ws:
            await ws.send_json({"type": "denied"})
            await ws.close()
        evt = self.admission_events.get(class_id, {}).pop(student_id, None)
        if evt:
            evt.set()
        print(f"[DENY] {student_id} from {class_id}")

    def disconnect_student(self, class_id: str, student_id: str):
        if student_id in self.active_connections.get(class_id, {}):
            del self.active_connections[class_id][student_id]
            # Clean up status entirely — teacher will remove the card
            name = self.student_statuses.get(class_id, {}).get(student_id, {}).get("name", "Student")
            if student_id in self.student_statuses.get(class_id, {}):
                del self.student_statuses[class_id][student_id]
            asyncio.create_task(self.broadcast_to_teachers(class_id, {
                "type": "student_removed",
                "student_id": student_id,
                "name": name
            }))
            leave = {"type": "student_left", "student_id": student_id}
            for sid, sw in self.active_connections.get(class_id, {}).items():
                asyncio.create_task(sw.send_json(leave))
            print(f"[LEAVE] {student_id} ({name}) from {class_id}")
        elif student_id in self.pending_connections.get(class_id, {}):
            del self.pending_connections[class_id][student_id]

    # ── Teacher lifecycle ─────────────────────────────────────────────────
    async def connect_teacher(self, ws: WebSocket, class_id: str):
        await ws.accept()
        self.teacher_connections.setdefault(class_id, []).append(ws)
        print(f"[TEACHER] connected to {class_id}")
        # Ensure class exists in DB
        db = self._db()
        try:
            if not db.query(ClassSession).filter_by(id=class_id).first():
                db.add(ClassSession(id=class_id)); db.commit()
        except Exception as e:
            print(f"[DB] teacher connect: {e}")
        finally:
            db.close()
        # Send full current state
        pending_data = {sid: {"name": self.pending_names.get(class_id, {}).get(sid, "Waiting...")}
                        for sid in self.pending_connections.get(class_id, {})}
        await ws.send_json({
            "type": "full_state",
            "data": self.student_statuses.get(class_id, {}),
            "pending": pending_data
        })

    def disconnect_teacher(self, ws: WebSocket, class_id: str):
        lst = self.teacher_connections.get(class_id, [])
        if ws in lst:
            lst.remove(ws)
        print(f"[TEACHER] disconnected from {class_id}")

    # ── Status ──────────────────────────────────────────────────────────
    async def update_student_status(self, class_id: str, student_id: str, data: Dict):
        statuses = self.student_statuses.setdefault(class_id, {})
        statuses.setdefault(student_id, {})

        # Preserve name if a better one comes in
        incoming_name = (data.get("name") or "").strip()
        if incoming_name:
            statuses[student_id]["name"] = incoming_name

        for k, v in data.items():
            if k != "name":
                statuses[student_id][k] = v

        # Log notable events
        alert_statuses = {"Drowsy", "Distracted", "No Face", "Yawn"}
        if data.get("status") in alert_statuses:
            db = self._db()
            try:
                db_id = statuses[student_id].get("db_id")
                if db_id:
                    db.add(AttentionLog(
                        student_db_id=db_id,
                        status=data.get("status"),
                        detail=data.get("detail", ""),
                        attention_score=0.0
                    ))
                    db.commit()
            except Exception as e:
                print(f"[DB] log error: {e}")
            finally:
                db.close()

        await self.broadcast_to_teachers(class_id, {
            "type": "student_update",
            "student_id": student_id,
            "data": statuses[student_id]
        })

    async def broadcast_summary(self, class_id, student_id, summary_data):
        await self.broadcast_to_teachers(class_id, {
            "type": "summary_update",
            "student_id": student_id,
            "data": summary_data
        })

    # ── WebRTC Signaling ────────────────────────────────────────────────
    async def handle_signal(self, class_id: str, sender_id: str, target_id: str,
                            signal_data: dict, sender_type: str):
        payload = {"type": "signal", "sender_id": sender_id, "data": signal_data}
        if sender_type == "student":
            if target_id:
                ws = self.active_connections.get(class_id, {}).get(target_id)
                if ws:
                    await ws.send_json(payload)
            else:
                await self.broadcast_to_teachers(class_id, payload)
        elif sender_type == "teacher":
            ws = self.active_connections.get(class_id, {}).get(target_id)
            if ws:
                await ws.send_json(payload)

    async def broadcast_to_teachers(self, class_id: str, message: dict):
        for ws in list(self.teacher_connections.get(class_id, [])):
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[BROADCAST] error: {e}")

    async def broadcast_to_students(self, class_id: str, message: dict):
        for sid, ws in list(self.active_connections.get(class_id, {}).items()):
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[BROADCAST-S] error: {e}")

    async def send_chat_to_teachers(self, class_id: str, student_id: str, name: str, text: str):
        await self.broadcast_to_teachers(class_id, {
            "type": "chat_message",
            "sender": "student",
            "student_id": student_id,
            "name": name,
            "text": text
        })

    async def send_chat_to_students(self, class_id: str, text: str):
        await self.broadcast_to_students(class_id, {
            "type": "chat_message",
            "sender": "teacher",
            "name": "Teacher",
            "text": text
        })

    def get_participant_count(self, class_id: str) -> int:
        return len(self.active_connections.get(class_id, {}))

    async def broadcast_participant_count(self, class_id: str):
        count = self.get_participant_count(class_id)
        # Gather names of all active students
        participants = []
        for sid in self.active_connections.get(class_id, {}):
            name = self.student_statuses.get(class_id, {}).get(sid, {}).get("name", "Student")
            participants.append({"id": sid, "name": name})
        
        msg = {
            "type": "participant_count", 
            "count": count,
            "participants": participants
        }
        await self.broadcast_to_teachers(class_id, msg)
        await self.broadcast_to_students(class_id, msg)
