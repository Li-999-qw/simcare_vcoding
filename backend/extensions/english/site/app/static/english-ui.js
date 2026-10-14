// English presentation typography only. Never modifies form values or records.
(()=>{
  const blocked='script,style,textarea,input,select,option,pre,code,[contenteditable="true"]';
  const punctuation={'，':', ','：':': ','；':'; ','（':' (','）':')','！':'!','？':'?','。':'.','、':', '};
  const seen=new WeakSet();
  function clean(node){
    if(node.nodeType===Node.TEXT_NODE){
      if(node.parentElement?.closest(blocked))return;
      const old=node.nodeValue;
      if(!/[，：；（）！？。、]/.test(old))return;
      const next=old.replace(/([.!?])[。！？]/g,'$1').replace(/[，：；（）！？。、]/g,c=>punctuation[c]);
      if(old!==next)node.nodeValue=next;
      return;
    }
    if(node.nodeType!==Node.ELEMENT_NODE&&node.nodeType!==Node.DOCUMENT_FRAGMENT_NODE)return;
    if(node.nodeType===Node.ELEMENT_NODE&&node.matches(blocked))return;
    if(node.shadowRoot)watch(node.shadowRoot);
    for(const child of node.childNodes)clean(child);
  }
  function watch(root){
    if(seen.has(root))return;seen.add(root);clean(root);
    new MutationObserver(changes=>{for(const change of changes){if(change.type==='characterData')clean(change.target);else for(const n of change.addedNodes)clean(n);}}).observe(root,{subtree:true,childList:true,characterData:true});
  }
  if(document.body)watch(document.body);else document.addEventListener('DOMContentLoaded',()=>watch(document.body),{once:true});
})();
