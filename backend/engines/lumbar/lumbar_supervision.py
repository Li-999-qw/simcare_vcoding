"""Give the supervisor all returned encounter evidence, including PACS images."""
from pathlib import Path
import copy

def enrich(result,session,root):
    from case import DATA
    from timeline import ready
    returned={k:r for k,r in session.get('report_payloads',{}).items()
              if (k in session.get('requested_reports',[]) and ready(session,k)) or k in session.get('reports',[])}
    result['reports'].update({k:r['text'] for k,r in returned.items()})
    result['report_documents']=copy.deepcopy(returned)
    result['student_viewed_reports']=list(session.get('reports',[]))
    result['pending_examinations']=[k for k in session.get('requested_reports',[]) if not ready(session,k)]
    result['pacs_images']=[]
    for series in DATA['series']:
        key=series['report']
        if key not in returned:continue
        path=Path(root)/'public'/'pacs'/'assets'/series.get('asset',series['id']+'.png')
        entry={'report_id':key,'series':series['name'],'plane':series.get('plane'),
               'file':path.name,'collected':returned[key]['sheet']['collected'],
               'source':'系统PACS教学合成影像，与学员阅片使用同一素材；多帧图可能为拼图，不是诊断级DICOM。'}
        if path.is_file():
            if str(path) not in result['image_paths']:result['image_paths'].append(str(path))
            entry['attached']=True
        else:entry['attached']=False
        result['pacs_images'].append(entry)
    result['supervision_policy']='你同步跟进整个接诊。reports和report_documents包含所有已返回结果，无需学员先打开报告；pacs_images列出本轮自动附上的系统原始教学影像。结合图片、报告正文、完整问诊、病历、药品及操作记录回答，不要求重复上传已有图像或报告。已返回与学生已查看不同，student_viewed_reports才表示学生打开过，点评不能把自动同步当成学生已阅片。未返回结果不作推断。附图为教学合成图，报告与图像不一致或图像无法辨认时据实说明，不能把报告描述说成自己在图上确认。系统影像可引用对应report_id；外部截图仍需区分来源。仅在确实缺少所需序列或清晰度时提出具体补充要求。考试模式仍不提供教学答案。'

