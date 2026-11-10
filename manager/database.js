// Each MariaDB version owns its data folder: no silent cross-version datadir reuse.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, modulePath, getActive } from './version-store.js';
const windows=process.platform==='win32';
const version=()=>{
    const current=getActive('MariaDB');
    if (!current) throw Error('Select a MariaDB version first');
    return current;
};
const base=()=>modulePath('MariaDB',version());
const data=()=>path.join(ROOT,windows?'data/mariadb/versions':`data/mariadb/linux-${process.arch}/versions`,version());
const bin=name=>path.join(base(),'bin',name+(windows?'.exe':''));
const connection=['--no-defaults','--protocol=tcp','--host=127.0.0.1','--port=3306','--user=root'];
const authenticated=[...connection,'--password=root'];
const client=()=>[bin('mariadb'),bin('mysql')].find(fs.existsSync);
export const mariaArgs=()=>[
    `--basedir=${base()}`,`--datadir=${data()}`,'--port=3306','--bind-address=127.0.0.1'
];
async function runAndCapture(cmd,args,cwd=ROOT,timeout=60000,env=process.env) {
    const child=Bun.spawn([cmd,...args],{cwd,env,stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
    const timer=setTimeout(()=>child.kill(),timeout);
    try {
        const [code,stdout,stderr]=await Promise.all([child.exited,child.stdout.text(),child.stderr.text()]);
        if(code!==0)throw Error(`Exit code ${code}: ${[stdout,stderr].join('\n').slice(0,1500)}`);
        return stdout;
    } finally {clearTimeout(timer);}
}
export async function prepareDatabase(){
    const datadir=data();
    await fsp.mkdir(datadir,{recursive:true});
    if(fs.existsSync(path.join(datadir,'mysql')))return;
    const entries=(await fsp.readdir(datadir)).filter(x=>x!=='.gitkeep');
    if(entries.length)throw Error('MariaDB data folder is nonempty but has no system tables. Refusing to overwrite.');
    const init=windows?bin('mariadb-install-db'):
        fs.existsSync(path.join(base(),'scripts/mariadb-install-db'))?path.join(base(),'scripts/mariadb-install-db'):bin('mariadb-install-db');
    if(!fs.existsSync(init))throw Error('Missing MariaDB initialization utility: '+init);
    const args=[`--datadir=${datadir}`];
    if(windows)args.push('--password=root');
    else args.push(`--basedir=${base()}`,'--auth-root-authentication-method=normal');
    await runAndCapture(init,args,base(),120000);
    if(!fs.existsSync(path.join(datadir,'mysql')))throw Error('MariaDB initialization did not create system tables');
    await fsp.writeFile(path.join(datadir,'.sql-port-first-start'),'pending');
}
export async function ensureRootPassword(){
    const command=client();
    if(!command)return;
    try {
        await runAndCapture(command,[...authenticated,'--execute=SELECT 1'],ROOT,10000);
        return;
    } catch {}
    try {
        await runAndCapture(command,[...connection,'--execute=SELECT 1'],ROOT,10000);
    } catch { return; } // Existing custom passwords are never changed.
    await runAndCapture(command,[...connection,"--execute=ALTER USER CURRENT_USER() IDENTIFIED BY 'root';"]);
    await runAndCapture(command,[...authenticated,'--execute=SELECT 1'],ROOT,10000);
}
export async function completeFirstStart(){
    const marker=path.join(data(),'.sql-port-first-start');
    if(!fs.existsSync(marker))return;
    const command=client();
    if(!command)throw Error('MariaDB client missing; database was not modified');
    const sql='CREATE DATABASE IF NOT EXISTS `main` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;';
    await runAndCapture(command,[...authenticated,'--execute='+sql]);
    await fsp.unlink(marker);
}
export async function ensurePhpMyAdminStorage(){
    const current=getActive('phpMyAdmin');
    if(!current)return;
    const folder=modulePath('phpMyAdmin',current);
    const script=[path.join(folder,'sql/create_tables.sql'),path.join(folder,'resources/sql/create_tables.sql')].find(fs.existsSync);
    if(!script)throw Error('phpMyAdmin storage setup SQL is missing');
    const command=client();
    if(!command)throw Error('MariaDB client missing; phpMyAdmin storage was not initialized');

    const query=sql=>runAndCapture(command,[...authenticated,'--batch','--skip-column-names','--execute='+sql],ROOT,15000);
    const exists=Number((await query("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='phpmyadmin'")).trim());
    const tables=['bookmark','relation','table_info','table_coords','pdf_pages','column_info','history',
        'table_uiprefs','tracking','userconfig','recent','favorite','users','usergroups',
        'navigationhiding','savedsearches','central_columns','designer_settings','export_templates'];
    const count=()=>query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='phpmyadmin' AND TABLE_NAME IN ("+
        tables.map(name=>"'pma__"+name+"'").join(',')+")").then(value=>Number(value.trim()));
    const present=exists ? await count() : 0;
    const total=exists ? Number((await query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='phpmyadmin'")).trim()) : 0;

    // A preexisting database with any tables is never replaced or modified.
    if(exists && total>0 && present<tables.length)
        throw Error('Existing phpmyadmin database has incomplete or custom tables; automatic setup cancelled.');
    if(!exists || present===0){
        const sql=await fsp.readFile(script,'utf8');
        if(!/CREATE DATABASE IF NOT EXISTS\s+`?phpmyadmin`?/i.test(sql))
            throw Error('phpMyAdmin storage SQL has an unexpected database name; setup cancelled');
        const child=Bun.spawn([command,...authenticated],{
            cwd:ROOT,stdin:Bun.file(script),stdout:'pipe',stderr:'pipe',windowsHide:true
        });
        const timer=setTimeout(()=>child.kill(),120000);
        try {
            const [code,stderr]=await Promise.all([child.exited,child.stderr.text()]);
            if(code!==0)throw Error('phpMyAdmin storage import failed: '+stderr.slice(0,500));
        } finally {clearTimeout(timer);}
        if(await count()!==tables.length)throw Error('phpMyAdmin storage import left some required tables missing');
    }
}
export async function gracefulMariaStop(){
    const command=[bin('mariadb-admin'),bin('mysqladmin')].find(fs.existsSync);
    if(!command)return false;
    try {await runAndCapture(command,[...authenticated,'shutdown'],ROOT,12000);return true;}
    catch{return false;}
}
export async function resetMainDatabase(currentPassword){
    const command=client();
    const dump=[bin('mariadb-dump'),bin('mysqldump')].find(fs.existsSync);
    if(!command||!dump)throw Error('MariaDB client or backup utility is missing. Nothing was reset.');
    const env={...process.env,MYSQL_PWD:currentPassword};

    // Check the supplied credentials before creating a backup or changing any data.
    await runAndCapture(command,[...connection,'--execute=SELECT 1'],ROOT,10000,env);

    const backups=path.join(ROOT,'data/backups');
    await fsp.mkdir(backups,{recursive:true});
    const name='main-before-reset-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.sql';
    const backup=path.join(backups,name);
    const child=Bun.spawn([dump,...connection,'--single-transaction','--routines','--events','--triggers','--databases','main'],{
        cwd:ROOT,env,stdin:'ignore',stdout:Bun.file(backup),stderr:'pipe',windowsHide:true
    });
    const timer=setTimeout(()=>child.kill(),600000);
    try {
        const [code,stderr]=await Promise.all([child.exited,child.stderr.text()]);
        if(code!==0)throw Error('Database backup failed; reset cancelled. '+stderr.slice(0,500));
    } catch(error) {
        await fsp.unlink(backup).catch(()=>{});
        throw error;
    } finally { clearTimeout(timer); }

    // Only the application database is deleted; other databases and versions remain.
    const sql="DROP DATABASE IF EXISTS `main`; CREATE DATABASE `main` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; ALTER USER CURRENT_USER() IDENTIFIED BY 'root';";
    await runAndCapture(command,[...connection,'--execute='+sql],ROOT,60000,env);
    await runAndCapture(command,[...authenticated,'--execute=SELECT 1'],ROOT,10000);
    return 'data/backups/'+name;
}
