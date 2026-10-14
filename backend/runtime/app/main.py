from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from .config import settings
from .models import Assignment, AuditEvent, Case, TrainingSession, User
from .migrations import upgrade_schema
from .security import hash_password, issue_token, read_token, verify_password


@asynccontextmanager
async def lifespan(_: FastAPI):
    upgrade_schema()
    yield


app = FastAPI(title="临床思维训练系统正式版 API", version="0.1.0", lifespan=lifespan)
bearer = HTTPBearer(auto_error=False)
Db = Annotated[Session, Depends(get_db)]


class RegisterIn(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_-]{3,64}$")
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=128)
    requested_role: Literal["student", "teacher"] = "student"
    major: str = Field(default="",max_length=80)
    phone: str = Field(default="",max_length=30)


class LoginIn(BaseModel):
    username: str
    password: str


class CaseIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    version: str = Field(default="v1", max_length=32)
    payload: dict = Field(default_factory=dict)
    engine_key: Literal["chest_pain"] | None = None


class AssignmentIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    case_id: int
    student_id: int
    due_at: datetime | None = None


class ProgressIn(BaseModel):
    stage: int = Field(ge=0, le=4)
    state: dict = Field(default_factory=dict)


def public_user(user: User) -> dict:
    return {"id": user.id, "username": user.username, "display_name": user.display_name, "role": user.role, "requested_role": user.requested_role, "status": user.status}


def audit(db: Session, actor_id: int | None, action: str, target: str, detail: dict | None = None):
    db.add(AuditEvent(actor_id=actor_id, action=action, target=target, detail=detail or {}))


def current_user(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)], db: Db) -> User:
    if not credentials:
        raise HTTPException(status_code=401, detail="请先登录")
    try:
        claims = read_token(credentials.credentials)
    except ValueError:
        raise HTTPException(status_code=401, detail="登录已失效")
    user = db.get(User, int(claims["sub"]))
    if not user or user.status != "active":
        raise HTTPException(status_code=401, detail="账号不可用")
    return user


def require_role(*roles: str):
    def dependency(user: Annotated[User, Depends(current_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="无权执行此操作")
        return user
    return dependency


@app.get("/health")
def health():
    return {"ok": True, "service": "clinical-thinking-formal-api"}


@app.post("/auth/register", status_code=status.HTTP_201_CREATED)
def register(data: RegisterIn, db: Db):
    if db.scalar(select(User).where(User.username == data.username)):
        raise HTTPException(status_code=409, detail="用户名已被使用")
    user = User(username=data.username, display_name=data.display_name, password_hash=hash_password(data.password), requested_role=data.requested_role,profile={"major":data.major,"phone":data.phone})
    db.add(user)
    audit(db, None, "register", f"user:{data.username}")
    db.commit()
    return {"message": "注册申请已提交，等待管理员审核", "user": public_user(user)}


@app.post("/auth/login")
def login(data: LoginIn, db: Db):
    user = db.scalar(select(User).where(User.username == data.username))
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if user.status != "active":
        raise HTTPException(status_code=403, detail="账号尚未审核通过")
    return {"access_token": issue_token(user.id, user.role), "token_type": "bearer", "user": public_user(user)}


@app.get("/me")
def me(user: Annotated[User, Depends(current_user)]):
    return public_user(user)


@app.get("/admin/users/pending")
def pending_users(db: Db, admin: Annotated[User, Depends(require_role("admin"))]):
    users = db.scalars(select(User).where(User.status == "pending").order_by(User.created_at)).all()
    return [public_user(user) for user in users]


@app.post("/admin/users/{user_id}/approve")
def approve_user(user_id: int, db: Db, admin: Annotated[User, Depends(require_role("admin"))]):
    user = db.get(User, user_id)
    if not user or user.status != "pending":
        raise HTTPException(status_code=404, detail="未找到待审核用户")
    user.status, user.role = "active", user.requested_role
    audit(db, admin.id, "approve_user", f"user:{user.id}")
    db.commit()
    return public_user(user)


@app.get("/users")
def list_users(db: Db, actor: Annotated[User, Depends(require_role("teacher", "admin"))], role: Literal["student", "teacher"] | None = None):
    query = select(User).where(User.status == "active")
    if role:
        query = query.where(User.role == role)
    users = db.scalars(query.order_by(User.display_name)).all()
    return [public_user(user) for user in users]


@app.post("/cases", status_code=201)
def create_case(data: CaseIn, db: Db, teacher: Annotated[User, Depends(require_role("teacher", "admin"))]):
    case = Case(title=data.title, version=data.version, payload=data.payload, engine_key=data.engine_key, created_by=teacher.id)
    db.add(case)
    audit(db, teacher.id, "create_case", "case:new", {"title": case.title, "version": case.version})
    db.commit()
    db.refresh(case)
    return {"id": case.id, "title": case.title, "version": case.version, "engine_key": case.engine_key, "status": case.status}


@app.post("/cases/{case_id}/publish")
def publish_case(case_id: int, db: Db, admin: Annotated[User, Depends(require_role("admin"))]):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="病例不存在")
    case.status = "published"
    audit(db, admin.id, "publish_case", f"case:{case.id}", {"version": case.version})
    db.commit()
    return {"id": case.id, "status": case.status}


@app.get("/cases")
def list_cases(db: Db, user: Annotated[User, Depends(current_user)]):
    query = select(Case)
    if user.role == "student":
        query = query.where(Case.status == "published")
    cases = db.scalars(query.order_by(Case.created_at.desc())).all()
    return [{"id": case.id, "title": case.title, "version": case.version, "engine_key": case.engine_key, "status": case.status} for case in cases]


@app.post("/assignments", status_code=201)
def create_assignment(data: AssignmentIn, db: Db, teacher: Annotated[User, Depends(require_role("teacher", "admin"))]):
    case, student = db.get(Case, data.case_id), db.get(User, data.student_id)
    if not case or case.status != "published":
        raise HTTPException(status_code=400, detail="病例尚未发布")
    if not student or student.role != "student" or student.status != "active":
        raise HTTPException(status_code=400, detail="学生账号不可用")
    assignment = Assignment(title=data.title, case_id=case.id, student_id=student.id, teacher_id=teacher.id, case_version=case.version, due_at=data.due_at)
    db.add(assignment)
    audit(db, teacher.id, "create_assignment", "assignment:new", {"student_id": student.id, "case_id": case.id, "case_version": case.version})
    db.commit()
    db.refresh(assignment)
    return {"id": assignment.id, "title": assignment.title, "student_id": assignment.student_id, "case_version": assignment.case_version}


@app.get("/assignments")
def list_assignments(db: Db, user: Annotated[User, Depends(current_user)]):
    query = select(Assignment)
    if user.role == "student":
        query = query.where(Assignment.student_id == user.id)
    elif user.role == "teacher":
        query = query.where(Assignment.teacher_id == user.id)
    rows = db.scalars(query.order_by(Assignment.created_at.desc())).all()
    return [{"id": row.id, "title": row.title, "case_id": row.case_id, "case_version": row.case_version, "engine_key": (db.get(Case, row.case_id).engine_key if db.get(Case, row.case_id) else None), "student_id": row.student_id, "status": row.status, "due_at": row.due_at} for row in rows]


@app.put("/assignments/{assignment_id}/progress")
def save_progress(assignment_id: int, data: ProgressIn, db: Db, student: Annotated[User, Depends(require_role("student"))]):
    assignment = db.get(Assignment, assignment_id)
    if not assignment or assignment.student_id != student.id or assignment.status != "active":
        raise HTTPException(status_code=404, detail="未找到可进行的任务")
    session = db.scalar(select(TrainingSession).where(TrainingSession.assignment_id == assignment.id, TrainingSession.student_id == student.id))
    if not session:
        session = TrainingSession(assignment_id=assignment.id, student_id=student.id)
        db.add(session)
    session.stage, session.state = data.stage, data.state
    db.commit()
    return {"assignment_id": assignment.id, "stage": session.stage, "updated_at": session.updated_at}


class DialogueMessageIn(BaseModel):
    role: Literal["patient", "senior"]
    text: str = Field(min_length=1, max_length=2000)


def student_assignment(db: Session, assignment_id: int, student: User) -> Assignment:
    assignment = db.get(Assignment, assignment_id)
    if not assignment or assignment.student_id != student.id or assignment.status != "active":
        raise HTTPException(status_code=404, detail="未找到可进行的任务")
    case = db.get(Case, assignment.case_id)
    if not case or case.engine_key != "chest_pain":
        raise HTTPException(status_code=409, detail="该病例尚未接入角色对话引擎")
    return assignment


def get_training_session(db: Session, assignment: Assignment, student: User) -> TrainingSession:
    session = db.scalar(select(TrainingSession).where(TrainingSession.assignment_id == assignment.id, TrainingSession.student_id == student.id))
    if not session:
        session = TrainingSession(assignment_id=assignment.id, student_id=student.id)
        db.add(session)
        db.flush()
    return session


def engine_request(method: str, path: str, **kwargs) -> dict:
    headers = {"Origin": settings.dialogue_engine_origin}
    try:
        response = httpx.request(method, settings.dialogue_engine_url.rstrip("/") + path, headers=headers, timeout=45, **kwargs)
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="病例对话引擎暂不可用") from error
    try:
        payload = response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="病例对话引擎返回无效数据")
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code if response.status_code < 500 else 502, detail=payload.get("error", "病例对话引擎请求失败"))
    return payload


@app.post("/assignments/{assignment_id}/dialogue/start")
def start_dialogue(assignment_id: int, db: Db, student: Annotated[User, Depends(require_role("student"))]):
    assignment = student_assignment(db, assignment_id, student)
    session = get_training_session(db, assignment, student)
    if not session.engine_session_id:
        state = engine_request("POST", "/api/session", json={"mode": "practice"})
        session.engine_session_id, session.stage, session.state = state["id"], state.get("stage", 0), state
        audit(db, student.id, "start_dialogue", f"assignment:{assignment.id}", {"engine": "chest_pain", "engine_session_id": session.engine_session_id})
        db.commit()
    else:
        state = engine_request("GET", "/api/state?id=" + session.engine_session_id)
        session.stage, session.state = state.get("stage", 0), state
        db.commit()
    launch_url = settings.dialogue_public_url.rstrip("/") + "/#session=" + session.engine_session_id
    return {"assignment_id": assignment.id, "case_version": assignment.case_version, "state": session.state, "launch_url": launch_url}


@app.get("/assignments/{assignment_id}/dialogue")
def dialogue_state(assignment_id: int, db: Db, student: Annotated[User, Depends(require_role("student"))]):
    assignment = student_assignment(db, assignment_id, student)
    session = get_training_session(db, assignment, student)
    if not session.engine_session_id:
        raise HTTPException(status_code=409, detail="请先开始训练")
    state = engine_request("GET", "/api/state?id=" + session.engine_session_id)
    session.stage, session.state = state.get("stage", 0), state
    db.commit()
    return {"assignment_id": assignment.id, "state": state}


@app.post("/assignments/{assignment_id}/dialogue/messages")
def dialogue_message(assignment_id: int, data: DialogueMessageIn, db: Db, student: Annotated[User, Depends(require_role("student"))]):
    assignment = student_assignment(db, assignment_id, student)
    session = get_training_session(db, assignment, student)
    if not session.engine_session_id:
        raise HTTPException(status_code=409, detail="请先开始训练")
    state = engine_request("POST", "/api/message", json={"id": session.engine_session_id, "role": data.role, "text": data.text, "request_id": str(uuid4()), "attachments": []})
    session.stage, session.state = state.get("stage", 0), state
    db.commit()
    return {"assignment_id": assignment.id, "state": state}


web_directory = Path(__file__).parent / "static"
from .portal_api import router as portal_router
app.include_router(portal_router)
from .model_admin import router as model_router
app.include_router(model_router)
app.mount("/", StaticFiles(directory=web_directory, html=True), name="web")
