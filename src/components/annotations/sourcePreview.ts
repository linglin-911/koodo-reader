import * as Kookit from "../../assets/lib/kookit.min";
import {openPersistentTxt} from "../../utils/storage/txtIndexService";
import {getParserRegex} from "../../utils/common";
import type {AnnotationBinding} from "../../utils/storage/annotationService";
import type Book from "../../models/Book";
interface PreviewRendition {
 renderTo:(element:HTMLElement)=>Promise<void>;goToChapterDocIndex:(index:number)=>Promise<void>;goToPosition:(position:string)=>Promise<void>;removeContent:()=>Promise<void>;
 getDocument:()=>Document;getTxtSourceRange:(id:string,start:number,end:number)=>Range;
 getTxtWindowState:()=>{blocks:Array<{start:number;end:number}>}|undefined;
}
export async function createSingleChapterPreview(book:Book,binding:AnnotationBinding,element:HTMLElement,signal:AbortSignal){
 if(book.format!=="TXT"||binding.format!=="TXT"||binding.status!=="active"||binding.kind==="range"||binding.book_id!==book.key)throw Error("Unsupported preview position");
 const opened=await openPersistentTxt(book.key,book.path,book.charset,getParserRegex("TXT",book.key),{signal});
 let rendition:PreviewRendition|undefined;
 const destroy=async()=>{if(rendition)await rendition.removeContent();else await opened.store?.close();};
 try{
  if(!opened.store)throw Error("Preview source unavailable");
  const index=await opened.store.ensureBlocks(),directory=await opened.store.readDirectory();
  const chapter=index.chapters[binding.start_index];
  if(signal.aborted||directory.generation!==binding.generation||chapter?.chapterId!==binding.chapter_id)throw Error("Stale preview position");
  // Rebase only the preview's ordinal. Byte/text coordinates and chapter ID stay
  // original, and every read is delegated to the selected source chapter.
  const previewChapter={...chapter,index:0},previewIndex={...index,chapters:[previewChapter]};
  const store={sourceTicket:opened.store.sourceTicket,load:async()=>previewIndex,prepare:async()=>previewIndex,ensureBlocks:async()=>previewIndex,save:async()=>{throw Error("Preview index is read-only");},readDirectory:async()=>({generation:directory.generation,chapters:[{index:0,chapterId:chapter.chapterId,label:chapter.label}]}),readChapter:async()=>{throw Error("Preview requires bounded reads");},readChapterRange:(_chapter:unknown,offset:number,length:number)=>opened.store!.readChapterRange(chapter,offset,length),close:()=>opened.store!.close()};
  rendition=Kookit.BookHelper.getRendition(new ArrayBuffer(0),{format:"TXT",charset:opened.encoding,parserRegex:getParserRegex("TXT",book.key),txtIndexStore:store,readerMode:"scroll",txtContinuousScroll:true,animation:"none",isMobile:"no",platform:"electron"},Kookit) as PreviewRendition;
  await rendition.renderTo(element);if(signal.aborted)throw Error("Preview cancelled");
  const doc=rendition.getDocument();doc.body.style.cssText+=";font-size:18px;line-height:1.8;margin:0;";
  await rendition.goToChapterDocIndex(0);
  if(binding.kind==="small"){
   await rendition.goToPosition(JSON.stringify({chapterDocIndex:"0",txtWindow:{version:1,chapterId:chapter.chapterId,generation:directory.generation,offset:chapter.bodyStart-chapter.start+(binding.relative_start||0)}}));
   const blocks=rendition.getTxtWindowState()?.blocks||[],end=Math.min(binding.relative_end||0,Math.max(0,...blocks.map(block=>block.end)));
   const range=rendition.getTxtSourceRange(chapter.chapterId,binding.relative_start||0,end);
   const api=doc.defaultView as unknown as {Highlight:new(...ranges:Range[])=>{priority:number};CSS:{highlights:Map<string,unknown>}};
   const style=doc.createElement("style");style.textContent="::highlight(koodo-preview-anchor){background-color:#ffe09b;color:#222}";doc.head.append(style);const highlight=new api.Highlight(range);highlight.priority=3000000;api.CSS.highlights.set("koodo-preview-anchor",highlight);
  }
  if(signal.aborted)throw Error("Preview cancelled");
  return {destroy,doc,chapterId:chapter.chapterId};
 }catch(error){await destroy();throw error;}
}
