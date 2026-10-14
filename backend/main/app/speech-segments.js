// Turn an expanding model reply into short, stable pieces for low-latency TTS.
function speechSegments(text, final=false) {
  const segments=[];
  let consumed=0;
  while(consumed<text.length){
    const remaining=text.slice(consumed);
    const ending=remaining.search(/[。！？!?；;\n]/);
    let length=0;
    if(ending>=0&&ending<72)length=ending+1;
    else if(remaining.length>=56){
      const comma=Math.max(remaining.lastIndexOf('，',56),remaining.lastIndexOf(',',56));
      length=comma>=18?comma+1:48;
    }else if(final)length=remaining.length;
    if(!length)break;
    const piece=remaining.slice(0,length).trim();
    if(piece&&!/^[,，。！？!?；;]+$/.test(piece))segments.push(piece);
    consumed+=length;
  }
  return {segments,consumed};
}
if(typeof module!=='undefined')module.exports={speechSegments};
