import {test,before} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {parseBrowserMessage,browserContextMessage} from "../ui/browser-context.js";
const root=fileURLToPath(new URL("..",import.meta.url));let browser:typeof import("../ui/browser.js");
before(async()=>{const result=await build({stdin:{contents:'export * from "./browser.tsx";',resolveDir:join(root,"ui"),loader:"ts"},bundle:true,format:"esm",target:"es2022",jsx:"automatic",jsxImportSource:"preact",write:false,plugins:[{name:"ui-stubs",setup(b){b.onResolve({filter:/^\.\/[\w-]+\.js$/},args=>args.path==="./browser-context.js"?undefined:{path:args.path,namespace:"stub"});b.onLoad({filter:/.*/,namespace:"stub"},()=>({contents:'module.exports={};',loader:"js",resolveDir:root}));}}]});browser=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`);});
test("console attachment label and actual payload share a 20-error cap and disclose omitted entries",()=>{
 const pin={n:1,id:"one",kind:"element" as const,selector:"button",text:"Count",rect:{x:0,y:0,w:10,h:10},url:"http://localhost:3000",viewport:{w:400,h:600},comment:"Fix"};
 for(const count of [1,12,20,25,300]){
  const lines=Array.from({length:count},(_,i)=>({level:"error" as const,text:`error-${i+1}`,at:i}));
  const contexts=parseBrowserMessage(browser.pinsMessage([pin],lines,"batch").text).contexts;
  assert.equal(contexts[0]!.console!.length,Math.min(count,20));assert.equal(contexts[0]!.console!.at(-1),`error-${count}`);
  assert.equal(contexts[0]!.consoleOmitted,count>20?count-20:undefined);
  assert.equal(browser.consoleAttachmentLabel(count),count>20?`with last 20 of ${count} console errors`:`with ${count} console error${count===1?"":"s"}`);
 }
 const lines=Array.from({length:300},(_,i)=>({level:"error" as const,text:`error-${i}`,at:i}));
 const context=parseBrowserMessage(browser.pinsMessage([pin],lines,"batch",12).text).contexts[0]!;
 assert.equal(context.consoleOmitted,292);assert.equal(browser.consoleAttachmentLabel(300,12),"with last 20 of 300+ console errors");
});
test("historical snapshot context remains readable after removing unreachable snapshot producer UI",()=>{
 const legacy={version:1 as const,comment:"Earlier snapshot",text:"",url:"https://example.test",selector:"",source:"snapshot" as const,snapshot:"snapshot-1.png",snapshotPage:{url:"https://example.test",width:800,height:600,full:true}};
 assert.deepEqual(parseBrowserMessage(browserContextMessage(legacy)).contexts,[legacy]);
});
