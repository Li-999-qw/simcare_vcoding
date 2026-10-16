from datetime import datetime
from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column
from backend.runtime.ids import next_id

from .db import Base


class TimestampMixin:
    create_time: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    update_time: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, default=next_id, autoincrement=False)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default="student")
    requested_role: Mapped[str] = mapped_column(String(16), default="student")
    profile: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Case(TimestampMixin, Base):
    __tablename__ = "cases"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, default=next_id, autoincrement=False)
    title: Mapped[str] = mapped_column(String(160))
    version: Mapped[str] = mapped_column(String(32), default="v1")
    status: Mapped[str] = mapped_column(String(16), default="draft")
    engine_key: Mapped[str | None] = mapped_column(String(48), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Assignment(TimestampMixin, Base):
    __tablename__ = "assignments"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, default=next_id, autoincrement=False)
    title: Mapped[str] = mapped_column(String(160))
    case_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("cases.id"))
    student_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"))
    teacher_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"))
    case_version: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="active")
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TrainingSession(TimestampMixin, Base):
    __tablename__ = "training_sessions"
    __table_args__ = (UniqueConstraint("assignment_id", "student_id", name="uq_assignment_student"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, default=next_id, autoincrement=False)
    assignment_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("assignments.id"))
    student_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"))
    stage: Mapped[int] = mapped_column(Integer, default=0)
    engine_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AuditEvent(TimestampMixin, Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, default=next_id, autoincrement=False)
    actor_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(80))
    target: Mapped[str] = mapped_column(String(160))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


from backend.runtime.login_sessions import LoginSessionColumns


class UserLoginSession(LoginSessionColumns, TimestampMixin, Base):
    __tablename__ = "user_login_sessions"
