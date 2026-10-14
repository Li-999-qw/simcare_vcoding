"""Interactive server-local Tencent TTS credential setup; input is not echoed."""

import getpass
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'backend' / 'runtime'))
sys.path.insert(0, str(ROOT / 'backend' / 'extensions'))

from tencent_tts import save_credentials, credentials


def main():
    app_id = int(input('Tencent Cloud AppId: ').strip())
    secret_id = getpass.getpass('SecretId: ').strip()
    secret_key = getpass.getpass('SecretKey: ').strip()
    save_credentials(app_id, secret_id, secret_key)
    assert credentials() is not None
    print('Tencent TTS credentials encrypted for this Windows account.')


if __name__ == '__main__':
    main()
