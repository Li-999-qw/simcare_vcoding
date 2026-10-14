"""Validated local screenshots, scoped to one rehearsal session."""
import base64, binascii, io, secrets
from pathlib import Path
from PIL import Image, UnidentifiedImageError
ROOT=Path(__file__).resolve().parent.parent/'tmp'/'rehearsal-attachments'
MAX_BYTES=4*1024*1024

def save_image(session,data):
    value=data.get('image','')
    if not isinstance(value,str) or not value.startswith(('data:image/png;base64,','data:image/jpeg;base64,','data:image/webp;base64,')):
        raise ValueError('Please select PNG、JPEG Or WebP Image。')
    try:
        raw=base64.b64decode(value.split(',',1)[1],validate=True)
        if not raw or len(raw)>MAX_BYTES:raise ValueError('Each screenshot must not exceed 4MB。')
        with Image.open(io.BytesIO(raw)) as im:
            if im.width*im.height>16000000 or min(im.size)<16:raise ValueError('Image dimensions must be within 16 pixels or more、1600 Within the limit in units of 10,000 pixels。')
            im.load();clean=im.convert('RGB')
            key=secrets.token_hex(16);ROOT.mkdir(parents=True,exist_ok=True)
            clean.save(ROOT/(key+'.png'))
    except (binascii.Error,UnidentifiedImageError,OSError,Image.DecompressionBombError) as e:
        raise ValueError('Unable to read image. Please select the screenshot again.。') from e
    item={'id':key,'name':str(data.get('name','Screenshot'))[:100]}
    session.setdefault('attachments',{})[key]=item
    return item

def path_for(session,key):
    if not isinstance(key,str) or key not in session.get('attachments',{}):raise ValueError('The screenshot does not belong to the current exercise。')
    return ROOT/(key+'.png')
