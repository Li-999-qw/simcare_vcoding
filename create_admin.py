import getpass,sys
from pathlib import Path
import server
from app.db import SessionLocal
from app.models import User
from app.security import hash_password
with SessionLocal() as db:
 if db.query(User).filter_by(role='admin',status='active').first():
  print('An active administrator already exists. No changes made.');sys.exit(0)
 name=input('Administrator username: ').strip()
 if not name or len(name)>64:raise SystemExit('Invalid username')
 password=getpass.getpass('Administrator password (at least 12 characters): ')
 if len(password)<12 or password!=getpass.getpass('Confirm password: '):raise SystemExit('Password too short or confirmation does not match')
 db.add(User(username=name,display_name='Administrator',password_hash=hash_password(password),role='admin',requested_role='admin',status='active'));db.commit()
 print('Administrator created. No default password is included in this distribution.')
