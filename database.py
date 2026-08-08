from sqlalchemy import create_engine, Column, String, Integer, Float, DateTime, ForeignKey, Text
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime

DATABASE_URL = "sqlite:///./classroom.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class ClassSession(Base):
    __tablename__ = "class_sessions"
    id = Column(String, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class StudentSession(Base):
    __tablename__ = "student_sessions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("class_sessions.id"))
    student_id = Column(String, index=True)
    name = Column(String, default="Student")
    joined_at = Column(DateTime, default=datetime.utcnow)


class AttentionLog(Base):
    __tablename__ = "attention_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    student_db_id = Column(Integer, ForeignKey("student_sessions.id"))
    status = Column(String)          # Drowsy | Distracted | No Face | Focused
    detail = Column(Text, default="")
    attention_score = Column(Float, default=1.0)
    timestamp = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)
