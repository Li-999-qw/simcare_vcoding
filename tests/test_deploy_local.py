"""Run deployment against disposable repositories; never start real services."""
import os
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'Deploy-Local.ps1'


@unittest.skipUnless(os.name == 'nt', 'Windows deployment script')
class DeployLocalTests(unittest.TestCase):
    def run_deploy(self, source, target):
        return subprocess.run([
            'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT),
            '-SourceDir', str(source), '-DeployDir', str(target),
        ], capture_output=True, text=True, errors='replace', timeout=30,
            env={**os.environ, 'RUNNER_TRACKING_ID': 'test-runner-job'})

    def fixture(self, root):
        source, target = root / 'source', root / 'deployed app'
        source.mkdir()
        target.mkdir()
        for command in (['git', 'init', '-q', str(source)],):
            subprocess.run(command, check=True, capture_output=True)
        for name, content in {
            'app.py': 'new code',
            'frontend/病例说明.txt': 'case instructions',
            'application.yml': 'must not replace target credentials',
            'data/server.json': 'must not replace target secret',
            'logs/api.log': 'must not replace target logs',
            'backend/engines/chest/runtime/sessions.json': 'repository session',
            'backend/runtime/.env': 'repository credentials',
            'backend/extensions/.secrets/key.json': 'repository encrypted key',
            'backend/runtime/__pycache__/app.pyc': 'repository bytecode',
            'Restart-Local.cmd': '@echo off\nif not "%~1"=="--non-interactive" exit /b 9\n'
                                 'if defined RUNNER_TRACKING_ID exit /b 10\n'
                                 'echo restarted>restart.marker\nexit /b 0\n',
        }.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')
        for name, content in {
            'application.yml': 'local credentials', 'data/server.json': 'local secret',
            'logs/api.log': 'local logs', 'nginx/nginx.exe': 'provisioned binary',
            '.venv/Scripts/python.exe': 'provisioned Python',
            'backend/engines/chest/runtime/sessions.json': 'local session',
            'backend/runtime/.env': 'local credentials',
            'backend/extensions/.secrets/key.json': 'local encrypted key',
            'operator-note.txt': 'local file',
        }.items():
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')
        subprocess.run(['git', '-C', str(source), 'add', '.'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(source), '-c', 'user.name=Test', '-c',
                        'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
                       check=True, capture_output=True)
        return source, target

    def test_updates_code_preserves_local_state_and_removes_only_managed_deleted_files(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'data') as directory:
            source, target = self.fixture(Path(directory))
            result = self.run_deploy(source, target)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((target / 'app.py').read_text(), 'new code')
            self.assertEqual((target / 'frontend/病例说明.txt').read_text(), 'case instructions')
            for name, expected in {
                'application.yml': 'local credentials', 'data/server.json': 'local secret',
                'logs/api.log': 'local logs', 'backend/runtime/.env': 'local credentials',
                'backend/engines/chest/runtime/sessions.json': 'local session',
                'backend/extensions/.secrets/key.json': 'local encrypted key',
            }.items():
                self.assertEqual((target / name).read_text(), expected)
            self.assertTrue((target / 'restart.marker').is_file())
            self.assertFalse((target / 'backend/runtime/__pycache__/app.pyc').exists())
            subprocess.run(['git', '-C', str(source), 'rm', 'app.py', 'frontend/病例说明.txt'],
                           check=True, capture_output=True)
            result = self.run_deploy(source, target)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse((target / 'app.py').exists())
            self.assertFalse((target / 'frontend/病例说明.txt').exists())
            self.assertEqual((target / 'operator-note.txt').read_text(), 'local file')

    def test_rejects_overlapping_source_and_deploy_directories(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'data') as directory:
            source, _ = self.fixture(Path(directory))
            result = self.run_deploy(source, source)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((source / 'app.py').exists())

    def test_restart_failure_fails_deployment_and_does_not_mark_success(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'data') as directory:
            source, target = self.fixture(Path(directory))
            (source / 'Restart-Local.cmd').write_text('@echo off\nexit /b 7\n')
            result = self.run_deploy(source, target)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((target / 'data/deployment.json').exists())

    def test_actual_cmd_wrapper_is_unattended_and_propagates_failure(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'data') as directory:
            root = Path(directory)
            shutil.copyfile(ROOT / 'Restart-Local.cmd', root / 'Restart-Local.cmd')
            (root / 'Restart-Local.ps1').write_text(
                'param([switch]$NoBrowser)\nif (-not $NoBrowser) { exit 8 }\nexit 7\n')
            result = subprocess.run(['cmd.exe', '/d', '/c', str(root / 'Restart-Local.cmd'),
                                     '--non-interactive'], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 7, result.stdout + result.stderr)

    def test_invalid_stale_manifest_cannot_delete_files_outside_installation(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'data') as directory:
            root = Path(directory)
            source, target = self.fixture(root)
            outside = root / 'outside.txt'
            outside.write_text('keep me')
            (target / 'data/deployment-manifest.json').write_text(json.dumps({
                'version': 1, 'files': ['../outside.txt'],
            }))
            result = self.run_deploy(source, target)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(outside.read_text(), 'keep me')
            self.assertFalse((target / 'app.py').exists())
