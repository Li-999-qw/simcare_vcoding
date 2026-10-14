"""通过服务器控制台创建或重置第一个管理员；不对外提供初始化接口。"""
import argparse

from sqlalchemy import select

from .db import Base, SessionLocal, engine
from .models import AuditEvent, User
from .security import hash_password


def main():
    parser = argparse.ArgumentParser(description="初始化临床思维训练系统管理员")
    parser.add_argument("--username", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == args.username))
        if user:
            user.display_name, user.role, user.status = args.name, "admin", "active"
            user.password_hash = hash_password(args.password)
            action = "reset_bootstrap_admin"
        else:
            user = User(username=args.username, display_name=args.name, password_hash=hash_password(args.password), role="admin", status="active")
            db.add(user)
            action = "create_bootstrap_admin"
        db.flush()
        db.add(AuditEvent(actor_id=user.id, action=action, target=f"user:{user.id}"))
        db.commit()
    print(f"管理员 {args.username} 已就绪。")


if __name__ == "__main__":
    main()
