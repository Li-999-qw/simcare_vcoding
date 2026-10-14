from sqlalchemy import Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base

class PortalDocument(Base):
    __tablename__ = 'en_portal_documents'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    data: Mapped[dict] = mapped_column(JSON, default=dict)

class PortalAttempt(Base):
    __tablename__ = 'en_portal_attempts'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    task_key: Mapped[str] = mapped_column(String(100))
    case_id: Mapped[int] = mapped_column(Integer)
    engine_id: Mapped[str] = mapped_column(String(128))
    state: Mapped[dict] = mapped_column(JSON, default=dict)

class KnowledgeItem(Base):
    __tablename__ = 'en_knowledge_items'
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    attempt_id: Mapped[str] = mapped_column(String(64))
    content: Mapped[dict] = mapped_column(JSON, default=dict)
