"""Application-assigned, JavaScript-safe Snowflake IDs.

The 53 bits are: 40 timestamp milliseconds since 2024-01-01 UTC,
10 worker bits and 3 per-millisecond sequence bits.  Workers sharing a
database must have distinct SIMCARE_WORKER_ID values (0..1023).
"""

import os
import threading
import time

EPOCH_MS = 1704067200000
MAX_WORKER = 1023
MAX_SEQUENCE = 7
MAX_ID = (1 << 53) - 1

_lock = threading.Lock()
_last_ms = -1
_sequence = 0


def _worker_id():
    configured = os.getenv("SIMCARE_WORKER_ID")
    worker = int(configured) if configured is not None else os.getpid() % 1024
    if not 0 <= worker <= MAX_WORKER:
        raise ValueError("SIMCARE_WORKER_ID must be between 0 and 1023")
    return worker


def next_id():
    """Return a positive 53-bit integer without requesting a database ID."""
    global _last_ms, _sequence
    with _lock:
        now = int(time.time_ns() // 1_000_000) - EPOCH_MS
        if now < 0 or now >= (1 << 40):
            raise RuntimeError("Snowflake timestamp is outside the supported range")
        if now < _last_ms:
            now = _last_ms
        if now == _last_ms:
            _sequence += 1
            while _sequence > MAX_SEQUENCE:
                time.sleep(0.0001)
                now = int(time.time_ns() // 1_000_000) - EPOCH_MS
                if now > _last_ms:
                    _sequence = 0
        else:
            _sequence = 0
        _last_ms = now
        return (now << 13) | (_worker_id() << 3) | _sequence
