import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Supply the owned image for this synthetic component fixture without Factory. */
export async function installOrcaFixtureAssets(page) {
  await page.route("**/api/images/42/content", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CiAAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
}

/** Generate the synthetic component page shared by headless loader checks and Orca acceptance. */
export async function writeOrcaFixture(output, repository) {
  const fixture = resolve(output, "fixture");
  await mkdir(fixture, { recursive: true });
  await writeFile(
    resolve(fixture, "index.html"),
    '<title>Proser R2 Orca</title><main id="root"></main><script type="module" src="/fixture.tsx"></script>',
  );
  await writeFile(
    resolve(fixture, "fixture.tsx"),
    `
import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {SemanticDocument} from '${repository}ProserAuthor/packages/editor/src/components/semantic-document.tsx';
import {CanvasDocumentEditor} from '${repository}ProserAuthor/packages/editor/src/components/canvas-document-editor.tsx';
import {documentFromText,canonicalDocument,projectDocument} from '${repository}ProserAuthor/packages/editor/src/document-model.ts';
import {paragraphSelection} from '${repository}ProserAuthor/packages/editor/src/document-selection.ts';
let n=0;const id=()=> 'orca-'+(++n);
const document=documentFromText('R2 screen reader manuscript\\n\\nAccessible paragraph with Unicode 😀 e\\u0301\\n\\nFirst list item\\n\\nSecond list item',id);
document.blocks[0].style.heading=2;
document.blocks[2].style.list='bullet';document.blocks[3].style.list='bullet';
const cell=documentFromText('Table cell content',id).blocks[0];
document.blocks.push({type:'table',id:id(),widths:[160],rows:[{id:id(),cells:[{id:id(),paragraphs:[cell]}]}]});
document.blocks.push({type:'image',id:id(),assetId:42,sha256:'a'.repeat(64),alt:'Accessible image description',width:32,height:32});
const nativeDocument=structuredClone(document);
nativeDocument.layout.font='Arial';
const initialSelection=paragraphSelection(nativeDocument,nativeDocument.blocks[0].id,0,0,nativeDocument.blocks[0].runs[0].text,true);
function NativeFixture(){
const [value,setValue]=useState(nativeDocument);const current=useRef(value);const history=useRef({undo:[],redo:[]});
window.nativeFixture={canonical:canonicalDocument(value),text:projectDocument(value).text,protected:canonicalDocument({layout:value.layout,blocks:value.blocks.slice(1),changes:value.changes,comments:value.comments}),undoCount:history.current.undoCount??0,redoCount:history.current.redoCount??0};
const update=(next)=>{current.current=next;setValue(next);};
const change=(next)=>{if(canonicalDocument(next)===canonicalDocument(current.current))return;history.current.undo.push(current.current);history.current.redo=[];update(next);};
const undo=()=>{const previous=history.current.undo.pop();if(!previous)return;history.current.redo.push(current.current);history.current.undoCount=(history.current.undoCount??0)+1;update(previous);};
const redo=()=>{const next=history.current.redo.pop();if(!next)return;history.current.undo.push(current.current);history.current.redoCount=(history.current.redoCount??0)+1;update(next);};
return <><h1>Native and accessible writing</h1><CanvasDocumentEditor document={value} initialSelection={initialSelection} onChange={change} onUndo={undo} onRedo={redo} canUndo={history.current.undo.length>0} canRedo={history.current.redo.length>0} onError={(message)=>window.nativeErrors=(window.nativeErrors??[]).concat(message)} onRejectedEdit={(_,message)=>window.nativeErrors=(window.nativeErrors??[]).concat(message)}/></>;
}
function App(){const [value,setValue]=useState(document);const [editing,setEditing]=useState(true);const [native,setNative]=useState(false);return native?<NativeFixture/>:<><h1>Proser R2 Orca acceptance</h1><button onClick={()=>setNative(true)}>Open native editor</button><button onClick={()=>setEditing(!editing)}>{editing?'Read only mode':'Edit mode'}</button><button>Reader start</button><SemanticDocument document={value} editable={editing} onEditParagraph={(blockId,text)=>{const next=structuredClone(value);const block=next.blocks.find(item=>item.id===blockId);if(block?.type!=='paragraph'||block.runs.length!==1)return false;block.runs[0].text=text;setValue(next);window.orcaEdits=(window.orcaEdits??0)+1;}}/><p role="status">{editing?'Saved fixture ready':'Read-only mode enabled'}</p></>}
createRoot(window.document.getElementById('root')).render(<App/>);
`,
  );
  return fixture;
}
