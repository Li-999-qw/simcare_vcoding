"""Shared, database-backed single-login policy for every API entry point."""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import BigInteger, DateTime, ForeignKey, String, delete, select
from sqlalchemy.orm import Mapped, mapped_column

from backend.runtime.ids import next_id

GUARD_PATH = Path(__file__).resolve().parents[2] / 'frontend/session-guard.js'


def install_session_errors(app):
    """Navigation requests return to login; API requests retain their 401 code."""
    from fastapi.exception_handlers import http_exception_handler
    from starlette.responses import RedirectResponse

    @app.exception_handler(HTTPException)
    async def session_error(request, exc):
        detail = exc.detail
        if (exc.status_code == 401 and isinstance(detail, dict)
                and detail.get('code') in ('SESSION_REPLACED', 'SESSION_EXPIRED')
                and request.method == 'GET'
                and 'text/html' in request.headers.get('accept', '')):
            english = request.url.path.startswith('/en/')
            reason = 'replaced' if detail['code'] == 'SESSION_REPLACED' else 'expired'
            return RedirectResponse(('/en' if english else '') + '/portal.html?session=' + reason,
                                    status_code=303, headers={'Cache-Control': 'no-store'})
        response = await http_exception_handler(request, exc)
        if exc.status_code == 401:
            response.headers['Cache-Control'] = 'no-store'
        return response


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class LoginSessionColumns:
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, default=next_id, autoincrement=False)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey('users.id'), unique=True, nullable=False)
    session_token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    login_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


def digest(sid):
    return hashlib.sha256(sid.encode('utf-8')).hexdigest()


def denied(code='SESSION_EXPIRED'):
    message = '账号已在其他设备登录，请重新登录' if code == 'SESSION_REPLACED' else '登录已失效，请重新登录'
    return HTTPException(401, detail={'code': code, 'message': message})


def start(db, user, User, LoginSession, issue_token, hours):
    # Lock the existing user row, including the first login with no session row.
    # Locking reads see the latest committed row under MySQL REPEATABLE READ.
    locked = db.scalar(select(User).where(User.id == user.id).with_for_update()
                       .execution_options(populate_existing=True))
    if not locked or locked.status != 'active':
        raise denied()
    row = db.scalar(select(LoginSession).where(LoginSession.user_id == user.id)
                    .with_for_update().execution_options(populate_existing=True))
    now, sid = utcnow(), secrets.token_urlsafe(32)
    if row is None:
        row = LoginSession(user_id=user.id)
        db.add(row)
    row.session_token_hash = digest(sid)
    row.login_time = now
    row.expires_at = now + timedelta(hours=hours)
    token = issue_token(user.id, locked.role, sid=sid)
    db.commit()
    return token


def validate(db, token, User, LoginSession, read_token):
    try:
        claims = read_token(token)
        uid, sid = int(claims['sub']), claims['sid']
        if not isinstance(sid, str) or not sid:
            raise ValueError('missing session')
    except (ValueError, KeyError, TypeError, AttributeError):
        raise denied()
    user = db.get(User, uid)
    if not user or user.status != 'active':
        raise denied()
    row = db.scalar(select(LoginSession).where(LoginSession.user_id == uid))
    if row is None or row.expires_at <= utcnow():
        raise denied()
    if not hmac.compare_digest(row.session_token_hash, digest(sid)):
        raise denied('SESSION_REPLACED')
    return user


def end(db, token, LoginSession, read_token):
    try:
        claims = read_token(token)
        uid, fingerprint = int(claims['sub']), digest(claims['sid'])
    except (ValueError, KeyError, TypeError, AttributeError):
        return
    # An old browser cannot revoke a newer login, even during concurrent logout.
    db.execute(delete(LoginSession).where(LoginSession.user_id == uid,
                                         LoginSession.session_token_hash == fingerprint))
    db.commit()
