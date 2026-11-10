// Browser manager — editable JavaScript served locally by Bun.
const $ = id => document.getElementById(id);
let state = null, token = null, configName = null;
const modules = ['MariaDB', 'PHP', 'phpMyAdmin'];
const jobs = new Map();
const selectedVersions = new Map();
const switching = new Set();
const actionNotices = new Map();
const esc = s => String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let messageNonce = 0;
async function request(url, method='GET', payload=null) {
    const headers = { 'X-SQL-Port-Token': token || '' };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { method, headers, body: payload === null ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(payload), cache:'no-store' });
    const body = await r.json();
    if (!r.ok) throw Error(body.error || `HTTP ${r.status}`);
    return body;
}
function statusContent(element,text,phase) {
    const indicator=document.createElement('span');indicator.className='status-mark '+phase;
    indicator.setAttribute('aria-hidden','true');
    indicator.textContent=phase==='error'?'×':'';
    if(phase==='done')indicator.innerHTML='<svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="12" r="9.5"/><path d="m8 12.5 2.7 2.8 5.6-6"/></svg>';
    const label=document.createElement('span');label.textContent=text;
    element.replaceChildren(indicator,label);
}
function message(text,error=false,busy=false) {
    const element=$('message');
    const nonce=++messageNonce;
    element.classList.remove('fading');
    element.classList.toggle('is-error',error);
    if(!text){element.replaceChildren();return;}
    statusContent(element,text,busy?'busy':error?'error':'done');
    if(busy)return;
    setTimeout(()=>{if(messageNonce===nonce)element.classList.add('fading');},8000);
    setTimeout(()=>{if(messageNonce===nonce)element.replaceChildren();},10000);
}
const messageJob = (name, value) => { jobs.set(name,value); render(); };
function compareVersion(a,b) {
    const A=String(a||'0').split('.').map(Number),B=String(b||'0').split('.').map(Number);
    for(let i=0;i<Math.max(A.length,B.length);i++) if((A[i]||0)!==(B[i]||0)) return (A[i]||0)-(B[i]||0);
    return 0;
}
const newerVersion = (version,versions) => versions.filter(v=>v.version.startsWith(version.split('.').slice(0,2).join('.')+'.')&&compareVersion(v.version,version)>0)
    .sort((a,b)=>compareVersion(b.version,a.version))[0];
function showActionNotice(name,text,error=false) {
    const notice={text,error,fading:false};
    actionNotices.set(name,notice);
    render();
    setTimeout(()=>{
        if(actionNotices.get(name)!==notice)return;
        notice.fading=true;
        const panel=[...document.querySelectorAll('.panel')].find(el=>el.dataset.module===name);
        panel?.querySelector('.check-notice')?.classList.add('fading');
    },8000);
    setTimeout(()=>{
        if(actionNotices.get(name)!==notice)return;
        actionNotices.delete(name);
        render();
    },10000);
}
function checkSummary(name) {
    const check=state?.updates?.[name]||{};
    if(check.error)return `Version check failed: ${check.error}`;
    const installed=check.installed_versions||[];
    const updates=installed.map(version=>({version,newer:newerVersion(version,check.versions||[])})).filter(item=>item.newer);
    if(updates.length)return 'Updates available: '+updates.map(item=>`${item.version} → ${item.newer.version}`).join('; ');
    return installed.length?'All installed versions are up to date.':'No installed versions to update.';
}
function confirmAction(title,detail,action='Continue',danger=false) {
    return new Promise(resolve=>{
        const dialog=$('confirm_dialog');
        const accept=$('confirm_accept');
        $('confirm_title').textContent=title;
        $('confirm_text').textContent=detail;
        dialog.classList.toggle('destructive',danger);
        accept.textContent=action;
        accept.className='btn '+(danger?'danger':'primary');
        let settled=false;
        const finish=confirmed=>{
            if(settled)return;
            settled=true;
            dialog.close();
            resolve(confirmed);
        };
        accept.onclick=()=>finish(true);
        $('confirm_cancel').onclick=()=>finish(false);
        dialog.oncancel=event=>{event.preventDefault();finish(false);};
        dialog.onclose=()=>finish(false);
        dialog.showModal();
    });
}
async function refresh() {
    try {
        state = await request('/api/status');
        $('server_status').textContent = 'Manager Online'; $('server_status').classList.remove('off');
        if (state.first_run?.state === 'running') message(`Linux first-run setup: downloading ${state.first_run.module || 'services'}…`,false,true);
        if (state.first_run?.state === 'error' && !refresh.firstRunNotified) {
            refresh.firstRunNotified = true;
            message('Linux setup needs attention: '+state.first_run.error,true);
        }
        if (state.first_run?.state === 'done' && !refresh.firstRunNotified) {
            refresh.firstRunNotified = true;
            message('Linux runtime setup complete. Services are ready.');
        }
        if (!document.activeElement?.classList?.contains('version-select')) render();
    } catch(e) {
        $('server_status').textContent = 'Disconnected'; $('server_status').classList.add('off');
        message(e.message,true);
    }
}
function button(label, kind, action, disabled=false) {
    const b = document.createElement('button'); b.type='button'; b.className=`btn ${kind||''}`; b.textContent=label;
    b.disabled=disabled; b.addEventListener('click', action);return b;
}
function render() {
    if(!state)return;
    // Do not replace a native open selector while someone is choosing a version.
    if (document.activeElement?.classList?.contains('version-select')) return;
    const target=$('services');target.replaceChildren();
    for(const name of modules) {
        const svc=state.services.find(s=>s.name===name);
        const check=state.updates?.[name]||{};
        const job=jobs.get(name);
        const installed=check.installed_versions||svc?.installed_versions||[];
        const current=check.active||svc?.active_version||null;
        const preferred=check.default||svc?.default_version||null;
        const versions=check.versions||[];
        const panel=document.createElement('section');panel.className='panel';panel.dataset.module=name;
        const head=document.createElement('div');head.className='service-head';
        const strong=document.createElement('strong');strong.textContent=name;head.append(strong);
        const pill=document.createElement('span');pill.className='pill '+((name==='phpMyAdmin'?!!current:svc?.running)?'':'off');
        pill.textContent=name==='phpMyAdmin'?(current?'Installed':'Not installed'):(svc?.running?'Running':'Stopped');
        head.append(pill);panel.append(head);
        if(svc?.error&&current) {
            const error=document.createElement('p');error.className='error-text';error.textContent=svc.error;panel.append(error);
        }
        const controls=document.createElement('div');controls.className='buttons';
        if(svc) {
            controls.append(button('Start','',()=>serviceAction(name,'start'),svc.running||!current),
                button('Stop','',()=>serviceAction(name,'stop'),!svc.running),
                button('Restart','',()=>serviceAction(name,'restart'),!svc.running));
        }else {
            controls.append(button('Open phpMyAdmin ↗','outline',()=>window.open(state.startup_url.replace(/\/[^/]*$/,'/phpmyadmin/'),'_blank'),!current));
            controls.append(button('Reset Main Database','danger',openReset,
                !state.services.some(s=>s.name==='MariaDB'&&s.running)));
        }
        controls.append(button('Config','outline',()=>openConfig(name),name==='phpMyAdmin'&&!current));
        panel.append(controls);

        const latest=document.createElement('p');latest.className='latest-line';
        if(job?.busy&&job.action==='check')latest.textContent='Checking latest version…';
        else if(check.error){latest.textContent='Unable to check latest version: '+check.error;latest.classList.add('error-text');}
        else if(!check.available)latest.textContent='Checking latest version…';
        else if(check.unsupported_branch){
            latest.textContent=`Installed version: ${current} (branch no longer supported)`;
            latest.classList.add('error-text');
        }else latest.textContent=check.message || `Latest version: ${check.available}${check.is_lts?' LTS':''} (${installed.includes(check.available)?'Installed':'Not Installed'})`;
        panel.append(latest);

        const selectRow=document.createElement('div');selectRow.className='compact-row';
        const allVersions=[...new Set([...versions.map(v=>v.version),...installed])].sort((a,b)=>compareVersion(b,a));
        const selection=selectedVersions.get(name);
        const chosen=allVersions.includes(selection)?selection:
            installed.includes(preferred)?preferred:installed.includes(current)?current:allVersions[0];
        const selectedInstalled=installed.includes(chosen);
        const newer=selectedInstalled?newerVersion(chosen,versions):null;
        const targetVersion=newer?.version||chosen;
        const list=document.createElement('select');list.className='version-select';list.setAttribute('aria-label',name+' version');
        if(!allVersions.length){const opt=document.createElement('option');opt.textContent='Checking versions…';list.append(opt);list.disabled=true;}
        else {
            for(const version of allVersions){
                const item=versions.find(v=>v.version===version);
                const option=document.createElement('option');option.value=version;
                const channel=item?.channel?` · ${item.channel.replace('Long Term Support','LTS')}`:'';
                const installedLabel=installed.includes(version)?` · Installed${newerVersion(version,versions)?'*':''}`:'';
                option.textContent=`${version}${channel}${installedLabel}${version===preferred?' · Default':''}`;
                list.append(option);
            }
            list.value=chosen;
            list.disabled=!!job?.busy||switching.has(name);
            list.addEventListener('change',()=>{
                const version=list.value;
                selectedVersions.set(name,version);
                list.blur();
                if(installed.includes(version)&&(version!==current||version!==preferred))void chooseVersion(name,version);
                else render();
            });
        }
        selectRow.append(list);
        if(installed.length)selectRow.append(button('Remove','danger',()=>removeVersion(name,chosen),
            !!job?.busy||switching.has(name)||!selectedInstalled));
        selectRow.append(button('Version check','outline',()=>moduleAction(name,'check'),!!job?.busy));
        const installLabel=!selectedInstalled?'Install':newer?'Update':null;
        const installAction=()=>{
            if(newer&&installed.includes(targetVersion)){
                selectedVersions.set(name,targetVersion);
                void chooseVersion(name,targetVersion);
            }else void moduleAction(name,'install',targetVersion);
        };
        if(installLabel)selectRow.append(button(installLabel,'primary',installAction,
            !!job?.busy||switching.has(name)||!chosen));
        panel.append(selectRow);
        const checkNotice=actionNotices.get(name);
        if(checkNotice){
            const note=document.createElement('p');
            note.className=(checkNotice.error?'error-text':'muted small')+' check-notice'+(checkNotice.fading?' fading':'');
            statusContent(note,checkNotice.text,checkNotice.error?'error':'done');
            panel.append(note);
        }
        if(job?.text){const p=document.createElement('p');p.className=(job.error?'error-text':'muted small')+' job-status';
            statusContent(p,job.text,job.busy?'busy':job.error?'error':'done');panel.append(p);}
        target.append(panel);
    }
}
async function chooseVersion(name,version) {
    if (switching.has(name)) return;
    const previous=state.updates?.[name]?.active;
    if(name==='MariaDB'&&previous&&previous!==version &&
        !await confirmAction('Switch MariaDB version?',`Switch from ${previous} to ${version}?\n\nEach version has separate database files. Existing databases are not automatically migrated.`,'Switch version')) {
        selectedVersions.delete(name);await refresh();return;
    }
    switching.add(name);
    messageJob(name,{busy:true,action:'select',text:`Selecting ${name} ${version} as default…`});
    try {
        await request(`/api/versions/${encodeURIComponent(name)}/activate`,'POST',{version});
        await request(`/api/versions/${encodeURIComponent(name)}/default`,'POST',{version});
        messageJob(name,{busy:false,text:''});
        showActionNotice(name,`${name} ${version} is active and saved as default.`);
    } catch(e) {
        selectedVersions.delete(name);
        messageJob(name,{busy:false,error:true,text:''});
        showActionNotice(name,e.message,true);
    }
    finally {switching.delete(name);await refresh();}
}
async function removeVersion(name,version) {
    if(switching.has(name))return;
    const running=state?.services?.find(s=>s.name===name)?.running;
    const selected=state?.updates?.[name]?.active===version;
    const warning=`This permanently deletes that version's files, including any edits inside its folder.`+
        (name==='MariaDB'?'\nMariaDB database files are kept.':'')+
        (running&&selected?'\nThe running service will be stopped and will not restart automatically.':'');
    if(!await confirmAction(`Remove ${name} ${version}?`,warning,'Remove version',true))return;
    switching.add(name);
    message(`Removing ${name} ${version}…`,false,true);
    messageJob(name,{busy:true,action:'remove',text:`Removing ${name} ${version}…`});
    try {
        const result=await request(`/api/versions/${encodeURIComponent(name)}/remove`,'POST',{version});
        selectedVersions.delete(name);
        messageJob(name,{busy:false,text:''});
        showActionNotice(name,result.message);
        message(result.message);
    } catch(e) {
        const detail=/Invalid version action|HTTP 404|Not found/i.test(e.message)
            ? 'Remove is unavailable in the running backend. Fully quit SQL PORT and launch it again to load the updated server.js.'
            : e.message;
        messageJob(name,{busy:false,error:true,text:''});
        showActionNotice(name,detail,true);
        message(detail,true);
    }
    finally {switching.delete(name);await refresh();}
}
async function serviceAction(name,action) {
    message(`${action}: ${name}…`,false,true);
    try { await request(`/api/service/${encodeURIComponent(name)}/${action}`,'POST');await refresh();message(`${name}: ${action} completed.`); }
    catch(e) {message(e.message,true);await refresh();}
}
async function moduleAction(name,action,version=null) {
    if (jobs.get(name)?.busy) return;
    let confirm_downgrade = false;
    if (action === 'install') {
        if (!version) return message('Choose an available supported version first.',true);
        // Installation switches to the selected version. MariaDB versions use distinct datadirs.
        if (name==='MariaDB' && state?.services?.find(s=>s.name===name)?.running &&
            state.updates?.MariaDB?.active!==version &&
            !await confirmAction(`Install MariaDB ${version}?`,'This will stop the running MariaDB version and start the selected version. Each version has a separate database folder; databases are not migrated.','Install version')) return;
        const selectedPackage=state?.updates?.[name]?.versions?.find(v=>v.version===version);
        if (selectedPackage?.compatibility_warning &&
            !await confirmAction('Compatibility warning',selectedPackage.compatibility_warning+'\n\nOfficial phpMyAdmin 5.2.3 release notes mention PHP 8.4/8.5 fixes, but its compatibility feed has not been updated. Proceed and test on your machine?','Install anyway')) return;
    }
    messageJob(name,{busy:true,action,text:action==='check'?'Checking latest version…':`Installing ${name} ${version}…`});
    try {
        await request(`/api/update/${encodeURIComponent(name)}/${action}`,'POST',action==='install'?{version,confirm_downgrade}:{});
        for (let i=0;i<900;i++) {
            const result=await request(`/api/update/${encodeURIComponent(name)}/status`);
            if (['done','error'].includes(result.state)) {
                if(result.state==='done'&&action==='install')selectedVersions.set(name,result.result?.version||version);
                const failed=result.state==='error';
                const resultText=failed?(result.error||'Update failed'):(result.result?.message||'Completed');
                messageJob(name,{busy:false,error:failed,text:''});
                await refresh();
                showActionNotice(name,action==='check'&&!failed?checkSummary(name):resultText,failed||!!(action==='check'&&state?.updates?.[name]?.error));
                return;
            }
            await new Promise(resolve=>setTimeout(resolve,1000));
        }
        throw Error('Update is taking longer than expected. Check logs before restarting.');
    } catch(e) {
        messageJob(name,{busy:false,error:true,text:''});
        await refresh();
        showActionNotice(name,e.message,true);
    }
}
async function openConfig(name) {
    try {
        const data=await request('/api/config/'+encodeURIComponent(name));
        configName=name;$('config_title').textContent=name+' configuration';$('config_path').textContent=data.path;
        $('config_content').value=data.content;$('config_dialog').showModal();
    } catch(e) {message(e.message,true);}
}
$('config_save').onclick=async()=>{
    if (!configName) return;
    try { const result=await request('/api/config/'+encodeURIComponent(configName),'POST',{content:$('config_content').value});
        $('config_dialog').close();message(result.message); }
    catch(e) {message(e.message,true);}
};
$('open_main').onclick=()=>{if(state)window.open(state.startup_url,'_blank');};
$('restart_all').onclick=async()=>{message('Restarting services…',false,true);try {await request('/api/restart','POST');await refresh();message('Services restarted.');}catch(e){message(e.message,true);} };
$('stop_all').onclick=async()=>{message('Stopping services…',false,true);try {await request('/api/stop','POST');await refresh();message('Services stopped. Manager and tray remain active.');}catch(e){message(e.message,true);} };
$('quit_all').onclick=async()=>{if(!await confirmAction('Quit SQL PORT?','This will stop all managed services and shut down the manager.','Quit SQL PORT',true))return;
    message('Quitting SQL PORT…',false,true);
    try {await request('/api/quit','POST');document.body.innerHTML='<main class="shell"><h1>SQL PORT has shut down</h1><p>You may now close this browser tab.</p></main>';}
    catch(e){message(e.message,true);}
};
function openReset() {
    $('reset_password').value='';
    $('reset_confirmation').value='';
    $('reset_execute').disabled=true;
    $('reset_error').textContent='';
    $('reset_dialog').showModal();
}
$('reset_confirmation').oninput=()=>{
    $('reset_execute').disabled=$('reset_confirmation').value!=='RESET MAIN';
};
$('reset_execute').onclick=async()=>{
    if($('reset_confirmation').value!=='RESET MAIN')return;
    if(!await confirmAction('Final confirmation','Permanently delete all tables and data in the main database and reset the MariaDB root password to root?','Reset database',true))return;
    $('reset_execute').disabled=true;
    $('reset_error').textContent='';
    message('Resetting main database…',false,true);
    try {
        const result=await request('/api/database/reset','POST',{
            current_password:$('reset_password').value,confirmation:'RESET MAIN'
        });
        $('reset_dialog').close();
        await refresh();
        message(result.message+' Backup saved to '+result.backup);
    } catch(e) {
        $('reset_error').textContent=e.message;
        $('reset_execute').disabled=false;
        message(e.message,true);
    }
};
const themeKey='sql_port_theme';
const theme = localStorage.getItem(themeKey)==='light'?'light':'dark';
function setTheme(next) {
    document.documentElement.dataset.theme=next;
    localStorage.setItem(themeKey,next);
    const hint=next==='dark'?'Switch to light theme':'Switch to dark theme';
    $('theme_toggle').title=hint;
    $('theme_toggle').setAttribute('aria-label',hint);
}
setTheme(theme);
$('theme_toggle').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
(async()=>{try {token=(await request('/api/session')).token;}catch(e){message(e.message,true);}
    await refresh();
    if(token)request('/api/check-all','POST').catch(e=>message(e.message,true));
    setInterval(refresh,5000);
})();
