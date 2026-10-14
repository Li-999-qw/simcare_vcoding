"""Operation order catalogue and validation for the teaching simulator."""
CATALOG = [
 ('ecg','ECG Monitoring','xdjh',''),
 ('spo2','Oxygen saturation monitoring','xybhdjc',''),
 ('bp','Noninvasive blood pressure monitoring','wcxyjc','Measurement Interval;Measurement site (optional）'),
 ('vitals','Vital signs monitoring','smtzjc','Monitoring Items;Frequency of each item'),
 ('balance','Intake and output chart','crljl','Recording Scope;Summary Period'),
 ('urine','Urine Output Monitoring','nljc','Recording Interval;Conditions for abnormality notifications (optional）'),
 ('oxygen','Oxygen therapy','xy','Device|Nasal cannula, simple face mask, reservoir mask, Venturi mask;Flow rate（L/min）;Target oxygen saturation range (optional）'),
 ('nebulizer','Nebulized inhalation','whxr','Device|Compressor, oxygen-driven, mesh;Link Medication Orders;Driving flow rate（L/min，Complete when oxygen-driven）'),
 ('iv','Peripheral intravenous catheter insertion','wzjmlzzzr lzz','Site/Laterality;Quantity;Specification (optional）'),
 ('line-care','IV access maintenance','jmtlwh','Access Type;Site;Maintain Items;Link flushing and locking medications (optional）'),
 ('line-remove','Remove the venous catheter','bcjmdg','Catheter Type;Site/Laterality'),
 ('pump','Infusion pump-assisted infusion','sybfzsz','Link Medication Orders;Speed（mL/h）;Target infusion volume（mL）'),
 ('micro-pump','Syringe pump-assisted infusion','wlbfzsz','Link Medication Orders;Pump rate（mL/h）;Medication Solution Concentration'),
 ('puncture','Puncture site observation','ccbwg ccbwgc','Site/Laterality;Observation Items|Bleeding, hematoma, peripheral circulation'),
 ('compression','Apply pressure to the puncture site for hemostasis','ccdypzx','Site/Laterality;Compression method;Decompression/Discontinuation Plan'),
 ('activity','Positioning and activity restrictions','twyhdxz','Range of Motion|Bed rest, bedside activity, out-of-bed activity;Restricted site (optional）'),
 ('diet','Diet orders','ysyz','Diet|Nothing by mouth, liquid diet, soft diet, regular diet;Water intake requirements (optional）'),
 ('nursing','Nursing Care Level','hljb','Level|Special, Level I, Level II, and Level III nursing care'),
]

def catalogue():
    return [dict(id=i,name=n,pinyin=p,fields=[dict(label=f.split('|')[0],options=f.split('|')[1].split('、') if '|' in f else []) for f in fields.split(';') if f]) for i,n,p,fields in CATALOG]

def validate(rows):
    if not isinstance(rows,list) or not 1<=len(rows)<=50: raise ValueError('Please fill in 1～50 Procedure orders。')
    choices={x['id']:x for x in catalogue()}
    for row in rows:
        if not isinstance(row,dict) or row.get('operation_id') not in choices: raise ValueError('Please confirm the procedure name。')
        for key in ('frequency','duration','type','remark'):
            if not isinstance(row.get(key),str) or len(row[key])>1000: raise ValueError('Invalid procedure order format。')
        if row['type'] not in ('Long-term orders','One-time orders') or not row['frequency'].strip() or not row['duration'].strip(): raise ValueError('Enter frequency, duration, and order type。')
        fields=choices[row['operation_id']]['fields']
        params=row.get('params')
        if not isinstance(params,dict) or set(params)!={f['label'] for f in fields}: raise ValueError('Incomplete procedure parameters。')
        for f in fields:
            value=params[f['label']]
            if not isinstance(value,str) or len(value)>1000: raise ValueError('Invalid parameter format。')
            optional='Optional' in f['label'] or 'When Oxygen-Driven' in f['label']
            if not optional and not value.strip(): raise ValueError('Please fill in：'+f['label'])
            if f['options'] and value not in f['options']: raise ValueError('Please select：'+f['label'])
        if row['operation_id']=='nebulizer' and params['Device']=='Oxygen-driven' and not params['Driving flow rate（L/min，Complete when oxygen-driven）'].strip(): raise ValueError('Enter the oxygen driving flow rate。')
    return choices
