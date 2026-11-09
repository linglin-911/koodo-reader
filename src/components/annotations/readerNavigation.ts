import type {AnnotationBinding} from "../../utils/storage/annotationService";
import {useAppStore} from "../../store/useAppStore";
import {canJumpAnnotation} from "../../utils/reader/annotationUtil";
export const bindingLocation=(binding:AnnotationBinding)=>({
  ...(binding.anchor.locator?.cfi?JSON.parse(binding.anchor.locator.cfi):{}),
  chapterDocIndex:String(binding.start_index),chapterTitle:binding.anchor.chapter?.label||binding.anchor.start?.label||"",chapterHref:`title${binding.start_index}`,
  annotationBindingId:binding.id,annotationChapterId:binding.chapter_id,annotationFormat:binding.format,annotationGeneration:binding.generation,annotationStatus:binding.status,annotationStart:binding.relative_start||0,
});
export async function jumpToBinding(binding:AnnotationBinding){
  if(binding.kind==="range")return;
  const state=useAppStore.getState(),rendition=state.reader.htmlBook?.rendition,location=bindingLocation(binding);
  if(!rendition||!canJumpAnnotation(location,rendition))throw Error("Annotation position unavailable");
  if(rendition.isTxtWindowActive?.())await rendition.record();
  state.handleJumpPosition({...rendition.getPosition()});
  if(binding.kind==="chapter")await rendition.goToChapterDocIndex(binding.start_index);
  else await rendition.goToPosition(JSON.stringify(location));
  if(binding.kind!=="small"||binding.format!=="TXT")return;
  const doc=rendition.getDocument() as Document|null;if(!doc)return;
  const ranges:Range[]=[];
  try{ranges.push(rendition.getTxtSourceRange(binding.chapter_id,binding.relative_start,binding.relative_end));}
  catch{for(const element of Array.from(doc.querySelectorAll<HTMLElement>('[data-binding-id]'))){if(element.dataset.bindingId===binding.id){const range=doc.createRange();range.selectNodeContents(element);ranges.push(range);}}}
  const api=doc.defaultView as unknown as {Highlight:new(...ranges:Range[])=>{priority:number};CSS:{highlights:Map<string,unknown>}};
  if(!ranges.length||!api.Highlight||!api.CSS?.highlights)return;
  const name="koodo-annotation-navigation";doc.getElementById(name)?.remove();const style=doc.createElement("style");style.id=name;style.textContent=`::highlight(${name}){background-color:#ffe09b;color:#222}`;doc.head.append(style);const paint=new api.Highlight(...ranges);paint.priority=3000000;api.CSS.highlights.set(name,paint);
  // This feedback ends on the next reading gesture, independently of search/TTS.
  doc.addEventListener("pointerdown",()=>{api.CSS.highlights.delete(name);style.remove();},{once:true});
}
