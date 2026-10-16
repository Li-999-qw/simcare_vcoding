import unittest
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from backend.main.app.db import Base
from backend.main.app.models import User
from backend.main.app import security


class LoginSessionTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(id=100, username='test', display_name='Test',
                         password_hash='unused', role='student', status='active')
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_new_login_replaces_old_and_old_logout_cannot_revoke_new(self):
        old = security.start_login_session(self.db, self.user)
        new = security.start_login_session(self.db, self.user)
        self.assertNotEqual(old, new)
        with self.assertRaises(HTTPException) as error:
            security.session_user(self.db, old)
        self.assertEqual(error.exception.detail['code'], 'SESSION_REPLACED')
        security.end_login_session(self.db, old)
        self.assertEqual(security.session_user(self.db, new).id, self.user.id)
        security.end_login_session(self.db, new)
        with self.assertRaises(HTTPException):
            security.session_user(self.db, new)

    def test_legacy_and_malformed_tokens_are_rejected(self):
        for token in [security.issue_token(100, 'student'), '', 'bad', None]:
            with self.assertRaises(HTTPException) as error:
                security.session_user(self.db, token)
            self.assertEqual(error.exception.status_code, 401)

    def test_only_one_row_and_no_plaintext_session_secret(self):
        from backend.main.app.models import UserLoginSession
        token = security.start_login_session(self.db, self.user)
        token = security.start_login_session(self.db, self.user)
        rows = self.db.scalars(select(UserLoginSession)).all()
        self.assertEqual(len(rows), 1)
        self.assertNotEqual(rows[0].session_token_hash, security.read_token(token)['sid'])
        self.assertIsNotNone(rows[0].id)
        self.assertIsNotNone(rows[0].create_time)
        self.assertIsNotNone(rows[0].update_time)
        rows[0].expires_at = datetime.utcnow() - timedelta(seconds=1)
        self.db.commit()
        with self.assertRaises(HTTPException):
            security.session_user(self.db, token)

    def test_disabled_account_and_other_user_isolation(self):
        other = User(id=101, username='other', display_name='Other',
                     password_hash='unused', role='student', status='active')
        self.db.add(other)
        self.db.commit()
        a = security.start_login_session(self.db, self.user)
        b = security.start_login_session(self.db, other)
        security.start_login_session(self.db, self.user)
        self.assertEqual(security.session_user(self.db, b).id, other.id)
        other.status = 'disabled'
        self.db.commit()
        with self.assertRaises(HTTPException):
            security.session_user(self.db, b)


class LoginEndpointTests(unittest.TestCase):
    def setUp(self):
        from backend.main.app.main import app
        from backend.main.app.db import get_db
        self.app, self.get_db = app, get_db
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        with Session(self.engine) as db:
            db.add(User(id=100, username='tester', display_name='Test',
                        password_hash=security.hash_password('test-password'), status='active', role='student'))
            db.commit()
        def database():
            with Session(self.engine) as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.a, self.b = TestClient(app), TestClient(app)

    def tearDown(self):
        self.a.close()
        self.b.close()
        self.app.dependency_overrides.pop(self.get_db)
        self.engine.dispose()

    def login(self, client, route='/portal/login', password='test-password'):
        return client.post(route, json={'username':'tester', 'password':password})

    def test_two_browsers_and_bearer_share_single_login(self):
        self.assertEqual(self.login(self.a).status_code, 200)
        self.assertEqual(self.a.get('/portal/session').status_code, 200)
        self.assertEqual(self.login(self.b, password='wrong').status_code, 401)
        self.assertEqual(self.a.get('/portal/session').status_code, 200)
        new = self.login(self.b, '/auth/login')
        self.assertEqual(new.status_code, 200)
        token = new.json()['access_token']
        invalid = self.a.get('/portal/session')
        self.assertEqual(invalid.status_code, 401)
        self.assertEqual(invalid.json()['detail']['code'], 'SESSION_REPLACED')
        navigation = self.a.get('/training/unknown/', headers={'Accept':'text/html'}, follow_redirects=False)
        self.assertEqual(navigation.status_code, 303)
        self.assertEqual(navigation.headers['location'], '/portal.html?session=replaced')
        self.a.post('/portal/logout')
        self.assertEqual(self.b.get('/me', headers={'Authorization':'Bearer '+token}).status_code, 200)
        self.login(self.a)
        self.assertEqual(self.b.get('/me', headers={'Authorization':'Bearer '+token}).status_code, 401)
        self.assertEqual(self.a.get('/session-guard.js').status_code, 200)


if __name__ == '__main__':
    unittest.main()
