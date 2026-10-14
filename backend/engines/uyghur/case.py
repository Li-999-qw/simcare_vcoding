import runpy
from pathlib import Path
globals().update({k:v for k,v in runpy.run_path(str(Path(__file__).resolve().parents[1] / 'chest' / 'case.py')).items() if not k.startswith("__")})

CASE_ID='SIM-AMI-20260901-UG'
REGISTRATION.update(name='阿不都热依木·艾合买提',ethnicity='维吾尔族',birthplace='新疆维吾尔自治区喀什市',address='新疆维吾尔自治区乌鲁木齐市天山区安康小区6栋201室（教学虚构地址）')
FACTS['identity']='阿不都热依木·艾合买提（ئابدۇراھىم ئەخمەت），男，58岁，维吾尔族，已婚，企业行政人员。籍贯新疆喀什，现居新疆乌鲁木齐市天山区安康小区6栋201室（教学虚构地址）。只懂维吾尔语，不懂汉语、英语或其他语言。'
