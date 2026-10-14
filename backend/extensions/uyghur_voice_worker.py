"""Local WAV recognition; recordings are kept in memory only."""
import io, json, sys, wave
from pathlib import Path
ROOT=Path(__file__).resolve().parent

import numpy as np

def main():
    language=sys.argv[1]
    data=sys.stdin.buffer.read(4_000_001)
    with wave.open(io.BytesIO(data),'rb') as wav:
        assert wav.getnchannels()==1 and wav.getsampwidth()==2 and wav.getframerate()==16000
        samples=np.frombuffer(wav.readframes(wav.getnframes()),dtype='<i2').astype(np.float32)/32768
    if len(samples)<1600 or float(np.max(np.abs(samples)))<0.0002:
        text=''
    elif language=='ug':
        import onnxruntime as ort
        model=ROOT/'voice_models/uyghur'
        opts=ort.SessionOptions();opts.intra_op_num_threads=4;opts.inter_op_num_threads=1
        session=ort.InferenceSession(str(model/'model_q4.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
        samples=(samples-samples.mean())/np.sqrt(samples.var()+1e-7)
        feeds={'input_values':samples[None,:]}
        if any(i.name=='attention_mask' for i in session.get_inputs()):feeds['attention_mask']=np.ones((1,len(samples)),dtype=np.int64)
        ids=np.argmax(session.run(None,feeds)[0],axis=-1)[0]
        vocab={v:k for k,v in json.loads((model/'vocab.json').read_text(encoding='utf-8')).items()}
        blank=json.loads((model/'config.json').read_text())['pad_token_id']
        chars=[];previous=None
        for token in ids:
            if token!=previous and token!=blank:
                char=vocab.get(int(token),'')
                if not char.startswith('['):chars.append(char)
            previous=token
        text=' '.join(''.join(chars).replace('|',' ').split())
    else:
        base=ROOT.parent
        sys.path.insert(0,str(base/'voice-runtime'))
        import sherpa_onnx
        model=base/'voice-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
        recognizer=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(model/'model.int8.onnx'),tokens=str(model/'tokens.txt'),num_threads=4,use_itn=True,language=language,provider='cpu')
        stream=recognizer.create_stream();stream.accept_waveform(16000,samples);recognizer.decode_stream(stream)
        text=stream.result.text.strip()
    sys.stdout.buffer.write(json.dumps({'text':text},ensure_ascii=False).encode('utf-8'))

if __name__=='__main__':main()
