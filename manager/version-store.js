// Editable version-selection registry. Each module version is installed side by side.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODULES = ['MariaDB', 'PHP', 'phpMyAdmin'];
const folderNames = { MariaDB:'mariadb', PHP:'php', phpMyAdmin:'phpmyadmin' };
// Windows keeps its original files. Linux installations are isolated by CPU architecture.
const linuxSuffix = process.platform === 'linux' ? `-linux-${process.arch}` : '';
const registry = path.join(ROOT, 'data', `version-selection${linuxSuffix}.json`);
const pattern = /^\d+\.\d+\.\d+$/;
export const moduleRoot = name => {
    if (!Object.hasOwn(folderNames, name)) throw Error('Unknown module');
    const folder = name === 'phpMyAdmin' ? folderNames[name] : folderNames[name] + linuxSuffix;
    return path.join(ROOT, 'modules', folder);
};
export const modulePath = (name, version) => {
    if (!pattern.test(version || '')) throw Error('Invalid installed version');
    return path.join(moduleRoot(name), 'versions', version);
};
export const executablePath = (name, version) => {
    const base = modulePath(name, version);
    const windows = process.platform === 'win32';
    if (name === 'PHP') return path.join(base, windows ? 'php.exe' : 'bin/php');
    if (name === 'MariaDB') return path.join(base, 'bin', windows ? 'mariadbd.exe' : 'mariadbd');
    return path.join(base, 'index.php');
};
export async function installedVersions(name) {
    const dir = path.join(moduleRoot(name), 'versions');
    let entries = [];
    try { entries = await fsp.readdir(dir, {withFileTypes:true}); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    return entries.filter(e => e.isDirectory() && pattern.test(e.name) && fs.existsSync(executablePath(name,e.name)))
        .map(e=>e.name).sort((a,b)=>compareVersion(b,a));
}
export function compareVersion(a,b) {
    const A=String(a||'0').split('.').map(Number),B=String(b||'0').split('.').map(Number);
    for (let i=0;i<Math.max(A.length,B.length);i++) if ((A[i]||0)!==(B[i]||0)) return (A[i]||0)-(B[i]||0);
    return 0;
}
let state = {active:{},default:{}};
async function persist() {
    await fsp.mkdir(path.dirname(registry), {recursive:true});
    const tmp=registry+'.tmp';
    await fsp.writeFile(tmp,JSON.stringify(state,null,4)+'\n');
    await fsp.rename(tmp,registry);
}
export const getActive = name => state.active[name] || null;
export const getDefault = name => state.default[name] || null;
export async function initializeVersions() {
    try {
        const saved=JSON.parse(await fsp.readFile(registry,'utf8'));
        state={active: saved.active||{}, default:saved.default||{}};
    } catch(e) {if(e.code!=='ENOENT') throw Error('Invalid '+path.relative(ROOT,registry)+': '+e.message);}
    // The startup selection always follows the saved default, not the previous temporary active choice.
    for (const name of MODULES) {
        const installed=await installedVersions(name);
        if (!installed.includes(state.default[name])) state.default[name]=installed[0]||null;
        state.active[name]=state.default[name];
    }
    await persist();
}
export async function registerInstalled(name,version) {
    if (!(await installedVersions(name)).includes(version)) throw Error('Cannot register a missing version');
    if (!state.default[name]) state.default[name]=version;
    if (!state.active[name]) state.active[name]=version;
    await persist();
}
export async function unregisterInstalled(name,version) {
    const remaining=(await installedVersions(name)).filter(v=>v!==version);
    if (!remaining.includes(state.default[name])) state.default[name]=remaining[0]||null;
    if (!remaining.includes(state.active[name])) state.active[name]=state.default[name];
    await persist();
}
export async function activate(name,version) {
    if (!(await installedVersions(name)).includes(version)) throw Error(`${name} ${version} is not installed`);
    state.active[name]=version;
    await persist();
}
export async function setDefault(name,version) {
    if (!(await installedVersions(name)).includes(version)) throw Error(`${name} ${version} is not installed`);
    state.default[name]=version;
    await persist();
}
