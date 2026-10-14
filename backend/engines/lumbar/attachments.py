"""Validated local screenshots, scoped to one rehearsal session."""
import base64, binascii, io, secrets
from pathlib import Path
from PIL import Image, UnidentifiedImageError
ROOT=Path(__file__).resolve().parent.parent/'tmp'/'rehearsal-attachments'
MAX_BYTES=4*1024*1024

def save_image(session,data):
    value=data.get('image','')
    if not isinstance(value,str) or not value.startswith(('data:image/png;base64,','data:image/jpeg;base64,','data:image/webp;base64,')):
        raise ValueError('请选择PNG、JPEG或WebP图片。')
    try:
        raw=base64.b64decode(value.split(',',1)[1],validate=True)
        if not raw or len(raw)>MAX_BYTES:raise ValueError('每张截图不得超过4MB。')
        with Image.open(io.BytesIO(raw)) as im:
            if im.width*im.height>16000000 or min(im.size)<16:raise ValueError('图片尺寸应在16像素以上、1600万像素以内。')
            im.load();clean=im.convert('RGB')
            key=secrets.token_hex(16);ROOT.mkdir(parents=True,exist_ok=True)
            clean.save(ROOT/(key+'.png'))
    except (binascii.Error,UnidentifiedImageError,OSError,Image.DecompressionBombError) as e:
        raise ValueError('图片无法读取，请重新选择截图。') from e
    item={'id':key,'name':str(data.get('name','截图'))[:100]}
    session.setdefault('attachments',{})[key]=item
    return item

def path_for(session,key):
    if not isinstance(key,str) or key not in session.get('attachments',{}):raise ValueError('截图不属于当前演练。')
    return ROOT/(key+'.png')
