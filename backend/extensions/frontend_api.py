from fastapi import APIRouter,Depends,HTTPException
from app.portal_api import actor,document
from app.db import get_db
from app.portal_models import PortalAttempt
from attempt_language import lookup
router=APIRouter()
@router.get('/training/{attempt_id}/api/bootstrap')
@router.get('/en/training/{attempt_id}/api/bootstrap')
def bootstrap(attempt_id:str,u=Depends(actor),db=Depends(get_db)):
 a=db.get(PortalAttempt,attempt_id)
 if not a or a.user_id!=u.id:raise HTTPException(404,'训练不存在')
 c=next((c for c in document(db).data['cases'] if c['id']==a.case_id),None)
 if not c:raise HTTPException(404,'病例不存在')
 lang=(lookup(a.id) or {}).get('language','zh')
 source=c.get('sourceCaseId','');kind='uyghur' if source.endswith('-UG') else 'ascites' if 'ASC' in source else 'lumbar' if a.case_id==2 else 'chest'
 base=('/en' if lang=='en' else '')+'/training/'+a.id
 return {'base':base,'variant':lang+'-'+kind,'engine_id':a.engine_id,'username':u.username,'display_name':u.display_name,'task':None if a.task_key.startswith('practice:') else a.task_key,'mode':a.state.get('mode','practice')}
