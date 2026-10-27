#!/usr/bin/env node
// Linux/WSL acceptance client: explicit command, JSON argv, project, cases JSON, report path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

async function main() {
  assert.notEqual(process.platform, 'win32', 'Run this MCP acceptance client inside Linux/WSL');
  const [command, argsJson, project, casesPath, reportPath] = process.argv.slice(2);
  assert(command && argsJson && project && casesPath && reportPath, 'command args-json project cases-json report-json');
  assert(require('node:path').isAbsolute(command) && fs.existsSync(command), 'Command must be an existing absolute executable path');
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const env = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_MCP_TOOLS: 'explore,node' };
  const child = spawn(command, JSON.parse(argsJson), { cwd: project, env, stdio: ['pipe','pipe','pipe'], detached: true });
  const report = { command, args: JSON.parse(argsJson), project, codegraphDir: env.CODEGRAPH_DIR, pid: child.pid, checks: [] };
  console.log(`MCP owned pid=${child.pid}`);
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({code,signal}));
    child.once('error', error => resolve({code:null,signal:null,error:error.message}));
  });
  child.stdin.on('error', () => {});
  let seq=0;
  let stderr='';
  const pending = new Map();
  child.once('error', error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  });
  const send = value => child.stdin.write(JSON.stringify(value)+'\n');
  const lines = readline.createInterface({ input: child.stdout });
  child.stderr.on('data', d => { stderr += d; });
  lines.on('line', line => {
    let msg;
    try { msg=JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'roots/list') send({jsonrpc:'2.0',id:msg.id,result:{roots:[{uri:pathToFileURL(project).href,name:'Tolk acceptance'}]}});
      else send({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Unsupported test client method'}});
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const p=pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
    }
  });
  function request(method, params) {
    return new Promise((resolve,reject) => {
      const id=++seq;
      const timer=setTimeout(() => {pending.delete(id);reject(new Error(`MCP timeout ${method}`));},45000);
      pending.set(id,{resolve,reject,timer}); send({jsonrpc:'2.0',id,method,params});
    });
  }
  async function call(name,args) {
    const result=await request('tools/call',{name,arguments:args});
    assert(!result.isError,`${name} isError: ${JSON.stringify(result)}`);
    const text=result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    assert(text.length>0,`${name} empty result`);
    return text;
  }
  let failure;
  try {
    const initialized=await request('initialize',{protocolVersion:'2024-11-05',rootUri:pathToFileURL(project).href,capabilities:{roots:{listChanged:false}},clientInfo:{name:'tolk-acceptance',version:'1'}});
    report.serverInfo=initialized.serverInfo;
    assert(initialized.serverInfo,'initialize serverInfo');
    send({jsonrpc:'2.0',method:'initialized'});
    const listed=await request('tools/list',{});
    report.tools=listed.tools.map(t=>t.name);
    assert(report.tools.includes('codegraph_node')&&report.tools.includes('codegraph_explore'));
    report.checks.push('initialize','tools/list');
    for (const c of cases) {
      const text=await call(c.tool,c.arguments);
      for (const s of c.contains || []) assert(text.includes(s),`${c.label}: missing ${s}`);
      for (const s of c.absent || []) assert(!text.includes(s),`${c.label}: forbidden ${s}`);
      report.checks.push(c.label);
      // Private source is saved only beside this private TEMP report.
      fs.writeFileSync(`${reportPath}.${report.checks.length}.txt`,text);
    }
    assert(!/failed to load.*(tolk|grammar)|grammar.*(load error|not found)/i.test(stderr),stderr);
  } catch(e) { failure=e; }
  finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    child.stdin.end();
    // Upstream can miss stdin EOF; exercise its supported graceful signal handler explicitly.
    report.shutdown = 'SIGTERM';
    if (Number.isInteger(child.pid)) {
      try { process.kill(-child.pid,'SIGTERM'); } catch(e) { if(e.code !== 'ESRCH') throw e; }
    }
    let timeout;
    const graceful=await Promise.race([exited,new Promise(resolve=>{timeout=setTimeout(()=>resolve(null),10000);})]);
    clearTimeout(timeout);
    if (!graceful) {
      report.forcedStop=true;
      if (Number.isInteger(child.pid)) {
        try { process.kill(-child.pid,'SIGKILL'); } catch(e) { if(e.code !== 'ESRCH') throw e; }
      }
      report.exit=await exited;
      failure ||= new Error('MCP did not exit after graceful SIGTERM');
    } else { report.exit=graceful; if(graceful.code !== 0) failure ||= new Error(`MCP exited with ${graceful.code}: ${graceful.error ?? graceful.signal}`); }
    lines.close();
    report.stderr=stderr;
    report.success=!failure;
    report.failure=failure?.message;
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  }
  if(failure) throw failure;
  console.log(JSON.stringify({success:report.success,pid:report.pid,checks:report.checks,exit:report.exit}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
