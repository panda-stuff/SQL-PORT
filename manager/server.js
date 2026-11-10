// SQL PORT manager — editable Bun backend, started by SQL PORT.bat or SQL PORT.sh.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { check, prepareInstall, install, installedVersion, configurePhpMyAdmin, ROOT } from './updater.js';
import { prepareDatabase, ensureRootPassword, completeFirstStart, ensurePhpMyAdminStorage, gracefulMariaStop, resetMainDatabase, mariaArgs } from './database.js';
import { initializeVersions, installedVersions, getActive, getDefault, activate, setDefault, unregisterInstalled, executablePath, modulePath } from './version-store.js';
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/services/services.json'), 'utf8'));
const updateConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/updates/updates.json'), 'utf8'));
const app = settings.application;
const host = '127.0.0.1';
const port = Number(app.manager_port);
const URL_ROOT = `http://${host}:${port}`;
const APP_URL = `http://${host}:${app.port}/${String(app.startup_file || 'index.php').replace(/^\/+/, '')}`;
const SECRET = process.env.SQL_PORT_TOKEN;
if (!SECRET || SECRET.length < 24) throw Error('SQL PORT must be started using its platform launcher');
if (app.host !== '127.0.0.1' || port === Number(app.port) || port < 1024 || port > 65535) throw Error('Invalid local ports');
await initializeVersions();
if (!['win32','linux'].includes(process.platform)) throw Error('SQL PORT supports Windows and Linux only');
const platform = process.platform === 'win32' ? 'windows' : 'linux';
const phpConfig = platform === 'windows' ? 'config/services/php.ini' : 'config/services/php-linux.ini';
const running = new Map();
const failures = new Map();
const updates = new Map();
const jobs = new Map();
let shuttingDown = false;
let operation = Promise.resolve();
let checking = false;
const firstRun = { state:'idle', module:null, error:null };
const queue = fn => {
    const next = operation.then(fn);
    operation = next.catch(err => console.error('Operation:', err));
    return next;
};
const expand = v => String(v).replaceAll('{app}', ROOT).replaceAll('{host}', host)
    .replaceAll('{port}', String(app.port)).replaceAll('{document_root}', path.resolve(ROOT, app.document_root));
const service = name => settings.services.find(s => s.name === name);
const active = name => {
    const proc = running.get(name);
    return !!proc && proc.exitCode === null;
};
function binary(name) {
    const selected=getActive(name);
    if (!selected) throw Error(`No ${name} version installed or selected`);
    const target=executablePath(name,selected);
    if (!fs.existsSync(target)) throw Error(`${name} ${selected} executable is missing`);
    return target;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function ping(portValue, timeout = 300) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port: portValue });
        socket.setTimeout(timeout);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        const failed = () => { socket.destroy(); resolve(false); };
        socket.once('error', failed);
        socket.once('timeout', failed);
    });
}
async function waitFor(name, portValue, proc, deadline = 18000) {
    for (let t = 0; t < deadline; t += 250) {
        if (proc.exitCode !== null) throw Error(`${name} exited during startup. Check logs/${name}.log`);
        if (await ping(portValue)) return;
        await wait(250);
    }
    throw Error(`${name} did not become ready. Check logs/${name}.log`);
}
async function start(name) {
    if (active(name)) return;
    const svc = service(name);
    if (!svc || !svc.enabled) throw Error(`Service ${name} isn't enabled`);
    failures.delete(name);
    const exe = binary(name);
    await fsp.mkdir(path.join(ROOT, 'logs'), { recursive: true });
    if (name === 'MariaDB') {
        if (await ping(3306)) throw Error('MariaDB port 3306 is already in use; refusing to claim another server');
        await prepareDatabase();
    }
    if (name === 'PHP' && await ping(Number(app.port))) throw Error(`Application port ${app.port} is already in use`);
    let args = [...(svc.arguments || []).map(expand)];
    if (name === 'MariaDB') args.push(...mariaArgs());
    if (name === 'PHP') {
        const sessionDir = path.join(ROOT, 'data/sessions');
        await fsp.mkdir(sessionDir, { recursive: true });
        if (platform === 'linux') args = args.map(x => x === path.join(ROOT,'config/services/php.ini') ? path.join(ROOT,phpConfig) : x);
        const extensionArgs = platform === 'windows' ? ['-d', `extension_dir=${path.join(modulePath('PHP', getActive('PHP')), 'ext')}`] : [];
        args = ['-d', `session.save_path=${sessionDir}`, ...extensionArgs, ...args];
    }
    const proc = Bun.spawn([exe, ...args], {
        cwd: path.resolve(ROOT, expand(svc.working_directory || '.')),
        env: { ...process.env, ...Object.fromEntries(Object.entries(svc.environment || {}).map(([k,v]) => [k,expand(v)])) },
        stdin: 'ignore', stdout: Bun.file(path.join(ROOT, 'logs', `${name}.log`)),
        stderr: Bun.file(path.join(ROOT, 'logs', `${name}.error.log`)), windowsHide: true,
    });
    running.set(name, proc);
    try {
        await waitFor(name, name === 'MariaDB' ? 3306 : Number(app.port), proc);
        if (name === 'MariaDB') {
            await ensureRootPassword();
            await completeFirstStart();
            await ensurePhpMyAdminStorage().catch(error=>console.error('phpMyAdmin storage:',error.message));
        }
    } catch (error) {
        if (active(name)) proc.kill();
        running.delete(name);
        failures.set(name, error.message);
        throw error;
    }
}
async function stop(name) {
    const proc = running.get(name);
    if (!proc || proc.exitCode !== null) { running.delete(name); return; }
    if (name === 'MariaDB') await gracefulMariaStop();
    else proc.kill();
    const finished = await Promise.race([proc.exited.then(() => true), wait(12000).then(() => false)]);
    if (!finished && proc.exitCode === null) {
        proc.kill();
        await Promise.race([proc.exited, wait(4000)]);
    }
    running.delete(name);
}
const ordered = () => settings.services.filter(s => s.enabled).sort((a,b) => a.start_order - b.start_order);
async function stopAll() {
    const errors = [];
    for (const svc of ordered().reverse()) try { await stop(svc.name); } catch(e) { errors.push(svc.name + ': ' + e.message); }
    if (errors.length) throw Error(errors.join('; '));
}
async function startAll() {
    const errors = [];
    for (const svc of ordered()) try { if (!getActive(svc.name)) continue; await start(svc.name); } catch(e) { failures.set(svc.name, e.message); errors.push(svc.name + ': ' + e.message); }
    if (errors.length) throw Error(errors.join('; '));
}
async function restartAll() { await stopAll(); await startAll(); }
function tokenEqual(received) {
    if (typeof received !== 'string') return false;
    const a = Buffer.from(received), b = Buffer.from(SECRET);
    return a.length === b.length && timingSafeEqual(a,b);
}
function authorized(request) {
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    if (origin && origin !== URL_ROOT) return false;
    if (referer && !referer.startsWith(URL_ROOT + '/')) return false;
    return tokenEqual(request.headers.get('x-sql-port-token'));
}
function response(data, code = 200) {
    return Response.json(data, { status: code, headers: { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' } });
}
function messageError(error) { return { error: error?.message || String(error) }; }
async function status() {
    const services=await Promise.all(settings.services.map(async s => ({
        name:s.name, enabled:s.enabled, running:active(s.name),
        error:failures.get(s.name)||null, pid:active(s.name)?running.get(s.name).pid:null,
        active_version:getActive(s.name), default_version:getDefault(s.name),
        installed_versions:await installedVersions(s.name)
    })));
    const all={};
    for(const name of ['MariaDB','PHP','phpMyAdmin']) {
        all[name]={...(updates.get(name)||{}),active:getActive(name),default:getDefault(name),
            installed_versions:await installedVersions(name)};
    }
    return {app:app.name,manager:URL_ROOT,startup_url:APP_URL,services,
        updates:all,stopping:shuttingDown,first_run:firstRun};
}
async function activateVersion(name,version) {
    const previous=getActive(name);
    if(previous===version) {
        if(service(name)&&!active(name)) await start(name);
        return;
    }
    const wasRunning=active(name);
    if(wasRunning) await stop(name);
    try {
        await activate(name,version);
        if(service(name)) await start(name); // One process per service, always.
        if(name==='phpMyAdmin') await configurePhpMyAdmin(version);
        failures.delete(name);
    } catch(e) {
        // Restore earlier version, and restore its process if it had been running.
        if(previous) await activate(name,previous);
        if(wasRunning && previous && service(name)) await start(name).catch(err=>failures.set(name,err.message));
        throw e;
    }
}
async function removeVersion(name,version) {
    if (!(await installedVersions(name)).includes(version)) throw Error(`${name} ${version} is not installed`);
    const wasSelected=getActive(name)===version;
    const wasRunning=wasSelected && active(name);
    if (wasRunning) {
        await stop(name);
        if (await ping(name==='MariaDB'?3306:Number(app.port)))
            throw Error(`${name} is still running. Its files were not removed.`);
    }
    await fsp.rm(modulePath(name,version),{recursive:true});
    await unregisterInstalled(name,version);
    if (name==='phpMyAdmin' && wasSelected) await configurePhpMyAdmin();
    return {ok:true,message:`Removed ${name} ${version}.${wasRunning?' Service stopped.':''}`};
}
async function checkAllVersions() {
    if (checking || shuttingDown) return;
    checking = true;
    try { for (const name of ['MariaDB', 'PHP', 'phpMyAdmin']) {
        try { updates.set(name, await check(name)); }
        catch(error) { updates.set(name, { error:error.message, module:name }); }
    }} finally { checking = false; }
}
async function installLinuxFirstRun() {
    if (platform !== 'linux' || process.env.SQL_PORT_AUTO_INSTALL !== '1') return;
    firstRun.state = 'running';
    const problems = [];
    for (const name of ['MariaDB','PHP','phpMyAdmin']) {
        if (shuttingDown) break;
        if ((await installedVersions(name)).length) continue; // Never replace an existing installation.
        firstRun.module = name;
        try {
            const prepared = await prepareInstall(name);
            if (!prepared.sameVersion) await install(name,prepared);
            await activateVersion(name,prepared.pkg.version);
            if(name==='phpMyAdmin' && active('MariaDB'))
                await ensurePhpMyAdminStorage().catch(error=>console.error('phpMyAdmin storage:',error.message));
        } catch(error) {
            console.error(`Linux setup ${name}:`,error);
            problems.push(`${name}: ${error.message}`);
        }
    }
    firstRun.module = null;
    firstRun.error = problems.length ? problems.join('; ') : null;
    firstRun.state = problems.length ? 'error' : 'done';
    if (!problems.length) console.log('Linux first-run services installed and selected');
}
async function updateJob(name, action, selection = {}) {
    const current=jobs.get(name);
    if(current && ['checking','installing'].includes(current.state))throw Error('Update already in progress');
    jobs.set(name,{state:action==='check'?'checking':'installing'});
    void queue(async()=>{
        try {
            let result;
            if(action==='check')result=await check(name);
            else {
                const prepared=await prepareInstall(name,selection);
                if(prepared.sameVersion) {
                    result={message:`${name} ${prepared.pkg.version} is already installed.`,version:prepared.pkg.version};
                } else {
                    result=await install(name,prepared); // Side by side; never delete other installed versions.
                    // Installation selects and starts the newly chosen service version.
                    // Switching stops any prior instance before launching the new one.
                    try {
                        await activateVersion(name,prepared.pkg.version);
                        await setDefault(name,prepared.pkg.version);
                        if(name==='phpMyAdmin' && active('MariaDB'))
                            await ensurePhpMyAdminStorage().catch(error=>console.error('phpMyAdmin storage:',error.message));
                        result.message+= name==='phpMyAdmin'
                            ? ' Selected for the application.'
                            : ' Service started.';
                    } catch (error) {
                        failures.set(name,error.message);
                        throw Error(`${name} ${prepared.pkg.version} installed, but startup failed: ${error.message}`);
                    }
                }
            }
            try {updates.set(name,await check(name));}
            catch(error){updates.set(name,{error:error.message});}
            jobs.set(name,{state:'done',result});
        }catch(error){jobs.set(name,{state:'error',error:error.message});}
    });
    return {state:'started'};
}
function fileContentType(name) {
    return name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' :
        name.endsWith('.png') ? 'image/png' : name.endsWith('.ico') ? 'image/x-icon' : 'text/html; charset=utf-8';
}
const uiFiles = new Map([['/', 'manager/index.html'], ['/index.html','manager/index.html'],
    ['/favicon.ico','assets/app.ico'], ['/favicon.png','assets/favicon.png'], ['/main.css','manager/main.css'], ['/main.js','manager/main.js'], ['/icon.png','assets/icon.png']]);
let server;
async function quit() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await stopAll(); } catch(e) { console.error('Shutdown services:', e); }
    setTimeout(() => { server.stop(true); process.exit(0); }, 400);
}
server = Bun.serve({ hostname: host, port, async fetch(request) {
    if (request.headers.get('host') !== `${host}:${port}`) return response({ error:'Invalid host' },403);
    const route = new URL(request.url).pathname;
    if (route === '/health' && request.method === 'GET') return response({ ok:true, app:'SQL PORT' });
    if (route === '/api/session' && request.method === 'GET') return response({ token:SECRET });
    if (route === '/api/status' && request.method === 'GET') return response(await status());
    if (route.startsWith('/api/config/') && request.method === 'GET') {
        if (!authorized(request)) return response({error:'Forbidden'},403);
        const name = decodeURIComponent(route.slice('/api/config/'.length));
        const filenames = { PHP:phpConfig, MariaDB:'config/services/mariadb.ini', phpMyAdmin:getActive('phpMyAdmin') ? 'config/services/phpmyadmin.php' : null };
        if (!filenames[name]) return response({error:'Install and activate this module first'},404);
        const filepath = path.join(ROOT, filenames[name]);
        if (!fs.existsSync(filepath)) return response({error:'Configuration file does not exist yet'},404);
        return response({name, path:filenames[name], content:await fsp.readFile(filepath,'utf8')});
    }
    if (route.startsWith('/api/update/') && route.endsWith('/status') && request.method === 'GET') {
        const name = decodeURIComponent(route.slice('/api/update/'.length, -'/status'.length));
        if (!['MariaDB','PHP','phpMyAdmin'].includes(name)) return response({error:'Unknown module'},404);
        return response(jobs.get(name) || { state:'idle' });
    }
    if (request.method === 'POST' && route.startsWith('/api/')) {
        if (!authorized(request)) return response({ error:'Unauthorized local request' }, 403);
        if (shuttingDown) return response({ error:'Shutdown in progress' },409);
        try {
            if (route === '/api/quit') { void queue(quit); return response({ ok:true, action:'quit' }); }
            if (route === '/api/stop') { await queue(stopAll); return response({ok:true}); }
            if (route === '/api/restart' || route === '/api/restart-all') { await queue(restartAll); return response({ok:true}); }
            if (route === '/api/database/reset') {
                const raw=await request.text();
                if(raw.length>1000)return response({error:'Request too large'},413);
                const body=JSON.parse(raw||'{}');
                if(body?.confirmation!=='RESET MAIN'||typeof body.current_password!=='string'||body.current_password.length>256)
                    return response({error:'Reset confirmation or current password is invalid'},400);
                return response(await queue(async()=>{
                    if(!active('MariaDB'))throw Error('Start MariaDB before resetting the main database');
                    const phpWasRunning=active('PHP');
                    if(phpWasRunning)await stop('PHP');
                    try {
                        const backup=await resetMainDatabase(body.current_password);
                        return {ok:true,backup,message:'Database main was reset. MariaDB user: root; password: root.'};
                    } finally {
                        if(phpWasRunning)await start('PHP').catch(error=>failures.set('PHP',error.message));
                    }
                }));
            }
            if (route === '/api/check-all') { void checkAllVersions(); return response({ok:true}); }
            if (route.startsWith('/api/versions/')) {
                const components=route.slice('/api/versions/'.length).split('/');
                const name=decodeURIComponent(components[0]); const action=components[1];
                if(!['MariaDB','PHP','phpMyAdmin'].includes(name)||!['activate','default','remove'].includes(action))
                    return response({error:'Invalid version action'},404);
                const raw=await request.text();
                if(raw.length>300) return response({error:'Request too large'},413);
                const body=JSON.parse(raw||'{}');
                if(typeof body.version!=='string'||!/^\d+\.\d+\.\d+$/.test(body.version))
                    return response({error:'Invalid version'},400);
                const result=await queue(async()=>{
                    if(action==='activate')await activateVersion(name,body.version);
                    else if(action==='default')await setDefault(name,body.version);
                    else return await removeVersion(name,body.version);
                });
                return response(result||{ok:true});
            }
            if (route.startsWith('/api/service/')) {
                const components = route.slice('/api/service/'.length).split('/');
                const name = decodeURIComponent(components[0]); const action = components[1];
                if (!service(name)) return response({error:'Unknown service'},404);
                if (!['start','stop','restart','version'].includes(action)) return response({error:'Invalid action'},404);
                if (action === 'version') return response({ version: await installedVersion(name) });
                await queue(async () => { if (action !== 'start') await stop(name); if (action !== 'stop') await start(name); });
                return response({ok:true});
            }
            if (route.startsWith('/api/update/')) {
                const components = route.slice('/api/update/'.length).split('/');
                const name = decodeURIComponent(components[0]); const action = components[1];
                if (!['PHP','MariaDB','phpMyAdmin'].includes(name) || !['check','install'].includes(action)) return response({error:'Unknown update action'},404);
                let selection = {};
                if (action === 'install') {
                    const raw = await request.text();
                    if (raw.length > 4000) return response({error:'Request too large'},413);
                    selection = raw ? JSON.parse(raw) : {};
                    if (!selection || typeof selection !== 'object' || Array.isArray(selection))
                        return response({error:'Invalid version selection'},400);
                }
                return response(await updateJob(name,action,selection),202);
            }
            if (route.startsWith('/api/config/')) {
                const name = decodeURIComponent(route.slice('/api/config/'.length));
                const filenames = { PHP:phpConfig, MariaDB:'config/services/mariadb.ini', phpMyAdmin:getActive('phpMyAdmin') ? 'config/services/phpmyadmin.php' : null };
                if (!filenames[name]) return response({error:'Unknown config'},404);
                const filepath = path.join(ROOT, filenames[name]);
                const body = await request.text();
                if (body.length > 200000) return response({error:'Configuration is too large'},413);
                const json = JSON.parse(body);
                if (typeof json.content !== 'string') return response({error:'Missing configuration text'},400);
                await fsp.mkdir(path.dirname(filepath), { recursive:true });
                if (fs.existsSync(filepath)) await fsp.copyFile(filepath, filepath + '.bak');
                await fsp.writeFile(filepath,json.content,'utf8');
                return response({ok:true, message:'Configuration saved. Restart the relevant service to apply changes.'});
            }
            return response({error:'Not found'},404);
        } catch(error) { return response(messageError(error),500); }
    }
    if (request.method !== 'GET') return response({error:'Method not allowed'},405);
    const file = uiFiles.get(route);
    if (!file) return response({error:'Not found'},404);
    const resolved = path.join(ROOT,file);
    if (!fs.existsSync(resolved)) return response({error:'Missing UI file'},404);
    return new Response(Bun.file(resolved), { headers:{
        'Content-Type':fileContentType(resolved), 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer' } });
} });
console.log(`SQL PORT manager: ${URL_ROOT}`);
await configurePhpMyAdmin().catch(err => console.error(err));
// Start installed services only; missing binaries report errors without terminating the manager.
void queue(startAll).catch(error => console.error('Startup:', error));
void queue(installLinuxFirstRun).catch(error => console.error('Linux first-run:', error));
void checkAllVersions();
const period = Math.max(1, Number(updateConfig.policy?.check_interval_hours || 6)) * 3600000;
setInterval(() => void checkAllVersions(), period).unref?.();
process.on('SIGINT', () => void queue(quit));
process.on('SIGTERM', () => void queue(quit));
