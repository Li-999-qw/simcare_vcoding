"""Decode a bounded WAV from stdin locally; audio is never written to disk."""
import io,json,sys,wave
from pathlib import Path
BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE/'voice-runtime'))
import numpy as np
import sherpa_onnx

def main():
    data=sys.stdin.buffer.read(4_000_001)
    if len(data)>4_000_000:raise ValueError('audio too large')
    with wave.open(io.BytesIO(data),'rb') as wav:
        if wav.getnchannels()!=1 or wav.getsampwidth()!=2 or wav.getframerate()!=16000 or not 1600<=wav.getnframes()<=16000*120:
            raise ValueError('invalid audio')
        samples=np.frombuffer(wav.readframes(wav.getnframes()),dtype='<i2').astype(np.float32)/32768
    if float(np.max(np.abs(samples)))<0.0002:
        sys.stdout.buffer.write(b'{"text":""}')
        return
    model=BASE/'voice-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
    recognizer=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(model/'model.int8.onnx'),tokens=str(model/'tokens.txt'),num_threads=4,use_itn=True,language='zh',provider='cpu')
    stream=recognizer.create_stream();stream.accept_waveform(16000,samples);recognizer.decode_stream(stream)
    sys.stdout.buffer.write(json.dumps({'text':stream.result.text.strip()},ensure_ascii=False).encode('utf-8'))

if __name__=='__main__':main()
