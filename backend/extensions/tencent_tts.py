"""Tencent Cloud streaming TTS for authenticated training replies."""

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode, quote

SECRET = Path(__file__).resolve().parent / '.secrets' / 'tencent-tts.json'
HOST = 'tts.cloud.tencent.com'
PATH = '/stream_wsv2'
SAMPLE_RATE = 24000
VOICES = {
    'chest': {'patient': 603006, 'senior': 501000},   # 58-year-old man; clear mentor voice
    'lumbar': {'patient': 602004, 'senior': 501000},  # 46-year-old man; clear mentor voice
    'ascites': {'patient': 603003, 'senior': 501000}, # 56-year-old man; clear mentor voice
    'uyghur': {'patient': None, 'senior': 501000},    # Tencent voices do not support Uyghur
}


def voice_for_case(case_id: int, source_case_id: str, role: str) -> int | None:
    if role not in ('patient', 'senior'):
        return None
    if source_case_id.endswith('-UG'):
        kind = 'uyghur'
    elif 'ASC' in source_case_id:
        kind = 'ascites'
    elif case_id == 2:
        kind = 'lumbar'
    else:
        kind = 'chest'
    return VOICES[kind][role]


def authorized_text(state: dict, role: str, text: str) -> bool:
    if role not in ('patient', 'senior') or not isinstance(text, str):
        return False
    text = text.strip()
    if not text or len(text) > 240 or any(ord(c) < 32 and c not in '\n\t' for c in text):
        return False
    streaming = state.get('streaming') or {}
    if streaming.get('role') == role and text in streaming.get('text', ''):
        return True
    for message in reversed(state.get('messages', [])[-3:]):
        if message.get('speaker') == 'assistant' and message.get('role') == role:
            return text in message.get('text', '')
    return False


def credentials() -> dict | None:
    from backend.runtime.settings_store import read_setting
    stored = read_setting('credential_tencent_tts', SECRET, None)
    if stored and stored.get('protected'):
        from credential_store import crypt
        protected = stored['protected']
        return json.loads(crypt(base64.b64decode(protected), True))
    app_id = os.getenv('TENCENT_TTS_APP_ID')
    secret_id = os.getenv('TENCENT_TTS_SECRET_ID')
    secret_key = os.getenv('TENCENT_TTS_SECRET_KEY')
    if all((app_id, secret_id, secret_key)):
        return {'app_id': int(app_id), 'secret_id': secret_id, 'secret_key': secret_key}
    return None


def save_credentials(app_id: int, secret_id: str, secret_key: str) -> None:
    if int(app_id) <= 0 or not secret_id or not secret_key:
        raise ValueError('AppId、SecretId 和 SecretKey 都必须填写。')
    from credential_store import crypt
    from backend.runtime.settings_store import save_setting
    raw = json.dumps({'app_id': int(app_id), 'secret_id': secret_id,
                      'secret_key': secret_key}).encode('utf-8')
    save_setting('credential_tencent_tts',
                 {'protected': base64.b64encode(crypt(raw)).decode('ascii')})


def signed_url(app_id: int, secret_id: str, secret_key: str, voice_type: int,
               *, now: int | None = None, session_id: str | None = None) -> str:
    now = int(time.time() if now is None else now)
    params = {
        'Action': 'TextToStreamAudioWSv2', 'AppId': int(app_id), 'SecretId': secret_id,
        'Timestamp': now, 'Expired': now + 3600, 'SessionId': session_id or str(uuid.uuid4()),
        'VoiceType': int(voice_type), 'Volume': 0, 'Speed': 0,
        'SampleRate': SAMPLE_RATE, 'Codec': 'pcm',
    }
    query = urlencode(sorted(params.items()), quote_via=quote)
    payload = 'GET' + HOST + PATH + '?' + query
    signature = base64.b64encode(hmac.new(secret_key.encode('utf-8'), payload.encode('utf-8'),
                                          hashlib.sha1).digest()).decode('ascii')
    return f'wss://{HOST}{PATH}?{query}&Signature={quote(signature, safe="")}'


async def pcm_stream(text: str, voice_type: int, configured: dict):
    """Yield signed Tencent PCM frames as they arrive; never persist the audio."""
    import asyncio
    from websockets.asyncio.client import connect

    session_id = str(uuid.uuid4())
    url = signed_url(configured['app_id'], configured['secret_id'],
                     configured['secret_key'], voice_type, session_id=session_id)
    text = text.strip()
    if text[-1] not in '。；？！;?!\n':
        text += '。'
    try:
        async with connect(url, proxy=None, open_timeout=10, close_timeout=3,
                           max_size=2 * 1024 * 1024) as remote:
            ready = False
            async with asyncio.timeout(12):
                while not ready:
                    event = json.loads(await remote.recv())
                    if event.get('code') != 0:
                        raise RuntimeError(f"腾讯云语音鉴权或初始化失败（{event.get('code')}）。")
                    ready = event.get('ready') == 1
            if not ready:
                raise RuntimeError('腾讯云语音初始化超时。')
            await remote.send(json.dumps({'session_id': session_id, 'message_id': str(uuid.uuid4()),
                                          'action': 'ACTION_SYNTHESIS', 'data': text}, ensure_ascii=False))
            await remote.send(json.dumps({'session_id': session_id, 'message_id': str(uuid.uuid4()),
                                          'action': 'ACTION_COMPLETE', 'data': ''}))
            async with asyncio.timeout(60):
                async for message in remote:
                    if isinstance(message, bytes):
                        yield message
                    else:
                        event = json.loads(message)
                        if event.get('code') != 0:
                            raise RuntimeError(f"腾讯云语音合成失败（{event.get('code')}）。")
                        if event.get('final') == 1:
                            return
    except RuntimeError:
        raise
    except Exception:
        # Keep signed URLs and credential identifiers out of application logs.
        raise RuntimeError('腾讯云语音连接中断，请检查网络和服务状态。') from None
