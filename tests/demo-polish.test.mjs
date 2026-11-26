import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { tDeck } from '../openrig/assets/domain/i18n.js';
import { loadDeckPrefs, saveDeckPrefs, sanitizeBillingPlans, PREFS_STORAGE_KEY } from '../openrig/assets/domain/index.js';
import * as GanttView from '../openrig/assets/ui/gantt-view.js';
const html = await fs.readFile(new URL('../openrig/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function fixture(pathname = '/demo', stored = null) {
 const calls=[], values=new Map(stored ? [[PREFS_STORAGE_KEY,JSON.stringify(stored)]] : []);
 const context={ console, location:{pathname,search:'',protocol:'http:',port:'7440',hostname:'127.0.0.1'}, navigator:{language:'en'},
  localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},sessionStorage:{getItem:()=>null},
  document:{addEventListener(){},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return[];},body:{classList:{toggle(){},contains(){return false;}}}},
  addEventListener(){},requestAnimationFrame(){},setTimeout(){},clearTimeout(){},tDeck,loadDeckPrefs,saveDeckPrefs,sanitizeBillingPlans,PREFS_STORAGE_KEY,GanttView,
  fetch:async(...args)=>{calls.push(args);return {ok:true};} };
 context.window=context;vm.createContext(context);vm.runInContext(script,context);
 return {context,calls,run:code=>vm.runInContext(code,context)};
}
test('sandbox resource boundary rejects APIs and remote discovery before native fetch; live keeps transport', async()=>{
 const demo=fixture();
 for(const url of ['/api/capture?seat=demo','/api/events','/api/resilience/status','/api/update/status','https://registry.npmjs.org/rig-commander/latest']) await assert.rejects(demo.run(`deckFetch(${JSON.stringify(url)})`),/Offline sandbox/);
 assert.equal(demo.calls.length,0);
 const live=fixture('/');await live.run("deckFetch('/api/telemetry')");assert.equal(live.calls[0][0],'/api/telemetry');
});
test('demo fresh defaults select QA, dynamic, collapsed lanes and hidden sleepers; explicit toggles survive',()=>{
 const demo=fixture();demo.run('restoreDeckPreferences()');
 assert.equal(demo.run('selectedAgentId'),'dev-check@core-platform');assert.equal(demo.run('graphLayoutMode'),'dynamic');assert.equal(demo.run('hideIdleNodes'),true);
 const prefs=fixture('/demo',{graphLayout:'fixed',hideIdleNodes:false,swimlanesCollapsed:false,selectedAgentId:'dev-coder@core-platform'});prefs.run('restoreDeckPreferences()');
 assert.equal(prefs.run('selectedAgentId'),'dev-coder@core-platform');assert.equal(prefs.run('graphLayoutMode'),'fixed');assert.equal(prefs.run('hideIdleNodes'),false);
});
test('localized fixture data and authentic harness pairs, including terminal prompt, survive language round-trip',()=>{
 const f=fixture();
 f.run("deckLang='en';localizeDemoData('en')");
 const data=f.run('JSON.stringify({agents:AGENTS,queue:LIVE_QITEMS,decisions:RECENT_DECISIONS,lanes:SLICES_LANES,envelopes:PAIR_ENVELOPES})');
 assert.doesNotMatch(data,/[А-Яа-яЁё]/);
 const agents=JSON.parse(f.run('JSON.stringify(AGENTS)'));
 for(const a of agents){if(a.harness==='claude-code')assert.match(a.model,/^claude-/);if(a.harness==='codex')assert.match(a.model,/^gpt-/);if(a.harness==='gemini-cli')assert.match(a.model,/^gemini-/);}
 assert.match(f.run("getDemoTerminalCapture('dev-check@core-platform')"),/1\. Yes, allow once/);
 f.run("deckLang='ru';localizeDemoData('ru')");assert.match(f.run("getDemoTerminalCapture('dev-check@core-platform')"),/1\. Да, разрешить один раз/);
 f.run("deckLang='en';localizeDemoData('en')");assert.doesNotMatch(f.run("getDemoTerminalCapture('dev-coder3@core-platform')"),/[А-Яа-яЁё]/);
});

test('real demo send fallback localizes status and toast through language round trips without transport',async()=>{
 const f=fixture(), status={textContent:''}, toast={textContent:'',style:{}};
 Object.assign(f.context,{DEFAULT_ACTION_COOLDOWN_MS:1800,DEFAULT_DESTRUCTIVE_COOLDOWN_MS:2200});
 f.context.document.documentElement={};
 f.context.document.getElementById=id=>id==='cmdSendStatus'?status:id==='copyToast'?toast:null;
 f.run(`rebuildDemoIntelligence=renderTriageStrip=renderReservoirs=renderWaitRadarAndDecisions=renderTopology=renderInspectorAndScorecards=fetchTerminalCapture=markDemoQuestStep=updateGraphLayoutSwitchUi=updateActiveFilterLabel=syncDemoHeader=()=>{}`);
 for(const [action,text,type] of [['answer_prompt_option','1 Enter','key'],['cancel_prompt','Escape','key'],['wake_parked_seat','Enter','key'],['interrupt_execution','C-c','key'],['compact_context','/compact','raw'],['send_command','hello','raw']]){
  f.run("deckLang='en';localizeDemoData('en')");
  const result=await f.run(`executeApiSend('dev-check@core-platform',${JSON.stringify(text)},${JSON.stringify(type)},'cmdSendStatus',${JSON.stringify(action)})`);
  assert.equal(result.ok,true);assert.equal(result.demo,true);assert.equal(f.calls.length,0);
  assert.match(status.textContent,/Applied .*Postcondition verified/);assert.doesNotMatch(status.textContent+toast.textContent,/[А-Яа-яЁё]/);
  f.run("setDeckLang('ru',true)");assert.match(status.textContent,/Применено .*Результат проверен/);
  if(action!=='compact_context')assert.match(toast.textContent,/[А-Яа-яЁё]/);
  f.run("setDeckLang('en',true)");assert.doesNotMatch(status.textContent+toast.textContent,/[А-Яа-яЁё]/);
 }
 status.textContent='';toast.textContent='Another operation';
 f.run("setDeckLang('ru',true)");assert.equal(status.textContent,'');assert.equal(toast.textContent,'Another operation');
 f.run("renderDemoQuestFeedback(document.getElementById('copyToast'),'budget',3);setDeckLang('en',true)");
 assert.doesNotMatch(toast.textContent,/[А-Яа-яЁё]/);assert.match(toast.textContent,/Mission progress \(3\/3\)/);
 f.run("setDeckLang('ru',true)");assert.match(toast.textContent,/Прогресс квеста \(3\/3\)/);
});
