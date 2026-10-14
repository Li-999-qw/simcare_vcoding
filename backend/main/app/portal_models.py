from datetime import datetime
from sqlalchemy import BigInteger, DateTime, Integer, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column
from backend.runtime.ids import next_id
from .db import Base

class TimestampMixin:
    create_time: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    update_time: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class PortalDocument(TimestampMixin, Base):
    __tablename__ = 'portal_documents'
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, default=next_id, autoincrement=False)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    data: Mapped[dict] = mapped_column(JSON, default=dict)

class PortalAttempt(TimestampMixin, Base):
    __tablename__ = 'portal_attempts'
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(next_id()))
    user_id: Mapped[int] = mapped_column(BigInteger, index=True)
    task_key: Mapped[str] = mapped_column(String(100))
    case_id: Mapped[int] = mapped_column(Integer)
    engine_id: Mapped[str] = mapped_column(String(128))
    state: Mapped[dict] = mapped_column(JSON, default=dict)

class KnowledgeItem(TimestampMixin, Base):
    __tablename__ = 'knowledge_items'
    id: Mapped[str] = mapped_column(String(100), primary_key=True, default=lambda: str(next_id()))
    item_key: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(BigInteger, index=True)
    attempt_id: Mapped[str] = mapped_column(String(64))
    content: Mapped[dict] = mapped_column(JSON, default=dict)
