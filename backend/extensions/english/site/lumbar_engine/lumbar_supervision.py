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
               'source':'System PACS Synthetic teaching images using the same materials provided for Student image review; multi-frame images may be montages and are not diagnostic-grade.DICOM。'}
        if path.is_file():
            if str(path) not in result['image_paths']:result['image_paths'].append(str(path))
            entry['attached']=True
        else:entry['attached']=False
        result['pacs_images'].append(entry)
    result['supervision_policy']='You follow the entire encounter as it progresses。reports And report_documents Includes all results received, without requiring the Student to open the reports first；pacs_images List the original system teaching images automatically attached in this round. Answer using the images, report text, complete history-taking dialogue, clinical notes, and medication and procedure records. Do not request re-uploading of existing images or reports. Results being returned is not the same as the Student having reviewed them.，student_viewed_reports only indicates that the Student opened it; feedback must not equate automatic synchronization with Student image review. Do not infer results that have not been returned. Attached images are synthetic teaching images. If the report and image are inconsistent or the image is indiscernible, state this accurately; do not claim to have confirmed report findings on the image yourself. System images may cite the corresponding report_id；External screenshots must still be distinguished by source. Request specific additions only when required sequences or adequate image clarity are genuinely missing. Exam mode still does not provide teaching answers.。'

