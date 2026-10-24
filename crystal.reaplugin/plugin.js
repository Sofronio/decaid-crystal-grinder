function createPlugin(host) {
  const service = "7fa2d10c-12f3-4b9e-9d77-1a9b65432100";
  const channels = {
    motorRpm: "7fa2d10c-12f3-4b9e-9d77-1a9b65432101",
    feedRpm: "7fa2d10c-12f3-4b9e-9d77-1a9b65432102",
    bootSign: "7fa2d10c-12f3-4b9e-9d77-1a9b65432103",
    sysState: "7fa2d10c-12f3-4b9e-9d77-1a9b65432104",
    servoAngle: "7fa2d10c-12f3-4b9e-9d77-1a9b65432105",
    targetAngle: "7fa2d10c-12f3-4b9e-9d77-1a9b65432106",
  };
  const order = [
    "motorRpm",
    "feedRpm",
    "bootSign",
    "sysState",
    "servoAngle",
    "targetAngle",
  ];
  // The protocol's handshake subscribes in priority order: the state truth
  // source and the position feedback first, then the command/measurement
  // channels. Reading and display still use `order`.
  const subscribeOrder = [
    "sysState",
    "servoAngle",
    "bootSign",
    "motorRpm",
    "feedRpm",
    "targetAngle",
  ];
  const bootLabels = {
    1: ["Manual start", "手动启动"],
    2: ["Timed start", "定时启动"],
    3: ["Smart start", "智能启动"],
    4: ["Stop", "停止"],
    5: ["Apply grind size", "应用研磨度"],
  };
  const bootModeValues = { manual: 1, timed: 2, smart: 3 };
  const defaults = {
    motorRpm: 850,
    feedRpm: 20,
    grindSize: 500,
    bootMode: "smart",
  };
  const namespace = "crystal.reaplugin";
  const storageKey = "config";
  const applyCommand = 5;
  const stopCommand = 4;
  const settleDelayMs = 1500;
  const busyEnterTimeoutMs = 5000;
  const busyExitTimeoutMs = 60000;
  const stopTimeoutMs = 10000;
  const skinPushIntervalMs = 1000;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Every value on the wire is a UInt16, big-endian, exactly two bytes. The
  // protocol document is still UNCONFIRMED on this point; the big-endian
  // decoding is the one measured on hardware (0x01F3 = 499).
  function decodeUint16(bytes) {
    return ((bytes[0] << 8) | bytes[1]) & 0xffff;
  }

  function encodeUint16(value) {
    const clamped = Math.max(0, Math.min(0xffff, Math.round(Number(value))));
    return [(clamped >> 8) & 0xff, clamped & 0xff];
  }

  // SYS_STATE is documented as one byte, while the other channels are two.
  // Accept both so a firmware that mirrors the others still decodes.
  function decodeState(bytes) {
    if (!bytes || bytes.length === 0) return null;
    if (bytes.length === 1) return bytes[0] & 0xff;
    return decodeUint16(bytes);
  }

  function decodeBase64(data) {
    if (typeof data !== "string" || data.length % 4 !== 0) return null;
    const bytes = [];
    for (let i = 0; i < data.length; i += 4) {
      const a = alphabet.indexOf(data[i]);
      const b = alphabet.indexOf(data[i + 1]);
      const c = data[i + 2] === "=" ? 0 : alphabet.indexOf(data[i + 2]);
      const d = data[i + 3] === "=" ? 0 : alphabet.indexOf(data[i + 3]);
      if (a < 0 || b < 0 || c < 0 || d < 0) return null;
      bytes.push((a << 2) | (b >> 4));
      if (data[i + 2] !== "=") bytes.push(((b & 15) << 4) | (c >> 2));
      if (data[i + 3] !== "=") bytes.push(((c & 3) << 6) | d);
    }
    return bytes;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function clampInt(value, min, max, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function normalizeConfig(input) {
    const source = input || {};
    const boot = ["manual", "timed", "smart"].includes(source.bootMode)
      ? source.bootMode
      : defaults.bootMode;
    return {
      motorRpm: clampInt(source.motorRpm, 0, 1500, defaults.motorRpm),
      feedRpm: clampInt(source.feedRpm, 0, 150, defaults.feedRpm),
      grindSize: clampInt(source.grindSize, 0, 1500, defaults.grindSize),
      bootMode: boot,
    };
  }

  let config = normalizeConfig(defaults);
  let settingsFingerprint = JSON.stringify(config);
  let configTouched = false;

  function persistConfig() {
    try {
      host.storage({
        type: "write",
        key: storageKey,
        namespace: namespace,
        data: JSON.stringify({ fingerprint: settingsFingerprint, config }),
      });
    } catch (error) {
      // Storage is a convenience; a missing permission must not stop a grind.
    }
  }

  function renderUi() {
    return [
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>CRYSTAL Grinder</title><style>',
      ':root{--bg:#0b0b0d;--card:#16161a;--line:#28282f;--fg:#ececf1;--muted:#8b8b96;--accent:#a78bfa}',
      '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);',
      'font:14px/1.5 ui-sans-serif,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
      'header{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}',
      'h1{font-size:16px;margin:0;font-weight:600}',
      '.dot{width:8px;height:8px;border-radius:50%;background:#ef4444}.dot.on{background:var(--accent)}',
      '#conn{color:var(--muted);font-size:12px}',
      '#back[hidden]{display:none}body.embedded header{padding-right:64px}',
      '.app{min-height:100%}',
      'html.fitted,body.fitted{background:transparent}',
      'body.fitted .app{width:720px;max-width:100%;background:var(--bg);border:1px solid var(--line);',
      'border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.45)}',
      'body.compact #readout,body.compact #live-card,body.compact #logs-card{display:none}',
      'body.expanded .app{width:100%;max-width:100%;min-height:100%;border:0;border-radius:0;box-shadow:none}',
      'button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;',
      'padding:6px 10px;font:inherit;cursor:pointer}button:hover{border-color:#3f3f4a}',
      'main{padding:16px 20px;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start}',
      '.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}',
      'h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}',
      '.readout{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:28px;align-items:baseline}',
      '.big{font-size:52px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.big small{font-size:16px;color:var(--muted);margin-left:6px;font-weight:400}',
      '.sub{color:var(--muted)}.sub b{color:var(--fg);font-weight:600}',
      'table{width:100%;border-collapse:collapse}td{padding:5px 0;vertical-align:middle;font-size:13px}',
      'td:first-child{color:var(--muted)}td:last-child{text-align:right;font-weight:500;font-variant-numeric:tabular-nums}',
      'code{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}',
      '.row{display:grid;grid-template-columns:104px 1fr 62px 46px;gap:8px;align-items:center;padding:6px 0}',
      '.row label{color:var(--muted);font-size:13px}',
      '.row input[type=number]{background:#0f0f12;border:1px solid var(--line);color:var(--fg);',
      'border-radius:6px;padding:3px 6px;font:inherit;width:100%;text-align:right}',
      'input[type=range]{width:100%;accent-color:var(--accent)}',
      '.chips{display:flex;flex-wrap:wrap;gap:8px}',
      '.chip{padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:#1d1d22;',
      'cursor:pointer;font-size:13px}.chip:hover{border-color:#3f3f4a}.chip.on{border-color:var(--accent);color:var(--accent)}',
      '.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
      '.primary{border-color:var(--accent);color:var(--accent)}.danger{border-color:#f87171;color:#f87171}',
      '#logs{max-height:300px;overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.log{display:flex;gap:8px;padding:2px 0;border-bottom:1px solid #1e1e23}',
      '.log i{font-style:normal;flex:0 0 46px;color:var(--muted)}',
      '.log.read i{color:#60a5fa}.log.write i{color:#fbbf24}.log.notify i{color:#6b7280}.log.error i{color:#f87171}',
      '.log span{word-break:break-all;color:#c9c9d1}',
      '.note{color:var(--muted);font-size:12px;margin-top:8px}',
      '</style></head><body>',
      '<div class="app">',
      '<header><button id="back" hidden>Back</button>',
      '<h1>CRYSTAL Grinder</h1><span class="dot" id="dot"></span>',
      '<span id="conn">--</span><span style="flex:1"></span>',
      '<button id="refresh">Refresh</button>',
      '<button id="expand" hidden>Full</button><button id="lang">English</button></header>',
      '<main>',
      '<section class="card readout" id="readout">',
      '<div><div class="big"><span id="servoAngle">--</span><small id="servoUnit">current</small></div>',
      '<div class="sub" id="stateLine">--</div></div>',
      '<div class="sub" id="targetLine"></div>',
      '<div class="sub" id="rpmLine"></div>',
      '</section>',
      '<section class="card" id="live-card"><h2 id="h-live">Characteristics</h2><table id="table"></table></section>',
      '<section class="card" id="config-card"><h2 id="h-config">Config</h2><div id="sliders"></div>',
      '<h2 id="h-boot" style="margin-top:14px">Start mode</h2><div class="chips" id="boot"></div>',
      '<div class="actions"><button class="primary" id="apply">Apply grind</button>',
      '<button class="primary" id="start">Start</button>',
      '<button class="danger" id="stop">Stop</button></div>',
      '<div class="note" id="note"></div></section>',
      '<section class="card" id="logs-card"><h2>Logs</h2><div id="logs"></div></section>',
      '</main></div><script>',
      'var ENDPOINT=location.pathname;',
      'var PARAMS=new URLSearchParams(location.search);',
      'var EMBEDDED=PARAMS.get("embed")==="1";',
      'var VIEW=PARAMS.get("view")||"main";',
      'var COMPACT=EMBEDDED&&VIEW==="settings";',
      'if(COMPACT){document.documentElement.classList.add("fitted");',
      'document.body.classList.add("compact","fitted");}',
      'var RETURN_TO="";',
      'if(!EMBEDDED){try{var r=new URL(PARAMS.get("returnTo")||"");',
      'if(/^https?:$/.test(r.protocol)&&!r.username&&!r.password)RETURN_TO=r.href}catch(e){}}',
      'var FROM_SKIN=EMBEDDED||!!RETURN_TO;',
      'var LANG="zh";',
      'var T={zh:{back:"\\u8fd4\\u56de",full:"\\u5168\\u5c4f",compact:"\\u7d27\\u51d1",live:"\\u7279\\u5f81\\u503c\\u5b9e\\u65f6\\u603b\\u89c8",',
      'config:"\\u914d\\u7f6e (\\u4fdd\\u5b58\\u5728\\u63d2\\u4ef6)",boot:"\\u542f\\u52a8\\u65b9\\u5f0f",refresh:"\\u5237\\u65b0",',
      'connected:"\\u5df2\\u8fde\\u63a5",offline:"\\u672a\\u8fde\\u63a5",',
      'apply:"\\u5e94\\u7528\\u7814\\u78e8\\u5ea6",start:"\\u5f00\\u59cb\\u7814\\u78e8",stop:"\\u505c\\u6b62",',
      'current:"\\u5f53\\u524d\\u7814\\u78e8\\u5ea6",target:"\\u76ee\\u6807\\u7814\\u78e8\\u5ea6",',
      'note:"\\u914d\\u7f6e\\u53ea\\u4fdd\\u5b58\\u5728\\u63d2\\u4ef6\\u91cc\\uff0c\\u5f00\\u59cb\\u7814\\u78e8\\u65f6\\u624d\\u4e0b\\u53d1\\u3002\\u5e94\\u7528\\u7814\\u78e8\\u5ea6\\u4f1a\\u5148\\u5199\\u76ee\\u6807\\u5e76\\u7b49 SYS_STATE \\u56de\\u5230 0\\uff1b\\u542f\\u52a8\\u524d\\u8fd8\\u4f1a\\u7b49\\u8db3 1500ms\\u3002",',
      'idle:"\\u7a7a\\u95f2",grinding:"\\u7814\\u78e8\\u4e2d",unknown:"\\u672a\\u77e5",error:"\\u9519\\u8bef",',
      'manual:"\\u624b\\u52a8",timed:"\\u5b9a\\u65f6",smart:"\\u667a\\u80fd"},',
      'en:{back:"Back",full:"Full",compact:"Compact",live:"Characteristics",config:"Config (saved in plugin)",boot:"Start mode",refresh:"Refresh",',
      'connected:"Connected",offline:"Not connected",apply:"Apply grind",start:"Start",stop:"Stop",',
      'current:"current",target:"target",',
      'note:"Config is stored in the plugin and sent when grinding starts. Apply writes the target and waits for SYS_STATE to fall to 0; Start also waits 1500 ms before the motor.",',
      'idle:"Idle",grinding:"Grinding",unknown:"Unknown",error:"Error",manual:"Manual",timed:"Timed",smart:"Smart"}};',
      'var LABELS={motorRpm:["Motor RPM","\\u7535\\u673a\\u8f6c\\u901f"],feedRpm:["Feed RPM","\\u4e0b\\u8c46\\u8f6c\\u901f"],',
      'bootSign:["Boot sign","\\u542f\\u52a8\\u9879"],sysState:["SYS_STATE","\\u7cfb\\u7edf\\u72b6\\u6001"],',
      'servoAngle:["Servo angle","\\u5f53\\u524d\\u7814\\u78e8\\u5ea6"],targetAngle:["Target angle","\\u76ee\\u6807\\u7814\\u78e8\\u5ea6"],',
      'grindSize:["Grind size","\\u7814\\u78e8\\u5ea6"]};',
      'var ORDER=["motorRpm","feedRpm","bootSign","sysState","servoAngle","targetAngle"];',
      'var RANGES={motorRpm:[0,1500,10],feedRpm:[0,150,1],grindSize:[0,1500,1]};',
      'var LIMITS={motorRpm:[0,1500],feedRpm:[0,150],bootSign:[0,10],sysState:[0,1],servoAngle:[0,1500],targetAngle:[0,1500]};',
      'var BOOT_MODES=["manual","timed","smart"];',
      'var UUID={motorRpm:"\\u202601",feedRpm:"\\u202602",bootSign:"\\u202603",sysState:"\\u202604",',
      'servoAngle:"\\u202605",targetAngle:"\\u202606"};',
      'var PROPS={motorRpm:"R/W/N",feedRpm:"R/W/N",bootSign:"R/W/N",sysState:"R/N",servoAngle:"R/N",targetAngle:"R/W/N"};',
      'var cached={values:{},config:{},state:"idle",logs:[]};var built=false;var deb={};',
      'function t(k){return T[LANG][k]}',
      'function label(k){var e=LABELS[k];return e?(LANG==="zh"?e[1]:e[0]):k}',
      'function stateLabel(v){var e=T[LANG][v];return e||v}',
      'function bootLabel(v){var e=T[LANG][v];return e||v}',
      'function post(commandId,params){return fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},',
      'body:JSON.stringify({commandId:commandId,params:params||{}})}).then(function(r){return r.json()}).then(function(r){',
      'if(!r.ok)throw new Error(r.error);return r.result})}',
      'function buildControls(){var host=document.getElementById("sliders");',
      'Object.keys(RANGES).forEach(function(key){var r=RANGES[key];',
      'var row=document.createElement("div");row.className="row";row.dataset.key=key;',
      'row.innerHTML=\'<label></label><input type="range"><input type="number"><span></span>\';',
      'var labelEl=row.querySelector("label"),range=row.querySelector("input[type=range]"),',
      'num=row.querySelector("input[type=number]"),unit=row.querySelector("span");',
      'labelEl.textContent=label(key);range.min=r[0];range.max=r[1];range.step=r[2];num.step=r[2];',
      'unit.textContent="";',
      'function send(v){var p={};p[key]=Number(v);clearTimeout(deb[key]);deb[key]=setTimeout(function(){',
      'post("setConfig",p).catch(function(e){console.warn(e)})},250)}',
      'range.addEventListener("input",function(){num.value=range.value;send(range.value)});',
      'num.addEventListener("change",function(){range.value=num.value;send(num.value)});',
      'host.appendChild(row)});',
      'var boot=document.getElementById("boot");',
      'BOOT_MODES.forEach(function(mode){var b=document.createElement("button");b.className="chip";',
      'b.dataset.mode=mode;b.textContent=bootLabel(mode);',
      'b.addEventListener("click",function(){post("setConfig",{bootMode:mode}).catch(function(e){console.warn(e)})});',
      'boot.appendChild(b)});',
      'document.getElementById("apply").addEventListener("click",function(){',
      'var row=document.querySelector(\'.row[data-key="grindSize"]\');',
      'post("setAndApply",{value:Number(row.querySelector("input[type=number]").value)}).catch(function(e){console.warn(e)})});',
      'document.getElementById("start").addEventListener("click",function(){',
      'post("start",{}).catch(function(e){console.warn(e)})});',
      'document.getElementById("stop").addEventListener("click",function(){',
      'post("stop",{}).catch(function(e){console.warn(e)})});',
      'document.getElementById("refresh").addEventListener("click",function(){post("readAll",{}).catch(function(){})});',
      'built=true}',
      'function paintTable(v){var rows=ORDER.map(function(k){var val=v[k];var r=LIMITS[k]||[0,1];',
      'var text=val===null||val===undefined?"\\u2014":(k==="sysState"?(val+" "+stateLabel(val===1?"grinding":"idle")):val);',
      'return "<tr><td>"+label(k)+" <code>"+UUID[k]+"</code> "+PROPS[k]+" <code>["+r[0]+"\\u2013"+r[1]+"]</code></td><td>"+text+"</td></tr>"});',
      'document.getElementById("table").innerHTML=rows.join("")}',
      'function paintControls(c){if(!built)return;',
      'Object.keys(RANGES).forEach(function(key){var row=document.querySelector(\'.row[data-key="\'+key+\'"]\');',
      'if(!row)return;var val=c[key];if(val===null||val===undefined)return;',
      'if(document.activeElement!==row.querySelector("input[type=range]")&&',
      'document.activeElement!==row.querySelector("input[type=number]")){',
      'row.querySelector("input[type=range]").value=val;row.querySelector("input[type=number]").value=val}});',
      'document.querySelectorAll("#boot .chip").forEach(function(b){',
      'b.className="chip"+(b.dataset.mode===c.bootMode?" on":"")})}',
      'function paintLogs(logs){document.getElementById("logs").innerHTML=logs.slice().reverse().map(function(l){',
      'return \'<div class="log \'+l.kind+\'"><i>\'+l.kind+\'</i><span>\'+String(l.text).replace(/[<>&]/g,"")+"</span></div>"}).join("")}',
      'function apply(d){if(!d)return;cached=d;var v=d.values||{};var c=d.config||{};var s=d.state||"idle";',
      'document.getElementById("dot").className="dot"+(d.connected?" on":"");',
      'document.getElementById("conn").textContent=d.connected?t("connected"):t("offline");',
      'document.getElementById("servoAngle").textContent=(v.servoAngle===null||v.servoAngle===undefined)?"--":v.servoAngle;',
      'document.getElementById("servoUnit").textContent=t("current");',
      'document.getElementById("stateLine").textContent=stateLabel(s);',
      'document.getElementById("targetLine").textContent=t("target")+" "+(c.grindSize===undefined?"\\u2014":c.grindSize);',
      'document.getElementById("rpmLine").innerHTML=\'<b>\'+(v.motorRpm===null||v.motorRpm===undefined?"\\u2014":v.motorRpm)+\'</b> motor &middot; <b>\'+',
      '(v.feedRpm===null||v.feedRpm===undefined?"\\u2014":v.feedRpm)+\'</b> feed\';',
      'paintTable(v);paintControls(c);paintLogs(d.logs||[])}',
      'function labels(){document.getElementById("back").textContent=t("back");',
      'document.getElementById("h-live").textContent=t("live");',
      'document.getElementById("h-config").textContent=t("config");document.getElementById("h-boot").textContent=t("boot");',
      'document.getElementById("refresh").textContent=t("refresh");document.getElementById("apply").textContent=t("apply");',
      'document.getElementById("start").textContent=t("start");document.getElementById("stop").textContent=t("stop");',
      'document.getElementById("note").textContent=t("note");',
      'document.querySelectorAll(".row").forEach(function(r){r.querySelector("label").textContent=label(r.dataset.key)});',
      'document.querySelectorAll("#boot .chip").forEach(function(b){b.textContent=bootLabel(b.dataset.mode)});',
      'document.getElementById("expand").textContent=t(expanded?"compact":"full");',
      'document.getElementById("lang").textContent=LANG==="zh"?"English":"\\u4e2d\\u6587";postSize()}',
      'function tick(){fetch(ENDPOINT+"?state=1").then(function(r){return r.json()}).then(apply).catch(function(){})}',
      'function backToSkin(){',
      'if(RETURN_TO){var came=false;',
      'try{came=history.length>1&&new URL(document.referrer).origin===new URL(RETURN_TO).origin}catch(e){}',
      'if(!came){location.assign(RETURN_TO);return}',
      'var fallback=setTimeout(function(){location.assign(RETURN_TO)},1500);',
      'addEventListener("pagehide",function(){clearTimeout(fallback)},{once:true});',
      'history.back();return}',
      'if(EMBEDDED){try{window.parent.postMessage({type:"streamline:close"},"*")}catch(e){}return}',
      'history.back()}',
      'function postSize(maxWidth,maxHeight){if(!COMPACT)return;var app=document.querySelector(".app");if(!app)return;',
      'var r=app.getBoundingClientRect();var w=maxWidth||r.width;var h=maxHeight||r.height;',
      'if(w>0&&h>0){try{window.parent.postMessage({type:"streamline:size",width:Math.ceil(w),height:Math.ceil(h)},"*")}catch(e){}}}',
      'var expanded=false;',
      'function setExpanded(next){expanded=!!next;',
      'document.body.classList.toggle("expanded",expanded);',
      'document.body.classList.toggle("compact",!expanded);',
      'document.getElementById("expand").textContent=t(expanded?"compact":"full");',
      'postSize(expanded?1100:null,expanded?760:null);',
      'setTimeout(function(){postSize(expanded?1100:null,expanded?760:null)},60)}',
      'var backBtn=document.getElementById("back");backBtn.hidden=!FROM_SKIN;',
      'backBtn.addEventListener("click",backToSkin);',
      'var expandBtn=document.getElementById("expand");expandBtn.hidden=!COMPACT;',
      'expandBtn.addEventListener("click",function(){setExpanded(!expanded)});',
      'if(EMBEDDED){document.body.classList.add("embedded");',
      'try{window.parent.postMessage({type:"streamline:ready"},"*")}catch(e){}}',
      'document.getElementById("lang").addEventListener("click",function(){LANG=LANG==="zh"?"en":"zh";labels()});',
      'buildControls();labels();tick();setInterval(tick,700);',
      'if(COMPACT){postSize();setTimeout(postSize,60);setTimeout(postSize,300);',
      'if(window.ResizeObserver){try{new ResizeObserver(postSize).observe(document.querySelector(".app"))}catch(e){}}}',
      '</script></body></html>',
    ].join("");
  }

  // Decaid serves plugin pages with `X-Frame-Options: SAMEORIGIN`, but the
  // skin may run on another port (the tablet's is :25123). A CSP
  // frame-ancestors source lets that skin embed the page and takes precedence
  // over X-Frame-Options. Only an http(s) origin is echoed back.
  function frameOrigin(value) {
    if (typeof value !== "string") return "";
    const match = /^(https?:\/\/[^/?#\s@]+)/i.exec(value);
    return match ? match[1] : "";
  }

  let deviceHandler = null;

  return {
    id: "crystal.reaplugin",
    onLoad(settings) {
      config = normalizeConfig(settings);
      settingsFingerprint = JSON.stringify(config);
      try {
        host.storage({ type: "read", key: storageKey, namespace: namespace });
      } catch (error) {
        // Defaults are usable when storage is unavailable.
      }
      return host.devices.bindDriver("crystal", {
        create(device) {
          let context = null;
          const values = {};
          const logs = [];
          let sysState = null;
          let intent = null;
          let error = null;
          let positionKnown = false;
          let waiters = [];
          let reading = false;
          let skinKey = "";
          let skinTimer = null;
          let skinSentAt = 0;

          function log(kind, text) {
            logs.push({ kind, text, at: Date.now() });
            if (logs.length > 200) logs.splice(0, logs.length - 200);
          }

          function requireSession() {
            if (!context) throw new Error("CRYSTAL session is not connected");
            return context;
          }

          function currentState() {
            if (error) return "error";
            if (sysState === 1) {
              return intent === "apply" ? "unknown" : "grinding";
            }
            return "idle";
          }

          function settingValue() {
            if (!positionKnown) return null;
            if (values.servoAngle === undefined || values.servoAngle === null) {
              return null;
            }
            return String(values.servoAngle);
          }

          function snapshot() {
            const payload = { state: currentState() };
            const setting = settingValue();
            if (setting !== null) payload.setting = setting;
            payload.rpm = config.motorRpm;
            if (values.servoAngle !== undefined) {
              payload.observedSetting = String(values.servoAngle);
            }
            if (values.motorRpm !== undefined) {
              payload.observedRpm = values.motorRpm;
            }
            return payload;
          }

          function surfaceInfo() {
            if (!context) return null;
            return {
              state: currentState(),
              rpm: config.motorRpm,
              setting: settingValue(),
            };
          }

          function notifySkin() {
            const info = surfaceInfo();
            const key = info
              ? `on|${info.state}|${info.rpm}|${info.setting}`
              : "off";
            if (key === skinKey) return;
            skinKey = key;
            const wait = skinSentAt + skinPushIntervalMs - Date.now();
            if (wait <= 0) {
              if (skinTimer) {
                clearTimeout(skinTimer);
                skinTimer = null;
              }
              skinSentAt = Date.now();
              host.emit("changed", { what: "skin" });
              return;
            }
            if (skinTimer) return;
            skinTimer = setTimeout(() => {
              skinTimer = null;
              skinSentAt = Date.now();
              host.emit("changed", { what: "skin" });
            }, wait);
          }

          function publish() {
            if (!context || reading) return;
            Promise.resolve(context.publish(snapshot())).catch((failure) =>
              log(
                "error",
                "publish: " +
                  String(failure && failure.message ? failure.message : failure)
              )
            );
            notifySkin();
          }

          function updateConfig(patch) {
            const next = normalizeConfig({ ...config, ...(patch || {}) });
            const changed = JSON.stringify(next) !== JSON.stringify(config);
            config = next;
            if (changed) {
              configTouched = true;
              persistConfig();
              publish();
              notifySkin();
            }
            return { ...config };
          }

          function failWaiters(reason) {
            const pending = waiters;
            waiters = [];
            for (const waiter of pending) {
              clearTimeout(waiter.timer);
              waiter.reject(reason);
            }
          }

          function resolveWaiters(value) {
            const pending = waiters;
            waiters = [];
            for (const waiter of pending) {
              if (waiter.predicate(value)) {
                clearTimeout(waiter.timer);
                waiter.resolve(value);
              } else {
                waiters.push(waiter);
              }
            }
          }

          function setSysState(value) {
            sysState = value;
            if (value === 0) {
              if (intent === "apply" || intent === "stop") intent = null;
              else if (intent === "run" && config.bootMode === "manual") {
                intent = null;
              }
            }
            resolveWaiters(value);
            publish();
          }

          function waitForSysState(predicate, timeoutMs, label) {
            return new Promise((resolve, reject) => {
              if (sysState !== null && predicate(sysState)) {
                resolve(sysState);
                return;
              }
              const waiter = { predicate, resolve, reject, timer: null };
              waiter.timer = setTimeout(() => {
                waiters = waiters.filter((entry) => entry !== waiter);
                reject(new Error(`timed out waiting for ${label}`));
              }, timeoutMs);
              waiters.push(waiter);
            });
          }

          async function readChannel(key) {
            const session = requireSession();
            const raw = await session.gatt.read(service, channels[key]);
            const bytes = decodeBase64(raw);
            if (!bytes || bytes.length === 0) return null;
            const value =
              key === "sysState"
                ? decodeState(bytes)
                : bytes.length >= 2
                  ? decodeUint16(bytes)
                  : bytes[0];
            values[key] = value;
            if (key === "servoAngle" && value > 0) positionKnown = true;
            if (key === "sysState") setSysState(value);
            log(
              "read",
              `${key} = ${value} (${bytes.slice(0, 2).join(" ")})`
            );
            return value;
          }

          async function writeChannel(key, value) {
            const session = requireSession();
            const bytes = encodeUint16(value);
            await session.gatt.writeWithResponse(
              service,
              channels[key],
              btoa(String.fromCharCode(...bytes))
            );
            values[key] = Math.round(value);
            log(
              "write",
              `${key} = ${bytes[0]} ${bytes[1]} (${Math.round(value)})`
            );
            return Math.round(value);
          }

          async function writeAndVerify(key, value) {
            const expected = Math.round(value);
            await writeChannel(key, expected);
            let actual = await readChannel(key);
            if (actual === expected) return;
            await writeChannel(key, expected);
            actual = await readChannel(key);
            if (actual !== expected) {
              throw new Error(
                `${key} read back ${actual}, expected ${expected}`
              );
            }
          }

          async function readAll() {
            reading = true;
            try {
              for (const key of order) {
                try {
                  await readChannel(key);
                } catch (failure) {
                  log("error", `${key} read failed: ${failure}`);
                }
              }
            } finally {
              reading = false;
            }
            publish();
            return { ...values };
          }

          async function ensureIdle() {
            const current = await readChannel("sysState");
            if (current === 1) {
              throw new Error("CRYSTAL is busy; stop it or wait");
            }
            if (current !== 0) {
              throw new Error(`unexpected SYS_STATE ${current}`);
            }
          }

          async function adjustmentCycle() {
            intent = "apply";
            await writeChannel("bootSign", applyCommand);
            try {
              await waitForSysState(
                (value) => value === 1,
                busyEnterTimeoutMs,
                "SYS_STATE busy"
              );
              await waitForSysState(
                (value) => value === 0,
                busyExitTimeoutMs,
                "SYS_STATE idle"
              );
            } catch (failure) {
              const current = await readChannel("sysState");
              if (current === 1) {
                await waitForSysState(
                  (value) => value === 0,
                  busyExitTimeoutMs,
                  "SYS_STATE idle"
                );
              } else if (current !== 0) {
                intent = null;
                error = String(
                  failure && failure.message ? failure.message : failure
                );
                publish();
                throw failure;
              } else {
                // Already at the target: some firmware does not raise the
                // busy signal when there is nothing to move.
                log("error", "no busy transition; assuming already in position");
              }
            }
            intent = null;
            const servo = await readChannel("servoAngle");
            if (servo !== null) positionKnown = true;
            publish();
          }

          async function applyTarget(target) {
            await ensureIdle();
            const value = clampInt(target, 0, 1500, config.grindSize);
            await writeAndVerify("targetAngle", value);
            await adjustmentCycle();
            return values.servoAngle;
          }

          async function start() {
            error = null;
            await ensureIdle();
            const motor = clampInt(config.motorRpm, 0, 1500, 850);
            const feed = clampInt(config.feedRpm, 0, 150, 20);
            const target = clampInt(config.grindSize, 0, 1500, 500);
            await writeChannel("motorRpm", motor);
            await writeChannel("feedRpm", feed);
            await writeAndVerify("targetAngle", target);
            await adjustmentCycle();
            await delay(settleDelayMs);
            intent = "run";
            const boot = bootModeValues[config.bootMode] || 1;
            try {
              await writeChannel("bootSign", boot);
            } catch (failure) {
              intent = null;
              throw failure;
            }
            if (config.bootMode === "manual") {
              await waitForSysState(
                (value) => value === 1,
                busyEnterTimeoutMs,
                "grinder start"
              );
            }
            publish();
            return { ...values };
          }

          async function stop() {
            error = null;
            intent = "stop";
            await writeChannel("bootSign", stopCommand);
            try {
              await waitForSysState(
                (value) => value === 0,
                stopTimeoutMs,
                "grinder stop"
              );
            } catch (failure) {
              error = String(
                failure && failure.message ? failure.message : failure
              );
              intent = null;
              publish();
              throw failure;
            }
            intent = null;
            publish();
            return { ...values };
          }

          async function setGrindSetting(setting) {
            const target = clampInt(setting, 0, 1500, config.grindSize);
            updateConfig({ grindSize: target });
            await applyTarget(target);
            return { ...values };
          }

          async function setRpm(rpm) {
            const value = clampInt(rpm, 0, 1500, config.motorRpm);
            updateConfig({ motorRpm: value });
            if (context && sysState === 1 && intent !== "apply") {
              await writeChannel("motorRpm", value);
            }
            publish();
            return { ...values };
          }

          async function execute({ commandId, params }) {
            const input = params || {};
            switch (commandId) {
              case "getValues":
                return { ...values };
              case "getConfig":
                return { ...config };
              case "readAll":
                return readAll();
              case "setConfig":
                return updateConfig(input);
              case "setAndApply": {
                const target = clampInt(
                  input.value === undefined ? config.grindSize : input.value,
                  0,
                  1500,
                  config.grindSize
                );
                updateConfig({ grindSize: target });
                await applyTarget(target);
                return { ...values };
              }
              case "start":
                return start();
              case "stop":
                return stop();
              case "writeMotorRpm":
                await writeChannel("motorRpm", input.value);
                updateConfig({ motorRpm: input.value });
                return { ...values };
              case "writeFeedRpm":
                await writeChannel("feedRpm", input.value);
                updateConfig({ feedRpm: input.value });
                return { ...values };
              case "writeBootSign":
                await writeChannel("bootSign", input.value);
                return { ...values };
              case "writeTargetAngle":
                await writeChannel("targetAngle", input.value);
                return { ...values };
              default:
                throw new Error(`Unknown CRYSTAL command: ${commandId}`);
            }
          }

          async function handlePost(body) {
            try {
              const result = await execute({
                commandId: body.commandId,
                params: body.params || {},
              });
              return { ok: true, result };
            } catch (failure) {
              return {
                ok: false,
                error: String(
                  failure && failure.message ? failure.message : failure
                ),
              };
            }
          }

          function uiState() {
            return {
              connected: context !== null,
              values: { ...values },
              config: { ...config },
              state: currentState(),
              setting: settingValue(),
              logs: logs.slice(-120),
            };
          }

          deviceHandler = {
            state: uiState,
            post: handlePost,
            surface: surfaceInfo,
            setRpm,
            configChanged() {
              publish();
              notifySkin();
            },
          };

          return {
            vendor: "CRYSTAL",
            async connect(session) {
              log("read", "connect start");
              try {
                const services = await session.gatt.discoverServices();
                log("read", `services: ${services.join(", ")}`);
                if (!services.includes(service)) {
                  throw new Error("CRYSTAL service unavailable");
                }
                context = session;
                error = null;
                intent = null;
                sysState = null;
                positionKnown = false;
                for (const key of order) delete values[key];
                session.gatt.onDisconnect(() => {
                  context = null;
                  sysState = null;
                  intent = null;
                  positionKnown = false;
                  failWaiters(new Error("CRYSTAL disconnected"));
                  log("error", "disconnected");
                });
                for (const key of subscribeOrder) {
                  await session.gatt.subscribe(
                    service,
                    channels[key],
                    (data) => {
                      const bytes = decodeBase64(data);
                      if (!bytes || bytes.length === 0) return;
                      const value =
                        key === "sysState"
                          ? decodeState(bytes)
                          : bytes.length >= 2
                            ? decodeUint16(bytes)
                            : bytes[0];
                      values[key] = value;
                      log(
                        "notify",
                        `${key} = ${value} (${bytes.slice(0, 2).join(" ")})`
                      );
                      if (key === "sysState") {
                        setSysState(value);
                      } else {
                        if (key === "servoAngle" && value > 0) {
                          positionKnown = true;
                        }
                        publish();
                      }
                    }
                  );
                  log("read", `subscribed ${key}`);
                }
                await readAll();
                log("read", "connect complete");
              } catch (failure) {
                log(
                  "error",
                  "connect failed: " +
                    String(
                      failure && failure.message ? failure.message : failure
                    )
                );
                throw failure;
              }
            },
            disconnect() {
              context = null;
              sysState = null;
              intent = null;
              positionKnown = false;
              failWaiters(new Error("CRYSTAL disconnected"));
            },
            start,
            stop,
            setGrindSetting,
            setRpm,
          };
        },
      });
    },
    onEvent(event) {
      if (!event || event.name !== "storageRead") return;
      const payload = event.payload || {};
      if (payload.key !== storageKey) return;
      let saved = null;
      try {
        saved = JSON.parse(payload.value);
      } catch (failure) {
        saved = null;
      }
      if (!configTouched && saved && saved.fingerprint === settingsFingerprint) {
        config = normalizeConfig(saved.config);
      } else if (!configTouched) {
        persistConfig();
      }
      if (deviceHandler && deviceHandler.configChanged) {
        deviceHandler.configChanged();
      }
    },
    handleHttpRequest(request) {
      const json = (value, status) => ({
        status: status === undefined ? 200 : status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (request.endpoint === "skin") {
        if (request.method !== "GET") {
          return json({ ok: false, error: "method not allowed" }, 405);
        }
        const surfaces = [];
        const info = deviceHandler ? deviceHandler.surface() : null;
        if (info) {
          const pageAction = {
            type: "open",
            view: "settings",
            presentation: "overlay",
            fit: true,
          };
          surfaces.push(
            {
              id: "crystal-page",
              kind: "header-button",
              label: "XTAL",
              action: pageAction,
            },
            {
              id: "crystal-saver",
              kind: "screensaver-button",
              label: "XTAL",
              action: pageAction,
            }
          );
          surfaces.push({
            id: "crystal-state",
            kind: "tile-line",
            tile: "grind",
            text:
              info.state === "error"
                ? "XTAL · warning"
                : `XTAL · ${info.rpm} rpm`,
            active: info.state === "grinding",
            action: {
              type: "call",
              endpoint: "rpm",
              field: "rpm",
              input: {
                title: "RPM",
                unit: "rpm",
                min: 0,
                max: 1500,
                decimals: 0,
                value: info.rpm,
              },
            },
          });
          surfaces.push({
            id: "crystal-step",
            kind: "tile-hint",
            tile: "grind",
            action: {
              type: "stepsize",
              field: "grinderSetting",
              sizes: [10, 1],
            },
          });
          if (info.setting !== null && info.setting !== undefined) {
            surfaces.push({
              id: "crystal-sync",
              kind: "tile-sync",
              tile: "grind",
              value: Number(info.setting),
              label: "XTAL",
            });
          }
        }
        return json({ version: 1, surfaces, live: { endpoint: "changed" } });
      }
      if (request.endpoint === "rpm") {
        if (request.method !== "POST") {
          return json({ ok: false, error: "method not allowed" }, 405);
        }
        if (!deviceHandler) {
          return json({ ok: false, error: "no CRYSTAL device bound" }, 409);
        }
        const rpm = Math.round(Number((request.body || {}).rpm));
        if (!Number.isFinite(rpm) || rpm < 0 || rpm > 1500) {
          return json({ ok: false, error: "rpm out of range" }, 400);
        }
        return Promise.resolve(deviceHandler.setRpm(rpm)).then(
          () => json({ ok: true, rpm }),
          (failure) =>
            json(
              {
                ok: false,
                error: String(
                  failure && failure.message ? failure.message : failure
                ),
              },
              502
            )
        );
      }
      if (request.method === "GET") {
        if (request.query && request.query.state === "1") {
          return json(
            deviceHandler
              ? deviceHandler.state()
              : {
                  connected: false,
                  values: {},
                  config: { ...config },
                  state: "idle",
                  setting: null,
                  logs: [],
                }
          );
        }
        const requestHeaders = request.headers || {};
        const ancestor =
          frameOrigin(requestHeaders.origin || requestHeaders.Origin) ||
          frameOrigin(requestHeaders.referer || requestHeaders.Referer);
        const pageHeaders = { "Content-Type": "text/html; charset=utf-8" };
        pageHeaders["Content-Security-Policy"] =
          "frame-ancestors 'self'" + (ancestor ? " " + ancestor : "");
        return {
          status: 200,
          headers: pageHeaders,
          body: renderUi(),
        };
      }
      if (request.method === "POST") {
        if (!deviceHandler) {
          return json({ ok: false, error: "no CRYSTAL device bound" });
        }
        return Promise.resolve(deviceHandler.post(request.body || {})).then(
          json
        );
      }
      return json({ ok: false, error: "method not allowed" }, 405);
    },
  };
}
