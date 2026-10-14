"""Server-only credential storage, encrypted with the Windows account's DPAPI."""
import base64
import ctypes
import json
import os
from ctypes import wintypes
from pathlib import Path

PATH = Path(__file__).resolve().parent / '.secrets' / 'openai.json'

class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]

def crypt(value, decrypt=False):
    if os.name != 'nt':
        raise RuntimeError('当前密钥存储需要 Windows DPAPI。')
    buf = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    lib = ctypes.WinDLL('crypt32', use_last_error=True)
    fn = lib.CryptUnprotectData if decrypt else lib.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise RuntimeError('无法读取或保存密钥，请确认服务使用原 Windows 账号运行。')
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        free = ctypes.WinDLL('kernel32').LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(target.data)

def load():
    # None means no GUI override; empty string explicitly disables env credentials.
    from backend.runtime.settings_store import read_setting
    stored = read_setting('credential_openai', PATH, None)
    if stored is None: return None
    value = stored.get('protected')
    return crypt(base64.b64decode(value), True).decode('utf-8') if value else ''

def save(key):
    from backend.runtime.settings_store import save_setting
    encoded = base64.b64encode(crypt(key.encode('utf-8'))).decode('ascii') if key else None
    save_setting('credential_openai', {'protected': encoded})
