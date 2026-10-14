"""Operation order catalogue and validation for the teaching simulator."""
CATALOG = [
 ('paracentesis','诊断性腹腔穿刺','zdx fqcc','目的与送检项目;穿刺安全评估与知情沟通'),
 ('repeat-paracentesis','复查腹腔穿刺','fcfqcc','复查目的;送检项目与安全评估'),
 ('drainage','治疗性放腹水','zlxffs','适应证与风险评估;计划排液量;白蛋白与监测计划'),
 ('weight','体重与腹围监测','tzfwjc','测量条件;频次及异常通知条件'),
 ('ecg','心电监护','xdjh',''),
 ('spo2','血氧饱和度监测','xybhdjc',''),
 ('bp','无创血压监测','wcxyjc','测量间隔;测量部位（选填）'),
 ('vitals','生命体征监测','smtzjc','监测项目;各项目频次'),
 ('balance','出入量记录','crljl','记录范围;汇总周期'),
 ('urine','尿量监测','nljc','记录周期;异常通知条件（选填）'),
 ('oxygen','吸氧','xy','装置|鼻导管、普通面罩、储氧面罩、文丘里面罩;流量（L/min）;目标血氧范围（选填）'),
 ('nebulizer','雾化吸入','whxr','装置|压缩式、氧驱动、网式;关联药品医嘱;驱动流量（L/min，氧驱动时填写）'),
 ('iv','外周静脉留置针置入','wzjmlzzzr lzz','部位/侧别;数量;规格（选填）'),
 ('line-care','静脉通路维护','jmtlwh','通路类型;部位;维护项目;关联冲封管药品（选填）'),
 ('line-remove','拔除静脉导管','bcjmdg','导管类型;部位/侧别'),
 ('pump','输液泵辅助输注','sybfzsz','关联药品医嘱;速度（mL/h）;目标输注量（mL）'),
 ('micro-pump','微量泵辅助输注','wlbfzsz','关联药品医嘱;泵速（mL/h）;药液浓度'),
 ('puncture','穿刺部位观察','ccbwg ccbwgc','部位/侧别;观察项目|出血、血肿、末梢循环'),
 ('compression','穿刺点压迫止血','ccdypzx','部位/侧别;压迫方式;减压/解除方案'),
 ('activity','体位与活动限制','twyhdxz','活动范围|卧床、床边活动、下床活动;限制部位（选填）'),
 ('diet','饮食医嘱','ysyz','饮食|禁食、流质、半流质、普通饮食;饮水要求（选填）'),
 ('nursing','护理级别','hljb','级别|特级、一级、二级、三级'),
]

def catalogue():
    return [dict(id=i,name=n,pinyin=p,fields=[dict(label=f.split('|')[0],options=f.split('|')[1].split('、') if '|' in f else []) for f in fields.split(';') if f]) for i,n,p,fields in CATALOG]

def validate(rows):
    if not isinstance(rows,list) or not 1<=len(rows)<=50: raise ValueError('请填写1～50条操作医嘱。')
    choices={x['id']:x for x in catalogue()}
    for row in rows:
        if not isinstance(row,dict) or row.get('operation_id') not in choices: raise ValueError('请确认操作名称。')
        for key in ('frequency','duration','type','remark'):
            if not isinstance(row.get(key),str) or len(row[key])>1000: raise ValueError('操作医嘱格式错误。')
        if row['type'] not in ('长期医嘱','临时医嘱') or not row['frequency'].strip() or not row['duration'].strip(): raise ValueError('请填写频次、时长及医嘱类型。')
        fields=choices[row['operation_id']]['fields']
        params=row.get('params')
        if not isinstance(params,dict) or set(params)!={f['label'] for f in fields}: raise ValueError('操作参数不完整。')
        for f in fields:
            value=params[f['label']]
            if not isinstance(value,str) or len(value)>1000: raise ValueError('参数格式错误。')
            optional='选填' in f['label'] or '氧驱动时' in f['label']
            if not optional and not value.strip(): raise ValueError('请填写：'+f['label'])
            if f['options'] and value not in f['options']: raise ValueError('请选择：'+f['label'])
        if row['operation_id']=='nebulizer' and params['装置']=='氧驱动' and not params['驱动流量（L/min，氧驱动时填写）'].strip(): raise ValueError('请填写氧驱动流量。')
    return choices
