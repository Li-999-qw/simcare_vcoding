import base64
import hashlib
import hmac
import json
import secrets
import time

from .config import settings


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    salt_hex, digest_hex = encoded.split("$", 1)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 310_000)
    return hmac.compare_digest(digest.hex(), digest_hex)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def issue_token(user_id: int, role: str, sid: str | None = None) -> str:
    body = {"sub": user_id, "role": role, "exp": int(time.time()) + settings.access_token_hours * 3600}
    if sid is not None:
        body["sid"] = sid
    payload = _b64(json.dumps(body, separators=(",", ":")).encode())
    signature = _b64(hmac.new(settings.app_secret.encode(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"


def read_token(token: str) -> dict:
    try:
        payload, signature = token.split(".", 1)
        expected = _b64(hmac.new(settings.app_secret.encode(), payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid signature")
        body = json.loads(_unb64(payload))
        if int(body["exp"]) < time.time():
            raise ValueError("expired")
        return body
    except (ValueError, KeyError, TypeError, AttributeError, json.JSONDecodeError) as error:
        raise ValueError("invalid token") from error


def start_login_session(db, user):
    from .models import User, UserLoginSession
    from backend.runtime.login_sessions import start
    return start(db, user, User, UserLoginSession, issue_token, settings.access_token_hours)


def session_user(db, token):
    from .models import User, UserLoginSession
    from backend.runtime.login_sessions import validate
    return validate(db, token, User, UserLoginSession, read_token)


def end_login_session(db, token):
    from .models import UserLoginSession
    from backend.runtime.login_sessions import end
    end(db, token, UserLoginSession, read_token)
