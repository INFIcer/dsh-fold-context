
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { FoldStore } from '../lib/store.js'
import { collectRecords, buildReportModel } from '../lib/inspect.js'
import { ConfigStore } from '../lib/config.js'
const HOME = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh'
const SURFACE = new Set(['system/message','developer/message','user/message','assistant/message','tool/result'])
const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd])
function findLog(id){ const root=join(HOME,'sessions'); const bare=id.replace(/^session-/,''); for(const d of readdirSync(root)){ const c=join(root,d,'session-'+bare,'session.v4.jsonl.zstd'); if(existsSync(c)) return c } return '' }
const raw = readFileSync(findLog('session-8c5907c7-41de-4966-b43f-95b080ab7dea'))
const offs=[]; for(let i=0;i+4<=raw.length;i+=1){ if(raw[i]===MAGIC[0]&&raw[i+1]===MAGIC[1]&&raw[i+2]===MAGIC[2]&&raw[i+3]===MAGIC[3]) offs.push(i) }
let text=''; for(let k=0;k<offs.length;k+=1){ try{ text += zstdDecompressSync(raw.subarray(offs[k], k+1<offs.length?offs[k+1]:raw.length)).toString('utf8') }catch{} }
const events=[]; for(const line of text.split('\n')){ const t=line.trim(); if(!t) continue; try{ const e=JSON.parse(t); if(typeof e.seq==='number') events.push(e) }catch{} }
events.sort((a,b)=>a.seq-b.seq)
const nodes=[]; for(const e of events){ if(!SURFACE.has(e.type)) continue; const op=e.surfaceOp; if(op&&op.op==='replace'){ const s=nodes.indexOf(op.startSeq), f=nodes.indexOf(op.endSeq); if(s>=0&&f>=0) nodes.splice(s,f-s+1,e.seq) } else nodes.push(e.seq) }
const bySeq=new Map(events.map(e=>[e.seq,e]))
const derived=[]; for(const seq of nodes){ const e=bySeq.get(seq); const m = e.type==='user/message'? e.data : e.data&&e.data.message; if(!m||!Array.isArray(m.content)) continue; if(e.type!=='user/message'&&m.content.length===0) continue; derived.push(m) }
const store=new FoldStore({homeDir:HOME, sessionId:'session-8c5907c7-41de-4966-b43f-95b080ab7dea'})
const rec=collectRecords(store)
const config=new ConfigStore({homeDir:HOME}).load({})
const model=buildReportModel({sessionId:'s', derivedMessages:derived, folds:rec.folds, pins:rec.pins, recalls:rec.recalls, config, now:Date.now()})
for(const g of model.turnGroups){
  console.log([g.kind, 'ord='+g.ordinal, 'turn='+g.turn, 'folded='+g.folded, 'pre='+g.prePlugin, 'short='+g.short, 'steps='+g.steps, 'chars='+g.chars, 'unfolded='+g.unfoldedChars, 'folds='+g.foldIds.join(','), 'entries='+g.entries.length, 'user='+JSON.stringify(String(g.userText||'').slice(0,40)), 'reply='+JSON.stringify(String(g.replyText||'').slice(0,40))].join(' | '))
}
console.log('---- entry kinds per group ----')
for(const g of model.turnGroups){
  console.log('group', g.ordinal, 'turn', g.turn, ':', g.entries.map(e=>e.foldId||e.sourceKind||e.role).join(','))
}
