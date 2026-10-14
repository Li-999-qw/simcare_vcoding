import base64
import asyncio
import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend' / 'extensions'))

from tencent_tts import authorized_text, pcm_stream, signed_url, voice_for_case


class TencentTtsTests(unittest.TestCase):
    def test_case_voice_selection_and_uyghur_limit(self):
        self.assertEqual(voice_for_case(1, 'SIM-AMI-20260901', 'patient'), 603006)
        self.assertEqual(voice_for_case(2, 'SIM-LDH-20260903', 'patient'), 602004)
        self.assertEqual(voice_for_case(3, 'SIM-ASC-20260901', 'patient'), 603003)
        self.assertEqual(voice_for_case(4, 'SIM-AMI-20260901-UG', 'patient'), None)
        self.assertEqual(voice_for_case(4, 'SIM-AMI-20260901-UG', 'senior'), 501000)

    def test_signed_url_uses_tencent_canonical_hmac(self):
        url = signed_url(12345, 'AKIDexample', 'private-key', 603006,
                         now=1700000000, session_id='session-1')
        parsed = urlsplit(url)
        self.assertEqual(parsed.scheme, 'wss')
        self.assertEqual(parsed.path, '/stream_wsv2')
        params = parse_qs(parsed.query)
        signature = params.pop('Signature')[0]
        canonical = '&'.join(f'{name}={params[name][0]}' for name in sorted(params))
        expected = base64.b64encode(hmac.new(
            b'private-key', ('GETtts.cloud.tencent.com/stream_wsv2?' + canonical).encode(),
            hashlib.sha1).digest()).decode()
        self.assertEqual(signature, expected)
        self.assertEqual(params['VoiceType'], ['603006'])
        self.assertEqual(params['Codec'], ['pcm'])

    def test_only_current_assistant_reply_can_be_spoken(self):
        state = {'streaming': {'role': 'patient', 'text': '我胸口疼，已经两个小时了。'},
                 'messages': [{'speaker': 'student', 'role': 'patient', 'text': '哪里疼？'}]}
        self.assertTrue(authorized_text(state, 'patient', '我胸口疼，'))
        self.assertFalse(authorized_text(state, 'senior', '我胸口疼，'))
        self.assertFalse(authorized_text(state, 'patient', '哪里疼？'))
        self.assertFalse(authorized_text(state, 'patient', '无关的任意文本。'))
        state['streaming'] = None
        state['messages'].append({'speaker': 'assistant', 'role': 'patient',
                                  'text': '我胸口疼，已经两个小时了。'})
        self.assertTrue(authorized_text(state, 'patient', '已经两个小时了。'))
        self.assertFalse(authorized_text(state, 'patient', 'x' * 241))

    def test_tencent_audio_frames_stream_before_final_event(self):
        class Remote:
            def __init__(self):
                self.events = iter([
                    json.dumps({'code': 0, 'ready': 0}),
                    json.dumps({'code': 0, 'ready': 1}),
                    b'\x00\x01\x02\x03',
                    json.dumps({'code': 0, 'final': 1}),
                ])
                self.sent = []

            async def __aenter__(self): return self
            async def __aexit__(self, *args): return None
            async def recv(self): return next(self.events)
            async def send(self, message): self.sent.append(json.loads(message))
            def __aiter__(self): return self
            async def __anext__(self):
                try: return next(self.events)
                except StopIteration: raise StopAsyncIteration

        remote = Remote()

        async def collect():
            return [chunk async for chunk in pcm_stream(
                '我胸口疼', 603006,
                {'app_id': 12345, 'secret_id': 'AKIDexample', 'secret_key': 'private-key'})]

        with patch('websockets.asyncio.client.connect', return_value=remote):
            self.assertEqual(asyncio.run(collect()), [b'\x00\x01\x02\x03'])
        self.assertEqual(remote.sent[0]['action'], 'ACTION_SYNTHESIS')
        self.assertEqual(remote.sent[0]['data'], '我胸口疼。')
        self.assertEqual(remote.sent[1]['action'], 'ACTION_COMPLETE')


if __name__ == '__main__':
    unittest.main()
