"""Serve the existing Chinese deployment plus the English /en edition."""
import runpy,sys
from pathlib import Path
DEPLOYED=Path(__file__).resolve().parents[1] / 'main'
sys.path.insert(0,str(DEPLOYED))
from app.main import app
from uyghur_variant import install as install_uyghur
install_uyghur()
from uyghur_voice import install as install_uyghur_voice
install_uyghur_voice()
from bilingual import install
from bailian_admin import router as bailian_router
app.include_router(bailian_router)
# FastAPI may represent included routers as a single lazy route.
app.router.routes.insert(0,app.router.routes.pop())
install(app)
if __name__=='__main__':runpy.run_path(str(DEPLOYED/'serve_https.py'),run_name='__main__')
