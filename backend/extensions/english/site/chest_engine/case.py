"""Curated rehearsal subset of build_case_pdf.py, expert-review v1.0 (not approved)."""
CASE_ID = 'SIM-AMI-20260901'
VERSION = 'Expert review edition v1.0 · Pending expert review'
STAGES = ['Patient intake', 'Management and handover', 'Ward round', 'Discharge date', 'Feedback']
TIMES = ['9 month 1 day 09:20', '9 month 1 day 09:35', '9 month 3 day 09:00', '9 month 7 day 09:00', 'End of simulation']
FACTS = {
 'identity': 'Zhang Jianguo, male, 58 years old, married, corporate administrative staff member.',
 'pain': 'At 08:00 on September 1, sudden onset of crushing retrosternal pain while moving items, covering a palm-sized area and radiating to the left shoulder and medial left upper arm, rated 8/10, with profuse sweating, nausea, and chest tightness. No relief after 20 minutes of rest; arrived at the hospital at 09:20 without prior prehospital treatment.',
 'previous': 'Three episodes of retrosternal pressure-like pain while climbing stairs or walking briskly over the past 2 weeks, each lasting 3–5 minutes and relieved by rest; did not seek medical attention.',
 'negatives': 'No tearing chest or back pain, no pain related to breathing or position, and no fever, cough, hemoptysis, syncope, impaired limb movement, or unilateral lower-limb swelling and pain. No surgery, prolonged bed rest, or immobilization during long-distance travel in the past 3 months.',
 'hypertension': 'An 8-year history of hypertension, with a maximum of 170/100 mmHg; takes amlodipine 5 mg once daily intermittently, with poor adherence; usual BP 145–160/90–100 mmHg.',
 'lipid': 'Elevated blood lipids identified 2 years ago; no regular treatment.',
 'past': 'Denies prior myocardial infarction, PCI, heart failure, diabetes mellitus, stroke, or chronic kidney disease. Denies active ulcers, gastrointestinal or intracranial bleeding, coagulation disorders, or recent major trauma or surgery; no long-term anticoagulant use. Denies asthma, severe chronic lung disease, hepatitis, tuberculosis, or blood transfusions.',
 'allergy': 'Denies known allergies to medications or contrast media; no recent use of sildenafil or other PDE-5 inhibitors.',
 'social': 'Smoking for 30 years, approximately 20 cigarettes/day; occasional alcohol use, with no history of heavy drinking. Little exercise, a salty, high-fat diet, and no specific occupational exposures.',
 'family': 'Father had myocardial infarction at age 54; mother has hypertension. Denies known hereditary cardiomyopathy or a family history of sudden death. Spouse and one son are healthy.',
 'ward_patient': 'On September 3, no chest pain, palpitations, or shortness of breath; able to sit up and walk short distances. Mild bruising at the right wrist puncture site, without hematoma or bleeding. Transferred to a general ward.',
 'discharge_patient': 'On September 7, no chest pain, palpitations, or dyspnea; independent in daily activities; puncture site healing well. Able to repeat the explained medication and follow-up plans; willing to quit smoking.',
}
PATIENT_BASE = ['identity','previous','negatives','hypertension','lipid','past','allergy','social','family']
REPORTS = {
 'exam': {'name':'Vital signs and cardiopulmonary examination','category':'Physical examination','stage':0,'text':'September 1, 09:20: T 36.5°C, P 92/min, R 22/min; right-arm BP 148/92, left-arm BP 146/90 mmHg; SpO₂ 96% on room air. Alert, with an acutely distressed appearance and cold, clammy skin. Both lungs clear, with no wheezes or crackles; regular heart rhythm, with no third heart sound, pathological murmurs, or pericardial friction rub. Pulses symmetric bilaterally; no lower-extremity edema.'},
 'ecg': {'name':'12-lead ECG','category':'Electrocardiography','stage':0,'text':'9 month 1 day 09:25：Sinus rhythm，92 times/minutes；V₁～V₆ ST segment elevation，Ⅲ、aVF reciprocal depression. This dialogue exercise provides textual findings, not diagnostic conclusions or images for interpretation.。'},
 'troponin': {'name':'Initial myocardial injury markers','category':'Blood','stage':0,'text':'Blood collection 9 month 1 day 09:28，Report 09:50。hs-cTnI 186 ng/L ↑（Upper Reference Limit 34 ng/L）。To simplify dialogue testing, results are displayed immediately after a request; this does not simulate actual waiting times.。'},
 'handoff': {'name':'Interventional team handoff report','category':'Handover','stage':2,'text':'Emergency coronary angiography on September 1: Complete occlusion of the proximal left anterior descending artery, TIMI grade 0 flow; TIMI grade 3 flow after placement of one drug-eluting stent. Chest pain resolved and ST elevation decreased markedly after the procedure. Transferred to the CCU at 11:05, hemodynamically stable. This is a preset event in the case progression and does not indicate that all Student instructions have been carried out.'},
 'ward': {'name':'Ward reassessment data','category':'Reassessment','stage':2,'text':'September 3: No chest pain, palpitations, or shortness of breath. BP 120/74 mmHg, HR 68/min; both lungs clear. Hb 143 g/L, creatinine 84 μmol/L; cardiac biomarkers declining, with no sustained malignant arrhythmias observed over 48 hours. Postprocedural echocardiography on September 1 showed LVEF 45%, anterior wall, anteroseptal, and apical hypokinesis, with no mechanical complications.'},
 'discharge': {'name':'Repeat testing before discharge','category':'Reassessment','stage':3,'text':'September 6: Hb 145 g/L, PLT 229 ×10⁹/L, Cr 80 μmol/L, K 4.3 mmol/L. hs-cTnI 780 ng/L ↑, continuing to decline; echocardiographic LVEF 50%, with no definite left ventricular thrombus. September 7: BP 118/74 mmHg, HR 66 beats/min, SpO₂ 97% on room air, both lungs clear, and no lower-extremity edema.'},
}
from report_catalog import extend_reports
from copy import deepcopy
LEGACY_REPORTS=deepcopy(REPORTS)
extend_reports(REPORTS)
for key,old in LEGACY_REPORTS.items():
    old['sheet']={'title':old['name'],'number':key,'sample':'Original text report','collected':'See main text','reported':'See main text',
                  'findings':old['text'],'note':'Legacy exercise: retains the text results actually obtained at the time; additional test results from the updated catalog are not added.。'}
    old['positive']=REPORTS[key]['positive'] if key not in ('ecg','troponin') else (
        '9 month 1 day 09:25：V₁～V₆ ST segment elevation，Ⅲ、aVF Reciprocal depression。' if key=='ecg' else
        '9 month 1 day 09:28 Blood collection：hs-cTnI 186 ng/L ↑（Upper Reference Limit 34 ng/L）。')
# Teacher references are stage-limited and never passed to the patient role.
TEACHING = {
 0: 'Discuss the working diagnosis based on the history, ECG, and physical examination findings already obtained. Do not reason backward from unopened reports or later coronary angiography results. Case reference: Regional ST-segment elevation and ischemic symptoms support activating the emergency reperfusion pathway without waiting for peak troponin. Discuss Killip class only when the relevant physical signs have been obtained. Do not falsely claim that a type 1 mechanism was angiographically confirmed before the procedure.',
 1: 'The case reference pathway comprises urgent coordination with the catheterization laboratory, antiplatelet loading, periprocedural anticoagulation, intensive lipid lowering, monitoring, and risk communication. Medications require verification of suitability and contraindications. The Student acts as the receiving physician and does not perform the intervention. All orders are recorded only as plans; execution must be confirmed through the workflow. Do not independently supply doses that have not been configured.',
 2: 'Continue dual antiplatelet therapy and lipid lowering after the procedure; monitor for recurrent ischemia, heart failure, arrhythmias, bleeding, renal function changes, and access-site complications. There is no other indication for anticoagulation; do not routinely continue heparin. Begin progressive rehabilitation once stable. Integrate the opened handover and reassessment materials; elevated troponin alone must not be equated with reinfarction.',
 3: 'The case discharge plan includes medication reconciliation, adherence to antiplatelet therapy, smoking cessation, rehabilitation, follow-up in 7–14 days to assess symptoms, renal function, and potassium, repeat lipid testing in 4–6 weeks, and repeat echocardiography in 6–12 weeks. Explain emergency management for recurrent chest pain and bleeding. Stent placement alone does not establish a cure. Specific doses must follow the reviewed medical record; this exercise does not automatically generate prescriptions.',
 4: 'Review only the actual dialogue, reports opened, and medical record text. List strengths, areas not yet supported by evidence, and recommendations for next time. Do not provide numerical scores or pass judgments, or count undocumented actions as completed. State that this is formative feedback and that the case and scoring remain pending expert review.',
}

# Teaching registration data, supplied before the learner starts interviewing.
REGISTRATION = {
 'name':'Zhang Jianguo','sex':'male','age':'58 years old','marital_status':'Married','occupation':'Corporate administrative staff',
 'ethnicity':'Han Chinese','birthplace':'Hefei, Anhui Province','address':'Room 301, Building 2, Chunhe Yuan, 18 Kangning Road, Wuhou District, Chengdu, Sichuan Province (fictional teaching address).',
 'history_source':'Patient personally','admission_status':'Admission completed; registration information complete',
}

# Canonical, phase-filtered English case facts.
import json as _json
from pathlib import Path as _Path
_case_export=_json.loads((_Path(__file__).resolve().parents[1]/"materials/materials/mi/case.json").read_text(encoding="utf-8"))
FACTS.update(_case_export["FACTS"])
REGISTRATION.update(_case_export["REGISTRATION"])
