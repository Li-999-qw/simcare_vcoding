from pathlib import Path
import math, json, re
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output'/'pdf'; OUT.mkdir(parents=True,exist_ok=True)
TMP=ROOT/'tmp'/'pdfs'; TMP.mkdir(parents=True,exist_ok=True)
ASSET=TMP/'assets'; ASSET.mkdir(exist_ok=True)
PDF=OUT/'心肌梗死住院病案_模拟复印件_专家审核版.pdf'
pdfmetrics.registerFont(TTFont('Song','C:/Windows/Fonts/simsun.ttc',subfontIndex=0))
pdfmetrics.registerFont(TTFont('Hei','C:/Windows/Fonts/simhei.ttf'))
pdfmetrics.registerFont(TTFont('Arial','C:/Windows/Fonts/arial.ttf'))
pdfmetrics.registerFontFamily('Song',normal='Song',bold='Hei',italic='Song',boldItalic='Hei')
STYLE=ParagraphStyle('body',fontName='Song',fontSize=10.3,leading=17,spaceAfter=6,wordWrap='CJK')
SMALL=ParagraphStyle('small',parent=STYLE,fontSize=8.4,leading=12)
CELL=ParagraphStyle('cell',parent=STYLE,fontSize=9,leading=13)
BLACK=colors.HexColor('#202020')
def glyphs(t):
    t=str(t)
    for ch,num in zip('₀₁₂₃₄₅₆₇₈₉','0123456789'):t=t.replace(ch,'<sub>'+num+'</sub>')
    for ch,num in zip('⁰¹²³⁴⁵⁶⁷⁸⁹','0123456789'):t=t.replace(ch,'<super>'+num+'</super>')
    return t

class NumberCanvas(canvas.Canvas):
    def __init__(self,*a,**kw):
        canvas.Canvas.__init__(self,*a,**kw); self.states=[]
    def showPage(self):
        self.states.append(dict(self.__dict__)); self._startPage()
    def save(self):
        total=len(self.states)
        for state in self.states:
            self.__dict__.update(state)
            w,h=self._pagesize
            self.setStrokeColor(colors.HexColor('#999999')); self.setLineWidth(.4)
            self.line(36,34,w-36,34)
            self.setFillColor(colors.HexColor('#555555')); self.setFont('Song',8)
            self.drawString(36,22,'SIM-AMI-20260901  |  模拟病例 · 专家审核用 · 非真实医疗文书')
            self.drawRightString(w-36,22,f'第 {self._pageNumber} 页 / 共 {total} 页')
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

class Book:
    def __init__(self):
        self.c=NumberCanvas(str(PDF),pagesize=A4,pageCompression=1)
        self.c.setTitle('心肌梗死住院病案 - 模拟复印件 - 专家审核版')
        self.c.setAuthor('临床思维训练系统 | 合成病例')
        self.pages=[]; self.active=False
    def page(self,title,section='病历文书',wide=False,meta=True):
        if self.active:self.c.showPage()
        self.active=True; self.c.setPageSize(landscape(A4) if wide else A4)
        self.w,self.h=self.c._pagesize; self.x=42; self.bw=self.w-84
        self.pages.append({'page':len(self.pages)+1,'title':title,'section':section})
        c=self.c
        c.setFillColor(BLACK); c.setFont('Hei',17)
        c.drawCentredString(self.w/2,self.h-43,'模拟教学医院')
        c.setFont('Hei',15); c.drawCentredString(self.w/2,self.h-68,title)
        c.setFont('Song',8); c.drawRightString(self.w-42,self.h-22,'病案复印样式 / 教学合成')
        c.setLineWidth(.8); c.line(42,self.h-80,self.w-42,self.h-80)
        self.y=self.h-96
        if meta:
            self.p('姓名：张某某（虚构）　性别：男　年龄：58岁　病案号：SIM-AMI-20260901',small=True)
            self.p('科室：心血管内科 / CCU　入院：2026-09-01 09:20　出院：2026-09-07 10:00',small=True)
            self.y-=4
    def p(self,t,small=False):
        p=Paragraph(glyphs(t),SMALL if small else STYLE); _,hh=p.wrap(self.bw,1000)
        if self.y-hh<48:raise RuntimeError(f'Overflow {self.pages[-1]["title"]}: {t[:50]} y={self.y}')
        p.drawOn(self.c,self.x,self.y-hh); self.y-=hh+(5 if small else 7)
    def sub(self,t):
        self.y-=3
        self.p('<b>'+t+'</b>')
    def table(self,rows,widths=None,fs=9):
        st=ParagraphStyle('tc',parent=CELL,fontSize=fs,leading=fs+4)
        data=[[Paragraph(glyphs(z),st) for z in row] for row in rows]
        tb=Table(data,colWidths=widths or [self.bw/len(rows[0])]*len(rows[0]),hAlign='LEFT')
        tb.setStyle(TableStyle([
            ('VALIGN',(0,0),(-1,-1),'TOP'),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#eeeeee')),
            ('LINEABOVE',(0,0),(-1,0),.8,BLACK),('LINEBELOW',(0,0),(-1,0),.6,BLACK),
            ('LINEBELOW',(0,-1),(-1,-1),.6,BLACK),('LINEBELOW',(0,1),(-1,-2),.25,colors.HexColor('#cccccc')),
            ('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),
            ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
        _,hh=tb.wrap(self.bw,1000)
        if self.y-hh<48:raise RuntimeError(f'Table overflow {self.pages[-1]} y={self.y} h={hh}')
        tb.drawOn(self.c,self.x,self.y-hh);self.y-=hh+12
    def sign(self,t='记录医师：模拟医师A　　审核医师：模拟医师B'):
        self.y-=5;self.p(t+'（均为角色标识，未作真实签署）',small=True)
    def img(self,path,width=None):
        im=Image.open(path); ww=width or self.bw; hh=ww*im.height/im.width
        if self.y-hh<48:raise RuntimeError('Image overflow '+self.pages[-1]['title'])
        self.c.drawImage(str(path),self.x+(self.bw-ww)/2,self.y-hh,ww,hh)
        self.y-=hh+9
    def finish(self):
        self.c.showPage(); self.c.save()
        writer=PdfWriter();writer.clone_document_from_reader(PdfReader(PDF))
        groups={}
        for item in self.pages:
            section=item['section']
            if section not in groups:groups[section]=writer.add_outline_item(section,item['page']-1)
            writer.add_outline_item(item['title'],item['page']-1,parent=groups[section])
        writer.page_mode='/UseOutlines'
        with PDF.open('wb') as f:writer.write(f)
        (TMP/'page_index.json').write_text(json.dumps(self.pages,ensure_ascii=False,indent=2),encoding='utf-8')

def esc(s):return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

# Synthetic calibrated ECGs. Limb leads obey Einthoven and augmented-lead identities.
# These are illustrative signals, not physiological simulator/device output.
def wave(t,hr,r=1,s=.25,st=0,tamp=.3,q=.08,late=False):
    period=60/hr; u=(t%period)-.24
    def g(mu,sd,a):return a*np.exp(-.5*((u-mu)/sd)**2)
    y=g(-.155,.022,.11)+g(-.027,.009,-q)+g(0,.008,r)+g(.029,.012,-s)
    plateau=np.where((u>=.06)&(u<=.17),st,0.)
    tail=np.where((u>.17)&(u<.24),st*(.24-u)/.07,0.)
    y+=plateau+tail+g(.26,.045,tamp)
    return y

def ecg_image(stage,hr):
    scale=8 # pixels per mm at native resolution
    wmm,hmm=275,120; im=Image.new('RGB',(wmm*scale,hmm*scale),'white');d=ImageDraw.Draw(im)
    f=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',28)
    for xx in range(wmm+1):
        d.line((xx*scale,0,xx*scale,hmm*scale),fill='#dd9b9b' if xx%5==0 else '#f2dada',width=2 if xx%5==0 else 1)
    for yy in range(hmm+1):
        d.line((0,yy*scale,wmm*scale,yy*scale),fill='#dd9b9b' if yy%5==0 else '#f2dada',width=2 if yy%5==0 else 1)
    gains=[1,.25,.08,0][stage]
    def sig(name,t):
        i=wave(t,hr,.65,.18,.05*gains,.22 if stage<2 else -.06)
        ii=wave(t,hr,.9,.2,-.025*gains,.18)
        limb={'I':i,'II':ii,'III':ii-i,'aVR':-(i+ii)/2,'aVL':i-ii/2,'aVF':ii-i/2}
        if name in limb:return limb[name]
        k=int(name[1:])-1
        sts=[.15,.30,.40,.30,.20,.10]
        rs=[.15,.32,.58,1.05,1.3,1.05]
        ss=[.8,.85,.65,.30,.18,.10]
        q=.07
        if stage>=2 and k in (1,2,3):rs[k]=.07; ss[k]=.65; q=.32
        return wave(t,hr,rs[k],ss[k],sts[k]*gains,[.2,.45,.62,.5,.32,.24][k] if stage==0 else (-.35 if stage>=2 else .15),q)
    names=[['I','aVR','V1','V4'],['II','aVL','V2','V5'],['III','aVF','V3','V6']]
    for row in range(3):
        base=21+row*26
        # 1 mV / 200 ms calibration pulse
        pts=[(2,base),(4,base),(4,base-10),(9,base-10),(9,base),(11,base)]
        d.line([(int(x*scale),int(y*scale)) for x,y in pts],fill='black',width=2)
        for col in range(4):
            name=names[row][col]; x0=15+col*62.5
            d.text((int((x0+1)*scale),int((base-20)*scale)),name,font=f,fill='black')
            ts=np.linspace(col*2.5,(col+1)*2.5,1500,endpoint=False); ys=sig(name,ts)
            d.line([(int((x0+(t-col*2.5)*25)*scale),int((base-10*y)*scale)) for t,y in zip(ts,ys)],fill='#151515',width=2)
    base=100;d.text((16*scale,82*scale),'II (10 s)',font=f,fill='black')
    ts=np.linspace(0,10,6000); ys=sig('II',ts)
    d.line([(int((15+t*25)*scale),int((base-y*10)*scale)) for t,y in zip(ts,ys)],fill='black',width=2)
    d.text((15*scale,112*scale),'SYNTHETIC ECG | 25 mm/s | 10 mm/mV | illustrative waveform',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',22),fill='#444444')
    path=ASSET/f'ecg_{stage}.png';im.save(path);return path

def coronary_image():
    im=Image.new('RGB',(1600,740),'white');d=ImageDraw.Draw(im)
    ft=ImageFont.truetype('C:/Windows/Fonts/simhei.ttf',30)
    sm=ImageFont.truetype('C:/Windows/Fonts/simsun.ttc',24)
    for offset,post in [(0,False),(800,True)]:
        d.rounded_rectangle((offset+15,15,offset+785,720),12,outline='#bbbbbb',width=2)
        d.text((offset+35,35),'术后：TIMI 3级' if post else '术前：近段闭塞 / TIMI 0级',font=ft,fill='black')
        lm=[(offset+190,145),(offset+270,210),(offset+310,260)]
        lad=[(offset+310,260),(offset+355,340),(offset+385,455),(offset+410,550),(offset+420,650)]
        lcx=[(offset+310,260),(offset+440,245),(offset+560,275),(offset+650,340)]
        d.line(lm,fill='#444444',width=16);d.line(lcx,fill='#666666',width=11)
        d.line(lad,fill='#555555' if post else '#c8c8c8',width=13)
        d.line([(offset+385,455),(offset+500,410),(offset+555,425)],fill='#777777' if post else '#cccccc',width=8)
        d.text((offset+100,155),'LM',font=ft,fill='black');d.text((offset+570,225),'LCX 30%',font=ft,fill='black')
        d.text((offset+440,600),'LAD',font=ft,fill='black')
        if not post:
            d.line([(offset+310,260),(offset+338,309)],fill='#555555',width=15)
            d.line([(offset+315,306),(offset+351,287)],fill='#222222',width=10)
            d.text((offset+60,365),'近段100%闭塞',font=sm,fill='black')
            d.line([(offset+270,380),(offset+335,309)],fill='black',width=2)
        else:
            for z in range(7):
                y=293+z*14;x=offset+329+z*5
                d.line([(x-15,y+5),(x+14,y-4)],fill='#111111',width=3)
            d.text((offset+55,390),'DES 3.0 × 28 mm',font=sm,fill='black')
            d.text((offset+55,425),'残余狭窄 <10%',font=sm,fill='black')
        d.text((offset+40,675),'冠脉结构示意，非造影影像；RCA中段40%（未绘）',font=sm,fill='#555555')
    path=ASSET/'coronary_schema.png';im.save(path);return path

def echo_schema(ef):
    im=Image.new('RGB',(1500,520),'white');d=ImageDraw.Draw(im)
    ft=ImageFont.truetype('C:/Windows/Fonts/simhei.ttf',27)
    sm=ImageFont.truetype('C:/Windows/Fonts/simsun.ttc',24)
    for k,label in enumerate(['舒张末期（结构示意）','收缩末期（运动示意）']):
        off=k*750;d.text((off+35,20),label,font=ft,fill='black')
        outer=(off+210,90,off+485,400)
        d.ellipse(outer,fill='#dedede',outline='#555555',width=3)
        if k==0:inner=(off+245,120,off+450,365)
        else:inner=(off+251,143,off+(410 if ef==45 else 399),342)
        d.ellipse(inner,fill='white',outline='#333333',width=3)
        d.arc(outer,115,250,fill='#111111',width=10)
        d.text((off+20,205),'前壁 / 心尖',font=sm,fill='black')
        d.text((off+20,239),'运动减弱区',font=sm,fill='black')
        d.line((off+170,235,off+224,265),fill='black',width=2)
        d.text((off+530,230),'左室腔',font=sm,fill='black');d.line((off+490,240,off+380,240),fill='black',width=2)
    d.text((35,440),f'LVEF病例设定：{ef}%  |  示意轮廓不用于计算容积或射血分数',font=ft,fill='black')
    d.text((35,480),'非超声采集图；无设备、探头或DICOM数据。用于解释节段性运动异常。',font=sm,fill='#555555')
    path=ASSET/f'echo_schema_{ef}.png';im.save(path);return path

def chest_schema():
    im=Image.new('RGB',(1200,640),'white');d=ImageDraw.Draw(im)
    ft=ImageFont.truetype('C:/Windows/Fonts/simhei.ttf',25)
    # Plain anatomical illustration, deliberately not a synthetic radiograph.
    d.rounded_rectangle((315,45,885,590),110,fill='#eeeeee',outline='#666666',width=3)
    d.ellipse((360,95,580,520),fill='white',outline='#777777',width=3)
    d.ellipse((625,95,840,520),fill='white',outline='#777777',width=3)
    d.rounded_rectangle((582,60,621,315),15,fill='#bbbbbb')
    d.ellipse((510,280,703,510),fill='#b8b8b8',outline='#666666',width=3)
    d.text((25,120),'双肺：无明显实变',font=ft,fill='black');d.line((255,150,420,230),fill='#333333',width=2)
    d.text((880,120),'无肺水肿征象',font=ft,fill='black');d.line((890,155,760,230),fill='#333333',width=2)
    d.text((25,425),'无明显胸腔积液',font=ft,fill='black');d.line((245,460,400,515),fill='#333333',width=2)
    d.text((880,430),'心影未明显增大',font=ft,fill='black');d.line((890,465,670,415),fill='#333333',width=2)
    d.text((210,610),'胸片文字所见的结构示意，非X线影像；不用于影像判读。',font=ft,fill='black')
    path=ASSET/'chest_schema.png';im.save(path);return path

b=Book()
b.page('住院病案复印件式汇编','封面',meta=False)
b.y-=22
b.p('<b>急性广泛前壁ST段抬高型心肌梗死</b>')
b.p('急诊冠状动脉介入治疗及药物洗脱支架置入成功')
b.y-=12
b.table([['项目','病案信息'],['患者','张某某（虚构），男，58岁'],['病案号','SIM-AMI-20260901'],['住院期间','2026年9月1日09:20 至 9月7日10:00'],['核心事件','前降支近段急性血栓性闭塞；急诊置入药物洗脱支架1枚'],['出院转归','好转；LVEF由45%改善至50%'],['文件版本','专家审核版 v1.0 / 编制日期：2026-09-10']],widths=[110,b.bw-110])
b.sub('使用说明')
b.p('本件按医院病案复印资料的阅读顺序和检验单版式制作，全部为教学合成数据。仅供临床专家审核病例逻辑、诊疗合理性及教学适用性。未使用真实机构标识、公章、签名或真实患者信息。')
b.p('检验报告含标本类型、采样/接收/报告时间、参考区间及异常箭头。↑表示高于上限，↓表示低于下限；疾病治疗目标与实验室参考区间分别说明。')
b.p('心电图为按病例参数绘制的校准示意波形，并非设备采集记录。超声、胸片及冠脉造影提供文字报告和对应结构/运动示意图；所有图片均明确标注合成属性。')
b.p('签名栏仅为模拟角色标识。此汇编不是具备法定效力的完整归档病案，不包含真实知情同意签署、费用凭据或护理原始执行凭证。')
b.sign('编制：临床思维训练系统　　临床专家审核：待完成')

b.page('入院记录（一）')
for head,txt in [
('一般资料','姓名张某某，男，58岁，已婚，企业行政人员。本地出生并长期居住。急诊入院，病史由本人及配偶提供，陈述可靠。记录时间：2026-09-01 09:35，评估与救治同步。'),
('主诉','持续胸骨后压榨样疼痛伴大汗1小时20分钟。'),
('现病史','2026-09-01 08:00搬运物品时突发胸骨后压榨样疼痛，约手掌大小范围，向左肩及左上臂内侧放射，疼痛8/10分，伴大汗、恶心及胸闷。停止活动并休息约20分钟无明显缓解，疼痛持续。09:20由家属陪同到达本院急诊，此前未接受院前医疗处理。09:25心电图提示V₁～V₆导联ST段抬高，立即启动导管室。'),
('相关阳性与阴性病史','近2周上楼、快步行走时曾有胸骨后闷痛3次，每次3～5分钟，休息缓解，未就诊。此次无撕裂样胸背痛，无呼吸或体位相关疼痛，无发热、咳嗽、咯血、晕厥及肢体活动障碍，无单侧下肢肿痛。近3个月无手术、长期卧床及长途制动史。发病前饮食睡眠尚可，二便正常，近期体重无明显变化。'),
('既往史','高血压8年，最高约170/100 mmHg，间断服氨氯地平5 mg每日1次，依从性差，平时145～160/90～100 mmHg。2年前发现血脂升高，未规律治疗。否认既往心肌梗死、PCI、心力衰竭、糖尿病、脑卒中及慢性肾病史。否认活动性溃疡、消化道出血、颅内出血、凝血障碍及近期重大创伤手术史。无长期抗凝药使用。否认哮喘、严重慢性肺病、肝炎、结核及输血史。'),
('过敏与近期用药','否认已知药物及造影剂过敏。近期未使用西地那非等PDE-5抑制剂。')]:b.sub(head);b.p(txt)
b.sign()

b.page('入院记录（二）')
for head,txt in [
('个人史、婚育史及家族史','吸烟30年，约20支/日，累计约30包年；偶尔饮酒，无大量饮酒史。运动少，偏咸高脂饮食，无特殊职业接触史。已婚，育有1子，配偶及子女体健。父亲54岁发生心肌梗死，母亲有高血压；否认已知遗传性心肌病及家族性猝死史。'),
('生命体征','T 36.5℃，P 92次/分，R 22次/分；右臂BP 148/92 mmHg、左臂146/90 mmHg；空气下SpO₂ 96%。身高172 cm，体重78 kg，BMI 26.4 kg/m²。'),
('体格检查','神志清楚，急性痛苦面容，皮肤湿冷，口唇无发绀，巩膜无黄染。颈静脉无怒张，气管居中。双肺呼吸音清，无干湿啰音。心率92次/分，律齐，心音稍低，无病理性杂音、第三心音及心包摩擦音。腹平软，无压痛及反跳痛，肝脾肋下未及。双下肢无水肿或不对称肿胀，双侧桡动脉及足背动脉搏动对称。神经系统无局灶性异常。'),
('急诊初步检查','09:25心电图：窦性心律，V₁～V₆ ST段抬高，Ⅲ、aVF对应性压低。09:28采集血液标本，肌钙蛋白尚未回报时已启动紧急再灌注，不等待检验结果。'),
('入院初步诊断','1. 冠状动脉粥样硬化性心脏病：急性广泛前壁ST段抬高型心肌梗死，KillipⅠ级。<br/>2. 原发性高血压，2级，很高危。<br/>3. 血脂异常。')]:b.sub(head);b.p(txt)
b.sign()

b.page('首次病程记录')
b.p('记录时间：2026-09-01 09:40')
for head,txt in [
('病例特点','58岁男性，高血压、血脂异常、长期吸烟及早发冠心病家族史。近2周劳力性胸痛，此次持续胸痛超过1小时，伴大汗及恶心；相邻胸前导联明显ST段抬高，伴下壁对应性压低。无肺啰音、第三心音或低血压。'),
('诊断及依据','急性广泛前壁STEMI。典型缺血性胸痛和定位性ST段抬高足以启动紧急再灌注路径。后续须结合肌钙蛋白动态及造影确认梗死机制。目前KillipⅠ级。'),
('鉴别诊断','①主动脉夹层：无撕裂痛、显著臂间血压差、脉搏缺失及神经症状，可能性低；上述阴性表现不能单独完全排除，如有新线索及时进一步评估。②肺栓塞：无主要静脉血栓风险、低氧或右心负荷表现，心电图更符合前壁冠脉闭塞。③急性心包炎：无体位相关疼痛或摩擦音，ST变化有区域性及对应性。④心肌炎、应激性心肌病：需结合冠脉及心功能检查，不能因此延迟目前再灌注。⑤消化道疾病不能解释定位性心电图改变。'),
('诊疗计划','立即急诊冠脉造影并视情况直接PCI；给予阿司匹林及替格瑞洛负荷、介入期肝素抗凝和强化降脂。持续心电监护、建立静脉通道、备除颤设备。监测疼痛、血压、血氧、出血及心力衰竭征象；完善心肌标志物、血常规、凝血、生化及超声，不等待结果延误开通血管。'),
('风险评估','存在前壁大面积心肌损伤风险，需警惕恶性心律失常、心源性休克、机械并发症及死亡。无明确活动性出血、长期抗凝需要或其他明显高出血风险特征；抗栓方案须在住院及随访中动态复评。')]:b.sub(head);b.p(txt)
b.sign()

b.page('急诊抢救记录')
b.p('抢救时段：2026-09-01 09:20至11:05。抢救诊断：急性广泛前壁STEMI。')
b.table([['时间','病情及处置'],['09:20','胸痛8/10分、大汗；心电监护，建立静脉通道。'],['09:25 / 09:27','完成首份心电图，识别STEMI；启动导管室。'],['09:28','采集血常规、肌钙蛋白、凝血、肝肾功能、电解质及血脂标本。'],['09:30','阿司匹林普通片300 mg嚼服；替格瑞洛180 mg口服。'],['09:32','确认血压及禁忌证后硝酸甘油0.5 mg舌下含服1次；疼痛降至6/10分，BP 136/84 mmHg。'],['09:35 / 09:40','阿托伐他汀40 mg口服；说明PCI方案及风险，模拟同意流程完成。'],['09:50 / 09:52','hs-cTnI 186 ng/L回报；进入导管室。'],['10:04 / 10:12','造影见前降支近段完全闭塞；导丝通过病变。'],['10:16 / 10:24','首次球囊扩张，恢复前向血流；置入药物洗脱支架1枚。'],['10:38 / 10:45','末次造影TIMI 3级，胸痛基本消失；手术结束。'],['11:05','转CCU，循环稳定。']],widths=[86,b.bw-86],fs=9)
b.p('到院至心电图5分钟，至导丝通过52分钟，至首次球囊扩张56分钟；发病至首次球囊扩张2小时16分钟。',small=True)
b.p('SpO₂全程95%～97%，未常规吸氧。无心脏骤停、持续性室速/室颤及休克，未行胸外按压、除颤或升压药治疗。抢救成功指紧急再灌注成功、症状缓解、循环稳定。',small=True)
b.sign('抢救医师：模拟医师A　　协同医师：模拟医师B')

b.page('术前记录及知情沟通摘要')
b.p('记录时间：2026-09-01 09:45；拟手术时间：当日急诊。')
for head,txt in [('术前诊断','急性广泛前壁ST段抬高型心肌梗死。'),('手术指征','症状不足12小时，持续缺血性胸痛，明确ST段抬高，具备立即直接PCI条件。'),('拟行术式','选择性冠状动脉造影，必要时冠状动脉球囊扩张及支架置入术，结合需要进行血管内影像检查。'),('术前评估','患者神志清楚，有自主表达能力，BP稳定，未见肺淤血及休克。已给予双联抗血小板负荷；无已知造影剂过敏、活动性出血及近期重大手术史。检验检查与急诊准备同步，未为等待肾功能等结果延误再灌注。'),('沟通内容','解释前壁急性心梗的生命危险、紧急开通血管的获益及药物治疗、溶栓等替代策略。本院可及时PCI，选择直接PCI。说明出血、血管损伤、过敏、肾损伤、冠脉夹层/穿孔、无复流、支架血栓、紧急外科手术及死亡等风险。患者表示理解并同意；家属参与沟通。'),('麻醉及准备','局部麻醉，右桡动脉入路优先；复核身份、术式、过敏史、抗血小板负荷及抢救设备。'),('文书属性','本页为模拟沟通摘要，不替代真实患者签署的介入手术知情同意书；不生成或模仿真实签字。')]:b.sub(head);b.p(txt)
b.sign()

b.page('冠状动脉介入手术记录（一）')
b.p('日期：2026-09-01　开始：09:55　结束：10:45　麻醉：局部麻醉')
b.p('术式：冠脉造影＋前降支球囊扩张＋药物洗脱支架置入＋血管内超声（IVUS）。')
b.sub('入路、抗凝与造影')
b.p('常规消毒铺巾，1%利多卡因局部浸润麻醉，经右桡动脉置入6 F鞘。普通肝素7,000 U静脉注射，约90 U/kg；术中ACT 286秒。未用糖蛋白Ⅱb/Ⅲa拮抗剂。')
b.table([['血管','造影结果'],['冠脉优势型','右优势型'],['左主干（LM）','无明显狭窄'],['左前降支（LAD）','第一对角支开口前近段完全闭塞，残端不规则、伴血栓征象；TIMI 0级。'],['左回旋支（LCX）','中段约30%狭窄；TIMI 3级。'],['右冠状动脉（RCA）','中段约40%狭窄；TIMI 3级。']],widths=[120,b.bw-120])
b.sub('病变处理')
b.p('判断前降支为梗死相关血管。经6 F EBU 3.5指引导管送入工作导丝，10:12通过闭塞至前降支远端。10:16以2.0×15 mm球囊预扩张，恢复TIMI 2级血流，显示残余约95%狭窄、病变长约24 mm。')
b.p('血流恢复后行IVUS：病变段斑块负荷明显，伴腔内血栓征象；远端参考直径约3.0 mm，近端约3.5 mm。造影及IVUS不等同病理学，未将斑块破裂写为已经证实。')
b.sign('术者：模拟医师A　　助手：模拟医师B')

b.page('冠状动脉介入手术记录（二）')
b.sub('支架置入及结果')
b.p('10:24置入3.0×28 mm药物洗脱支架1枚，12 atm释放。以3.5×12 mm非顺应性球囊对近中段后扩张，最高16 atm，避免超出支架边缘。')
b.p('复查IVUS：支架膨胀及贴壁满意，最小支架面积约7.1 mm²，无明显边缘夹层。10:38末次造影：残余狭窄＜10%，TIMI 3级，对角支通畅，无穿孔、夹层及明显远端栓塞。非罪犯血管无重度狭窄，本次无需介入。未常规血栓抽吸。')
b.table([['项目','结果'],['支架','药物洗脱支架1枚，3.0×28 mm；不虚构厂商、批号或UDI。'],['造影剂','碘克沙醇110 mL'],['术中ACT','286秒（介入抗凝监测值，不采用未抗凝参考区间判异常）'],['血压','118～142/72～88 mmHg'],['估计失血','＜20 mL'],['症状','胸痛由6/10分降至0～1/10分'],['并发症','未发生持续性恶性心律失常、穿孔、无复流等'],['止血','术毕拔鞘，桡动脉压迫器止血，手部末梢循环良好']],widths=[108,b.bw-108])
b.sub('术后诊断与处理')
b.p('急性广泛前壁STEMI；前降支近段急性血栓性闭塞；直接PCI成功。11:05转CCU，继续双联抗血小板及降脂治疗。无其他抗凝指征，术后不常规继续肝素。监测穿刺点、心律、心电图、血红蛋白、尿量及肾功能。')
b.sign('术者：模拟医师A　　助手：模拟医师B')

b.page('主要医嘱汇总')
b.table([['药物/措施','剂量及途径','起止与说明'],['阿司匹林','300 mg嚼服负荷；100 mg口服每日1次','9月1日负荷；9月2日起维持'],['替格瑞洛','180 mg负荷；90 mg口服每日2次','9月1日09:30负荷，当日21:30起维持，约每12小时'],['普通肝素','7,000 U静脉注射','仅介入期，监测ACT；术后停用'],['阿托伐他汀','40 mg口服，每晚1次','9月1日09:35首剂，当日不重复；9月2日起每晚'],['依折麦布','10 mg口服，每日1次','9月2日起'],['美托洛尔缓释片','23.75 mg每日1次，后47.5 mg每日1次','9月2日起低剂量；9月4日增量'],['培哚普利叔丁胺片','2 mg每日1次，后4 mg每日1次','9月2日起；9月4日增量'],['硝酸甘油','0.5 mg舌下含服','9月1日09:32单次；出院备药'],['监护及活动','前48小时持续心电监护；稳定后分阶段活动','9月3日转普通病房，住院Ⅰ期康复']],widths=[105,200,b.bw-305],fs=9)
b.p('本表为主要医嘱整理，不是实际护理给药执行单。培哚普利明确为叔丁胺盐规格，避免与其他盐型混淆。',small=True)
b.p('无临床肺淤血，未用利尿剂；LVEF＞40%、无糖尿病或临床心衰，未常规加用醛固酮受体拮抗剂。无活动性消化性溃疡、出血史及合用抗凝/NSAIDs等明显胃肠道出血危险因素，暂未常规加PPI，后续复评。',small=True)
b.sign()

daily=[
('2026-09-01 11:30','术后首次病程','胸痛、大汗及恶心消失。BP 126/78 mmHg，HR 78次/分，SpO₂ 97%，双肺清，心律齐。右桡动脉穿刺点无出血，手指温暖、感觉正常。前降支支架后TIMI 3级，11:20心电图ST明显回落。继续双联抗血小板、他汀及监护，动态复查标志物，警惕再缺血、心衰、心律失常及出血，完成床旁超声。'),
('2026-09-01 18:00','术后观察','无胸痛或气短，BP 122/76 mmHg，HR 74次/分，尿量正常。穿刺点无渗血，按流程减压，远端灌注良好。超声LVEF 45%，前壁、前间隔及心尖运动减弱，无机械并发症。偶见单发室早，无成对室早或持续性室速，不用预防性抗心律失常药。'),
('2026-09-02 09:00','上级医师查房','夜间无胸痛、气促。BP 124/78 mmHg，HR 72次/分，双肺无啰音。hs-cTnI 32,400 ng/L，为采样最高值；心电图Q波及T倒置符合梗死演变，无新发症状及再次ST抬高，暂不考虑再梗死。结合冠脉确定1型STEMI。虽LVEF轻度降低，无临床心衰，KillipⅠ级。加美托洛尔缓释片23.75 mg每日1次、培哚普利叔丁胺片2 mg每日1次；监测心率、血压、肌酐及钾。LDL-C 4.05 mmol/L，加依折麦布10 mg每日1次。'),
('2026-09-03 09:00','日常病程及CCU转出','无胸痛、心悸及气短，可坐起并短距离步行。BP 120/74 mmHg，HR 68次/分，双肺清。穿刺点少量瘀斑，无血肿。标志物下降，肌酐84 μmol/L，血红蛋白143 g/L，无AKI及临床出血。48小时监护无持续恶性心律失常。转普通病房，交接双联抗血小板、监测出血及康复计划。'),
('2026-09-04 09:00','上级医师查房','无胸痛、气促，病房步行耐受。BP 128/78 mmHg，HR 74次/分，站立无明显头晕。CK-MB恢复参考范围。美托洛尔增至47.5 mg每日1次，培哚普利叔丁胺片增至4 mg每日1次，监测低血压、心动过缓、高钾及肾功能改变。无喘息、房室阻滞或其他药物不耐受。'),
('2026-09-05 09:00','日常病程','无胸痛、心悸及黑便。BP 118/72 mmHg，HR 66次/分。分次步行，每次5～10分钟无不适。已与患者及家属核对药名、剂量和时间，强调抗血小板不可自行停药，患者同意戒烟。无感染或静脉血栓临床表现。继续康复，拟出院前复查心电图、超声及血液。'),
('2026-09-06 09:00','出院前评估','无胸痛、气促、晕厥。BP 116/72 mmHg，HR 64次/分。Hb 145 g/L、PLT 229×10⁹/L、Cr 80 μmol/L、K 4.3 mmol/L，肝功能恢复。hs-cTnI 780 ng/L，仍高于上限但持续下降，无再缺血证据。超声LVEF 50%，未见明确左室血栓。具备出院条件，已安排康复及随访。'),
('2026-09-07 09:00','出院当日病程','无胸痛、心悸或气促。BP 118/74 mmHg，HR 66次/分，空气下SpO₂ 97%，双肺清、心律齐、无下肢水肿。穿刺点愈合良好，生活可自理。核对出院药物及复诊计划，患者能复述胸痛复发及出血警示症状处理方式。今日10:00出院。')]
for k in range(0,len(daily),2):
    b.page(f'病程记录（{k//2+1}）')
    for when,title,txt in daily[k:k+2]:
        b.sub(when+'　'+title);b.p(txt);b.sign();b.y-=16

b.page('出院记录（一）')
for head,txt in [('入院情况','因持续胸骨后压榨样疼痛伴大汗1小时20分钟入院。高血压、血脂异常及长期吸烟史。心电图V₁～V₆ ST段抬高，初始hs-cTnI 186 ng/L。无肺淤血及休克。'),('住院诊疗经过','启动STEMI路径，给予双联抗血小板负荷及降脂。急诊造影见前降支近段TIMI 0级闭塞，置入3.0×28 mm药物洗脱支架1枚，术后TIMI 3级。胸痛消失、ST明显回落。心肌标志物先升后降。未发生持续性恶性心律失常、临床心衰、机械并发症、重大出血及AKI。继续双联抗血小板、强化联合降脂、β受体阻滞剂及ACEI，完成早期康复和二级预防教育。LVEF由45%改善至50%。'),('出院诊断','1. 冠状动脉粥样硬化性心脏病：急性广泛前壁STEMI，1型；前降支近段急性血栓性闭塞；急诊PCI及药物洗脱支架置入术后；入院KillipⅠ级。<br/>2. 原发性高血压，2级，很高危。<br/>3. 血脂异常。'),('出院情况','神志清楚，无胸痛、气促、心悸。BP 118/74 mmHg、HR 66次/分。双肺清，下肢无水肿，桡动脉穿刺点恢复良好，可耐受日常轻体力活动。转归：好转。'),('出院依据','血流重建成功，无进行性缺血及并发症，药物治疗耐受，康复和随访已落实。肌钙蛋白尚未正常、Q波及局部运动异常持续，不妨碍在临床稳定时出院。支架置入不代表心肌完全恢复或冠心病治愈。')]:b.sub(head);b.p(txt)
b.sign()

b.page('出院记录（二）：带药及随访')
b.table([['药物','出院用法','复评说明'],['阿司匹林肠溶片','100 mg，每日1次，整片吞服','当前计划长期；随抗栓策略调整'],['替格瑞洛','90 mg，每日2次，约每12小时','联合阿司匹林默认至少12个月；2027年9月前后复评，期间动态评估出血'],['阿托伐他汀','40 mg，每晚1次','长期，按血脂及耐受调整'],['依折麦布','10 mg，每日1次','联合降脂，复查后调整'],['美托洛尔缓释片','47.5 mg，每日1次','按心率、血压、LVEF及症状复评'],['培哚普利叔丁胺片','4 mg，每日1次','按血压、钾、肾功能调整'],['硝酸甘油','0.5 mg舌下含服，备用','按指导使用，不替代呼叫120']],widths=[110,165,b.bw-275],fs=9)
b.p('以上常规药均为口服，硝酸甘油为舌下含服。美托洛尔不预设所有心梗患者终身固定剂量。不得自行停用抗血小板；手术、拔牙及出血需先与心内科协调。避免自行使用布洛芬、双氯芬酸等NSAIDs。',small=True)
b.sub('复诊计划')
b.p('7～14天心内科复诊：症状、心率血压、依从性及出血评估；复查肌酐、钾，必要时血常规。4～6周复查血脂，按情况复查肝功能；LDL-C目标＜1.4 mmol/L且较基线下降≥50%。未达标则评估依从性并加强治疗。6～12周复查超声心动图。')
b.p('转介门诊心脏康复。戒烟、避免二手烟，限盐及饱和脂肪，逐步控制体重。从舒适速度步行起，避免突然剧烈运动、搬重物及屏气。记录血压心率，血压通常以＜130/80 mmHg且可耐受为目标。')
b.p('复发类似胸痛尤其持续＞5分钟或伴大汗、气短、晕厥：立即呼叫120，不自行驾车。按指导在无低血压或相关禁忌时用备用硝酸甘油，不等反复用药再呼救。呕血、黑便、持续出血或突发剧烈头痛、偏瘫立即急诊并告知抗血小板用药。',small=True)
b.sign()

# Separate laboratory report sheets with automatic reference-range flags.
lab_audit=[]
def lab(title,no,sample,collection,received,reported,rows,note=''):
    b.page(title,'检验报告')
    b.p(f'报告编号：{no}　标本：{sample}　标本状态：合格（模拟）',small=True)
    b.p(f'采样：{collection}　接收：{received}　报告：{reported}',small=True)
    rr=[['检验项目','结果','提示','单位','参考区间']]
    for name,value,unit,lo,hi,ref in rows:
        flag=''
        if isinstance(value,(float,int)):
            if lo is not None and value<lo:flag='↓'
            if hi is not None and value>hi:flag='↑'
        lab_audit.append({'report':no,'name':name,'value':value,'lo':lo,'hi':hi,'flag':flag})
        rr.append([name,str(value),'<b>'+flag+'</b>' if flag else '',unit,esc(ref)])
    b.table(rr,widths=[170,73,42,90,b.bw-375],fs=9.2)
    b.p('结果提示：↑ 高于参考上限；↓ 低于参考下限；空白表示未超出所列区间。',small=True)
    if note:b.p(note,small=True)
    b.p('参考区间为本模拟实验室设定；仅用于该教学病例，非特定品牌试剂说明书。',small=True)
    b.sign('检验者：模拟检验师A　　审核者：模拟检验师B')

def cbc(w,n,h,p):
    ly,mo,eo,ba,rbc,hct,rdw,mpv={12.6:(11,6,.5,.5,4.90,44.1,12.8,10.2),9.4:(20,7,1.5,.5,4.75,42.8,12.9,10.1),7.2:(27,7,2.5,.5,4.81,43.5,12.8,10.2)}[w]
    rows=[('白细胞计数 WBC',w,'×10⁹/L',3.5,9.5,'3.5 - 9.5')]
    for name,v,lo,hi in [('中性粒细胞',n,40,75),('淋巴细胞',ly,20,50),('单核细胞',mo,3,10),('嗜酸性粒细胞',eo,.4,8),('嗜碱性粒细胞',ba,0,1)]:
        rows.append((name+'比例',v,'%',lo,hi,f'{lo} - {hi}'))
    for name,v,lo,hi in [('中性粒细胞',n,1.8,6.3),('淋巴细胞',ly,1.1,3.2),('单核细胞',mo,.1,.6),('嗜酸性粒细胞',eo,.02,.52),('嗜碱性粒细胞',ba,0,.06)]:
        rows.append((name+'计数',round(w*v/100,2),'×10⁹/L',lo,hi,f'{lo} - {hi}'))
    rows.extend([('红细胞计数 RBC',rbc,'×10¹²/L',4.3,5.8,'4.3 - 5.8'),('血红蛋白 Hb',h,'g/L',130,175,'130 - 175'),('红细胞压积 HCT',hct,'%',40,50,'40 - 50'),('平均红细胞体积 MCV',round(hct*10/rbc,1),'fL',82,100,'82 - 100'),('平均红细胞血红蛋白 MCH',round(h/rbc,1),'pg',27,34,'27 - 34'),('平均Hb浓度 MCHC',round(h/(hct/100)),'g/L',316,354,'316 - 354'),('红细胞分布宽度 RDW-CV',rdw,'%',11.5,14.5,'11.5 - 14.5'),('血小板计数 PLT',p,'×10⁹/L',125,350,'125 - 350'),('平均血小板体积 MPV',mpv,'fL',7,13,'7 - 13')])
    return rows
for day,w,n,h,p in [('01',12.6,82,148,236),('03',9.4,71,143,221),('06',7.2,63,145,229)]:
    tm='09:28' if day=='01' else '06:00';recv='09:32' if day=='01' else '06:12';rep='09:45' if day=='01' else '06:40'
    lab('血液检验报告单',f'SIM-CBC-090{int(day)}','EDTA抗凝全血',f'09-{day} {tm}',recv,rep,cbc(w,n,h,p),'新增分类计数及红细胞指数为本版补充的合成数据，与既有WBC/Hb/PLT保持一致。')

def bio(v):
    defs=[('钾 K','mmol/L',3.5,5.3,'3.5 - 5.3'),('钠 Na','mmol/L',137,147,'137 - 147'),('镁 Mg','mmol/L',.75,1.02,'0.75 - 1.02'),('肌酐 Cr','μmol/L',57,97,'57 - 97'),('估算肾小球滤过率','mL/min/1.73m²',90,None,'≥90'),('尿素 Urea','mmol/L',3.1,8.0,'3.1 - 8.0'),('丙氨酸氨基转移酶 ALT','U/L',9,50,'9 - 50'),('天门冬氨酸氨基转移酶 AST','U/L',15,40,'15 - 40'),('总胆红素 TBil','μmol/L',5,21,'5 - 21'),('白蛋白 ALB','g/L',40,55,'40 - 55')]
    return [(n,x,u,lo,hi,r) for (n,u,lo,hi,r),x in zip(defs,v) if x is not None]
for day,vals in [('01',[3.8,139,.84,82,95,5.6,28,36,12.6,43]),('03',[4.2,140,.89,84,92,5.4,31,78,11.8,None]),('06',[4.3,140,.90,80,98,5.2,30,29,12.1,41])]:
    lab('生化检验报告单',f'SIM-BIO-09{day}','血清',f'09-{day} '+('09:28' if day=='01' else '06:00'),'09:32' if day=='01' else '06:12','10:00' if day=='01' else '07:05',bio(vals),'eGFR采用CKD-EPI估算并四舍五入；单次结果不能用于诊断慢性肾病。9月3日白蛋白未复查。')

lab('血脂检验报告单','SIM-LIP-0901','血清（入院、降脂前）','09-01 09:28','09:32','10:10',[
('总胆固醇 TC',6.12,'mmol/L',None,5.2,'<5.2（理想水平）'),('低密度脂蛋白 LDL-C',4.05,'mmol/L',None,3.4,'<3.4（一般人群）'),('高密度脂蛋白 HDL-C',.98,'mmol/L',1.0,None,'≥1.0'),('甘油三酯 TG',1.86,'mmol/L',None,1.7,'<1.7'),('非HDL-C',5.14,'mmol/L',None,4.1,'<4.1（一般人群）')],
'本例为ACS二级预防：LDL-C治疗目标＜1.4 mmol/L且较基线降低≥50%，严于表内一般人群提示界值。采样非空腹，TG需结合采样状态解读。')

lab('凝血功能检验报告单','SIM-COAG-0901','枸橼酸钠抗凝血浆','09-01 09:28','09:32','09:55',[
('凝血酶原时间 PT',11.8,'s',10,14,'10 - 14'),('国际标准化比值 INR',1.02,'',.8,1.2,'0.80 - 1.20'),('活化部分凝血活酶时间',29,'s',25,35,'25 - 35'),('纤维蛋白原 FIB',3.4,'g/L',2,4,'2.0 - 4.0')],'本标本采集于肝素使用前。术中ACT 286秒见手术记录，不能用未抗凝凝血参考区间解释。')

b.page('心肌损伤标志物报告汇编','检验报告')
b.p('检测标本：血清；hs-cTnI方法：高敏免疫测定（模拟）；CK-MB：质量浓度法。',small=True)
marker=[('09-01 09:28','09:32','09:50',186,8.6),('09-01 15:00','15:10','15:40',18600,126),('09-02 06:00','06:12','06:45',32400,184),('09-03 06:00','06:12','06:45',14800,48),('09-04 06:00','06:12','06:45',5260,4.6),('09-06 06:00','06:12','06:45',780,None)]
for i,(t,rc,rp,trop,ck) in enumerate(marker):
    if i==3:
        b.p('本页为前三次独立标本报告的汇编。参考上限按本模拟实验室设定。',small=True)
        b.sign('检验者：模拟检验师A　　审核者：模拟检验师B')
        b.page('心肌损伤标志物报告汇编（续）','检验报告')
        b.p('检测标本：血清；以下为住院后期三次独立标本报告。',small=True)
    b.p(f'<b>SIM-MARK-{i+1:02d}</b>　采样：{t}　接收：{rc}　报告：{rp}',small=True)
    b.table([['项目','结果','提示','参考上限'],['hs-cTnI',str(trop)+' ng/L','↑','男性第99百分位：34 ng/L'],['CK-MB',str(ck)+' ng/mL' if ck is not None else '未复查','↑' if ck is not None and ck>5 else '', '5.0 ng/mL']],widths=[100,150,45,b.bw-295],fs=8.3)
    lab_audit.append({'report':f'SIM-MARK-{i+1:02d}','name':'hs-cTnI','value':trop,'lo':None,'hi':34,'flag':'↑'})
    if ck is not None:lab_audit.append({'report':f'SIM-MARK-{i+1:02d}','name':'CK-MB','value':ck,'lo':None,'hi':5,'flag':'↑' if ck>5 else ''})
b.p('以上为6次独立标本的汇编，非同一次检测；肌钙蛋白并非出院必须正常。标本时间均为2026年。',small=True)
b.sign('检验者：模拟检验师A　　审核者：模拟检验师B')

lab('糖代谢、心衰标志物及尿液报告汇编','SIM-OTHER','见项目说明','见下表','采样后约10分钟','见备注',[
('随机血糖（09-01 09:28）',8.2,'mmol/L',3.9,7.8,'3.9 - 7.8*'),('空腹血糖（09-02 06:00）',5.7,'mmol/L',3.9,6.1,'3.9 - 6.1'),('空腹血糖（09-06 06:00）',5.5,'mmol/L',3.9,6.1,'3.9 - 6.1'),('HbA1c（09-02 06:00）',5.6,'%',4,6,'4.0 - 6.0'),('NT-proBNP（09-01 09:28）',210,'pg/mL',None,125,'<125*'),('NT-proBNP（09-02 06:00）',680,'pg/mL',None,125,'<125*'),('NT-proBNP（09-06 06:00）',260,'pg/mL',None,125,'<125*'),('尿蛋白（09-02 06:20）','阴性','',None,None,'阴性'),('尿潜血（同上）','阴性','',None,None,'阴性'),('尿糖（同上）','阴性','',None,None,'阴性')],
'*随机血糖箭头仅按本模拟实验室提示界值，不能据此诊断糖尿病。NT-proBNP采用非急性参考界值，非急性心衰确诊阈值；本例无临床心衰。血糖及NT-proBNP用血清，HbA1c用EDTA全血，尿常规为晨尿。各项目报告为采样后约60分钟；此页是汇编，非单一标本原单。')

# ECG landscape pages: printed image width of 275 mm retains 25 mm/s and 10 mm/mV.
ecgs=[('2026-09-01 09:25',92,'急性期', '窦性心律；PR 160 ms，QRS 90 ms（病例设定值）。V₁～V₆ ST抬高依次约1.5、3、4、3、2、1 mm；Ⅰ、aVL轻度抬高，Ⅲ、aVF压低约0.5～1 mm；V₂～V₄ T波高耸。提示：急性广泛前壁STEMI。'),('2026-09-01 11:20',78,'再灌注后','窦性心律。V₃ ST抬高由4 mm降至约1 mm，其他抬高导联明显回落，胸前导联ST抬高总幅度下降＞70%。结合胸痛消失及TIMI 3级血流，支持再灌注有效。'),('2026-09-02 07:00',70,'梗死演变期','窦性心律；V₂～V₄病理性Q波或QS波，V₂～V₆ T波倒置，残余ST抬高≤0.5 mm。提示前壁心梗演变，无新发急性缺血表现。'),('2026-09-06 08:00',66,'出院前','窦性心律；V₂～V₄ Q波持续，V₂～V₆ T波倒置，无新发ST抬高或压低。提示梗死后演变。')]
for i,(dt,hr,phase,txt) in enumerate(ecgs):
    b.page('十二导联心电图报告单','心电图',wide=True,meta=False)
    b.x=31;b.bw=b.w-62
    b.p(f'张某某（虚构）　男 / 58岁　SIM-AMI-20260901　检查：{dt}　心率：{hr}次/分　{phase}',small=True)
    # image 275 x 146 mm placed with exact physical calibration, 12-lead 3x4 + rhythm strip
    path=ecg_image(i,hr);ww=275*72/25.4;hh=120*72/25.4
    b.c.drawImage(str(path),(b.w-ww)/2,b.y-hh,ww,hh);b.y-=hh+8
    b.p(txt,small=True)
    b.p('合成示意波形，非设备采集；报告定量值为病例设定，不应用图像自动测量替代。原尺寸打印：25 mm/s、10 mm/mV；缩放打印将改变纸面定标。',small=True)

for dt,ef in [('2026-09-01 12:10',45),('2026-09-06 08:30',50)]:
    b.page('超声心动图检查报告单','影像报告')
    b.p(f'检查时间：{dt}　检查方式：经胸超声心动图　报告编号：SIM-ECHO-'+('01' if ef==45 else '02'),small=True)
    b.table([['项目','结果','提示/解释'],['左室舒张末内径','51 mm' if ef==45 else '未新增设定','初次测量；复查不虚构新值'],['LVEF（双平面Simpson）',f'{ef}%','↓ 低于本报告男性参考下限52%'],['节段性室壁运动','前壁、前间隔中远段及心尖运动减弱','异常；复查较前改善' if ef==50 else '异常，与前降支供血区相符'],['右室','初次大小及收缩功能正常','复查未提示新异常'],['瓣膜','轻度二尖瓣反流','初次所见，结合临床随访'],['左室血栓','未见明确附壁血栓','常规经胸超声有检出局限'],['其他','未见室间隔穿孔、明显乳头肌断裂或心包积液','无明确机械并发症']],widths=[135,175,b.bw-310],fs=9)
    b.sub('超声提示')
    b.p('左室前降支供血区节段性运动异常，左室整体收缩功能轻度减低。'+('较9月1日改善，但LVEF 50%仍低于本报告男性参考下限；不能描述为完全正常。' if ef==50 else '结合急性前壁心肌梗死病史。'))
    b.img(echo_schema(ef))
    b.sign('检查医师：模拟超声医师A　　审核医师：模拟超声医师B')

b.page('胸部X线检查报告单','影像报告')
b.p('检查时间：2026-09-01 13:00　报告时间：13:30　编号：SIM-CXR-0901',small=True)
b.sub('检查方式')
b.p('床旁胸部正位摄影。PCI后检查，未延误冠脉再灌注。')
b.sub('影像所见')
b.p('双肺未见明显实变影或肺水肿征象，肋膈角未见明显变钝，未见明显胸腔积液。心影无明显增大。')
b.sub('影像印象')
b.p('未见明确急性肺部实变、肺水肿及胸腔积液。床旁正位片对心脏大小及部分病变评估有限，应结合临床。')
b.img(chest_schema())
b.p('图为上述文字所见的教学示意。正常胸片不能用于排除急性冠脉综合征、肺栓塞或主动脉夹层。',small=True)
b.sign('报告医师：模拟放射医师A　　审核医师：模拟放射医师B')

b.page('冠状动脉介入前后示意','影像补充')
b.p('与手术记录对应的解剖示意图；不是冠脉造影帧，也不具备影像诊断效力。')
b.img(coronary_image())
b.table([['审核点','病例设定'],['罪犯血管','LAD近段，第一对角支开口前'],['血流变化','TIMI 0 → 2（预扩张后）→ 3（支架及优化后）'],['支架','3.0×28 mm药物洗脱支架；近中段3.5 mm非顺应性球囊后扩张'],['影像优化','IVUS最小支架面积约7.1 mm²，贴壁满意，无边缘夹层'],['非罪犯血管','LCX中段30%，RCA中段40%；本次无需介入']],widths=[120,b.bw-120])
b.p('如需开展正式影像判读能力评估，应补充经授权、脱敏的真实心电图/超声/冠脉造影数据；本件的合成图片适合病例逻辑审核。',small=True)

b.page('编制依据与数据说明','审核附件',meta=False)
b.sub('知识依据与指南范围')
b.p('依据《内科学》急性心肌梗死的症状、心电图演变、心肌标志物及并发症框架编写；未指定教材版本，未虚构页码或原文引述。病例数值均为人工设定，不取自真实患者。')
refs=[
('2025 ACC/AHA/ACEP/NAEMSP/SCAI急性冠脉综合征指南','https://www.acc.org/Guidelines/Guidelines/2025/02/27/17/21/Acute-Coronary-Syndromes-2025','用于急诊再灌注、介入及抗栓策略。'),
('AHA：2025 ACS指南核心要点','https://professional.heart.org/en/science-news/2025-guideline-for-the-management-of-patients-with-acute-coronary-syndromes/top-things-to-know','无高出血风险ACS默认双联抗血小板至少12个月，随风险调整。'),
('2023 ESC急性冠脉综合征指南','https://www.escardio.org/guidelines/clinical-practice-guidelines/all-esc-practice-guidelines/acute-coronary-syndromes/','用于STEMI紧急再灌注与住院、长期管理框架。'),
('ESC：ACS后的长期临床管理','https://www.escardio.org/communities/councils/cardiology-practice/education/cardiopractice/long-term-clinical-management-after-an-acute-coronary-syndrome/','LDL-C＜1.4 mmol/L且下降≥50%；4～6周复查血脂。'),
('JACC：2026血脂管理指南入口','https://www.jacc.org/guidelines/dyslipidemia','纳入2026血脂管理更新的二级预防框架。')]
for i,(title,url,note) in enumerate(refs,1):
    b.p(f'{i}. <a href="{url}" color="#17385b"><u>{title}</u></a><br/>{note}',small=True)
b.sub('本版规范化处理')
b.p('明确首剂他汀当日不重复；双联抗血小板维持时间单列。补齐检验标本及报告时间等合成元数据。出院LVEF 50%仍标↓。随机血糖及NT-proBNP的提示界值与诊断阈值分开。所有新增时间仅用于模拟排版，不声称来自设备或医院信息系统。',small=True)
b.sub('图片与参考区间的限制')
b.p('四张十二导联心电图为程序生成的示意信号，满足纸面速度与幅度定标、体现ST/T/Q演变，但不等同完整生理电信号。超声、胸片、冠脉采用明确标注的结构/运动示意，非原始医学影像；不适合考核真实影像判读能力。检验参考区间和性别阈值采用本模拟实验室设定，真实使用须以实际设备、试剂和机构为准。',small=True)
b.p('检索/编制日期：2026-09-10。引用链接可点击；指南用于解释编制原则，不能把合成患者数值当作指南实证数据。',small=True)

b.page('临床专家审核意见表','审核附件',meta=False)
b.p('病例编号：SIM-AMI-20260901　版本：v1.0　审核专家：____________　日期：____________')
b.table([['审核维度','建议重点','意见'],['病史与诊断','胸痛特征、鉴别诊断、定位、1型心梗依据',''],['时间轴','心电图、给药、导丝、球囊、支架、术后报告',''],['检验一致性','参考区间、↑↓、单位、动态趋势及采样状态',''],['心电图','ST/T/Q演变是否与LAD闭塞及再灌注相符',''],['介入治疗','罪犯血管、支架尺寸、IVUS、抗凝及操作逻辑',''],['住院管理','心功能评估、并发症排查、药物选择及剂量',''],['出院方案','DAPT、降脂、康复、复查及急救教育',''],['教学适用性','合成图局限、病例难度及可训练决策点','']],widths=[92,250,b.bw-342],fs=9)
b.p('总体意见：□ 可用于教学　□ 修改后使用　□ 需重构病例（请手工勾选）')
b.sub('需修改的页码、问题及建议')
for _ in range(7):
    b.c.setStrokeColor(colors.HexColor('#bbbbbb'));b.c.setLineWidth(.4)
    b.c.line(b.x,b.y-17,b.x+b.bw,b.y-17);b.y-=28
b.finish()
(TMP/'lab_audit.json').write_text(json.dumps(lab_audit,ensure_ascii=False,indent=2),encoding='utf-8')
reader=PdfReader(PDF)
texts=[p.extract_text() or '' for p in reader.pages]
assert len(texts)==len(b.pages)
assert all('模拟病例' in t for t in texts)
assert '↓' in ''.join(texts) and '↑' in ''.join(texts)
for x in lab_audit:
    expected='↓' if x['lo'] is not None and isinstance(x['value'],(int,float)) and x['value']<x['lo'] else '↑' if x['hi'] is not None and isinstance(x['value'],(int,float)) and x['value']>x['hi'] else ''
    assert x['flag']==expected,x
(TMP/'extracted_text.txt').write_text('\n\n'.join(texts),encoding='utf-8')
print(json.dumps({'pdf':str(PDF),'pages':len(texts),'lab_values_checked':len(lab_audit),'size_bytes':PDF.stat().st_size},ensure_ascii=False))
