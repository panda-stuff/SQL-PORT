// Official release discovery and portable package installation.
// No hardcoded package versions. Paths and release policy live in config/updates/updates.json.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { moduleRoot, modulePath, executablePath, installedVersions, getActive, getDefault, registerInstalled } from './version-store.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.platform;
const EXE = platform === 'win32' ? 'windows' : 'linux';
const safeNames = ['MariaDB', 'PHP', 'phpMyAdmin'];
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/services/services.json'), 'utf8'));
const updates = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/updates/updates.json'), 'utf8'));
const { policy, official_sources: sources } = updates;
const normalVersion = v => String(v || '').match(/^\d+(?:\.\d+){1,3}/)?.[0] || null;
export function compareVersions(a, b) {
    const A = (normalVersion(a) || '0').split('.').map(Number);
    const B = (normalVersion(b) || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
        if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
    }
    return 0;
}
const checkedURL = (url, expectedHosts) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !expectedHosts.includes(parsed.hostname)) throw Error('Unexpected download or release host: ' + parsed.hostname);
    return parsed.href;
};
async function officialJSON(url, hosts) {
    const result = await fetch(checkedURL(url, hosts), { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json' } });
    if (!result.ok) throw Error(`Official server returned HTTP ${result.status}`);
    return await result.json();
}
async function officialText(url, hosts) {
    const result = await fetch(checkedURL(url, hosts), { signal: AbortSignal.timeout(25000) });
    if (!result.ok) throw Error(`Official server returned HTTP ${result.status}`);
    return await result.text();
}
function getModuleFolder(name) { return moduleRoot(name); }
function getServiceExe(name) {
    const svc = config.services.find(s => s.name === name);
    const rel = svc?.executable?.[EXE];
    if (!rel) throw Error(`No configured ${name} binary for ${EXE}`);
    const resolved = path.resolve(ROOT, rel.replaceAll('{app}', ROOT));
    if (!resolved.startsWith(ROOT + path.sep)) throw Error('Configured executable escapes application directory');
    return resolved;
}
export async function installedVersion(name) {
    const active = getActive(name);
    return active && (await installedVersions(name)).includes(active) ? active : null;
}

// Each entry is the newest supported point release of a supported branch.
// Nothing here pins a specific software version.
const sortPackages = pkgs => pkgs.sort((a,b) => compareVersions(b.version, a.version));
const isSupportedMariaBranch = branch => {
    if (branch.release_status !== (policy.mariadb_release_status || 'Stable')) return false;
    if (policy.mariadb_support_type && policy.mariadb_support_type !== 'any' &&
        branch.release_support_type !== policy.mariadb_support_type) return false;
    if (branch.release_eol_date) {
        const eol = Date.parse(branch.release_eol_date + 'T23:59:59Z');
        if (!Number.isFinite(eol) || eol < Date.now()) return false;
    }
    return true;
};
async function mariadbPackages() {
    const hosts = ['downloads.mariadb.org'];
    const endpoint = checkedURL(sources.mariadb, hosts);
    const listing = await officialJSON(endpoint, hosts);
    const branches = (listing.major_releases || []).filter(isSupportedMariaBranch);
    branches.sort((a,b) => compareVersions(b.release_id, a.release_id));
    if (!branches.length) throw Error('No supported stable MariaDB branches were returned');
    const packages = [];
    const problems = [];
    for (const branch of branches) {
        const latestUrl = new URL(encodeURIComponent(branch.release_id) + '/latest/', endpoint).href;
        try {
            const doc = await officialJSON(latestUrl, hosts);
            const releases = Object.entries(doc.releases || {}).sort((a,b) => compareVersions(b[0], a[0]));
            for (const [version, details] of releases) {
                if (!normalVersion(version) || normalVersion(version) !== version) continue;
                const file = (details.files || []).find(f => {
                    const name = f.file_name || '';
                    if (platform === 'win32') return /-winx64\.zip$/i.test(name) && process.arch === 'x64';
                    if (platform === 'linux' && process.arch === 'x64') return /linux.*x86_64.*\.tar\.gz$/i.test(name);
                    if (platform === 'linux' && process.arch === 'arm64') return /linux.*(?:aarch64|arm64).*\.tar\.gz$/i.test(name);
                    return false;
                });
                if (!file) continue;
                const url = file.file_id
                    ? checkedURL(`https://downloads.mariadb.org/rest-api/${encodeURIComponent(String(file.file_id))}`, hosts)
                    : checkedURL(file.file_download_url, ['downloads.mariadb.org', 'archive.mariadb.org', 'mirror.mariadb.org']);
                packages.push({ name:'MariaDB', version, url,
                    sha256:file.checksum?.sha256sum || null,
                    archive:file.file_name.endsWith('.zip') ? 'zip' : 'tar.gz',
                    branch:branch.release_id, source:latestUrl,
                    channel:branch.release_support_type || 'Stable' });
                break; // Latest downloadable point release for this supported branch.
            }
            if (!packages.some(p => p.branch === branch.release_id)) throw Error('No compatible portable archive');
        } catch (error) { problems.push(`${branch.release_id}: ${error.message}`); }
    }
    if (!packages.length) throw Error(`No compatible supported MariaDB packages found. ${problems.join('; ')}`);
    return sortPackages(packages);
}

async function phpPackages() {
    if (!['win32','linux'].includes(platform) || !['x64','arm64'].includes(process.arch))
        throw Error('No prebuilt portable PHP packages for this platform and architecture.');
    const supportedEndpoint = checkedURL(sources.php_supported_versions, ['www.php.net', 'php.net']);
    const metadata = await officialJSON(supportedEndpoint, ['www.php.net', 'php.net']);
    // PHP publishes supported_versions in its official machine-readable releases feed.
    const supported = new Set(Object.values(metadata).flatMap(v => v?.supported_versions || []).map(String));
    if (!supported.size) throw Error('PHP did not return a supported-branch list; refusing to include unsupported releases');
    if (platform === 'linux') {
        // Maintainer-provided Linux CLI binaries with mysqli and PDO MySQL compiled in.
        // Only accept releases whose publisher provides a SHA256 checksum file.
        const endpoint = checkedURL(sources.php_portable_linux, ['dl.static-php.dev']);
        const html = await officialText(endpoint, ['dl.static-php.dev']);
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
        const pattern = new RegExp(`php-\\d+\\.\\d+\\.\\d+-cli-linux-${arch}\\.tar\\.gz`, 'g');
        const candidates = [...new Set(html.match(pattern) || [])];
        const byBranch = new Map();
        for (const filename of candidates) {
            if (!html.includes(filename + '.sha256')) continue;
            const version = filename.match(/^php-(\d+\.\d+\.\d+)/)?.[1];
            const branch = version?.split('.').slice(0,2).join('.');
            if (!supported.has(branch)) continue;
            const previous = byBranch.get(branch);
            if (!previous || compareVersions(version, previous.version) > 0)
                byBranch.set(branch, { filename, version, branch });
        }
        if (!byBranch.size) throw Error('No checksummed StaticPHP Linux CLI archive found for a supported PHP branch');
        const packages = [];
        for (const {filename, version, branch} of byBranch.values()) {
            const shaURL = checkedURL(new URL(filename + '.sha256', endpoint).href, ['dl.static-php.dev']);
            const checksum = (await officialText(shaURL, ['dl.static-php.dev'])).match(/\b[a-f\d]{64}\b/i)?.[0];
            if (!checksum) throw Error(`StaticPHP returned an invalid SHA256 checksum for ${filename}`);
            packages.push({ name:'PHP', version, branch,
                url:checkedURL(new URL(filename,endpoint).href, ['dl.static-php.dev']),
                sha256:checksum, archive:'tar.gz', source:endpoint,
                channel:`Supported PHP ${branch} · StaticPHP Linux ${arch}` });
        }
        return sortPackages(packages);
    }
    if (process.arch !== 'x64') throw Error('Windows PHP portable archives require x64');
    const endpoint = checkedURL(sources.php_windows, ['downloads.php.net', 'windows.php.net']);
    const html = await officialText(endpoint, ['downloads.php.net', 'windows.php.net']);
    const build = policy.php_windows_build === 'ts' ? '' : 'nts-';
    const arch = policy.php_windows_arch === 'x86' ? 'x86' : 'x64';
    const pattern = new RegExp(`php-\\d+\\.\\d+\\.\\d+(?:-\\d+)?-${build}Win32-[A-Za-z0-9_-]+-${arch}\\.zip`, 'gi');
    const names = [...new Set(html.match(pattern) || [])];
    const packages = new Map();
    for (const filename of names) {
        const version = filename.match(/^php-(\d+\.\d+\.\d+)/i)?.[1];
        const branch = version?.split('.').slice(0,2).join('.');
        if (!branch || !supported.has(branch)) continue;
        const previous = packages.get(branch);
        // Only newest point version, then newest Windows build revision, per branch.
        const buildNumber = Number(filename.match(/^php-\d+\.\d+\.\d+-(\d+)-/i)?.[1] || 0);
        if (previous && (compareVersions(version,previous.version) < 0 ||
            (version === previous.version && buildNumber <= previous.buildNumber))) continue;
        packages.set(branch, { name:'PHP', version, branch, buildNumber,
            url:checkedURL(new URL(filename,endpoint).href, ['downloads.php.net', 'windows.php.net']),
            sha256:null, archive:'zip', source:supportedEndpoint,
            channel:`Supported PHP ${branch} · ${policy.php_windows_build === 'ts' ? 'TS' : 'NTS'} ${arch}` });
    }
    if (!packages.size) throw Error('No compatible Windows PHP archives in currently supported branches');
    return sortPackages([...packages.values()]).map(({buildNumber,...pkg})=>pkg);
}

function phpCompatibilityWarning(name, version, phpRange, installedPHP) {
    if (!installedPHP || !phpRange) return null;
    const lower = phpRange.match(/>=\s*(\d+\.\d+)/);
    const upper = phpRange.match(/<\s*(\d+\.\d+)/);
    if ((upper && compareVersions(installedPHP,upper[1]) >= 0) ||
        (lower && compareVersions(installedPHP,lower[1]) < 0))
        return `${name} ${version} requires PHP ${phpRange}; installed PHP is ${installedPHP}.`;
    return null;
}
async function phpMyAdminPackages() {
    const endpoint = checkedURL(sources.phpmyadmin, ['www.phpmyadmin.net', 'phpmyadmin.net']);
    const details = await officialJSON(endpoint, ['www.phpmyadmin.net', 'phpmyadmin.net']);
    const installedPHP = await installedVersion('PHP');
    // The official current-version feed contains only supported releases.
    // Older phpMyAdmin files from /files/ are archival and NOT added here.
    const releases = (details.releases || []).filter(r => normalVersion(r.version) === r.version);
    if (!releases.length) throw Error('No supported phpMyAdmin releases were returned');
    return sortPackages(releases.map(r => ({
        name:'phpMyAdmin', version:r.version, branch:r.version.split('.').slice(0,2).join('.'),
        url:checkedURL(`https://files.phpmyadmin.net/phpMyAdmin/${encodeURIComponent(r.version)}/phpMyAdmin-${encodeURIComponent(r.version)}-all-languages.zip`, ['files.phpmyadmin.net']),
        sha256:null, archive:'zip', source:endpoint,
        channel:r.version === details.version ? 'Current stable' : 'Security maintenance',
        compatibilityWarning:phpCompatibilityWarning('phpMyAdmin', r.version, r.php_versions, installedPHP),
    })));
}

// Official publishers do not all designate a single "recommended" branch.
// SQL PORT defaults to supported, conservative and mutually compatible builds.
// Sources, release eligibility and preferences remain external and dynamically queried.
function satisfiesPhpRange(version, phpRange) {
    if (!phpRange) return false;
    const lower = phpRange.match(/>=\s*(\d+\.\d+)/);
    const upper = phpRange.match(/<\s*(\d+\.\d+)/);
    return (!lower || compareVersions(version, lower[1]) >= 0)
        && (!upper || compareVersions(version, upper[1]) < 0);
}
async function withRecommended(name, packages) {
    if (!packages.length) throw Error('No supported release found for ' + name);
    let preferred = packages[0];
    let why = 'Official latest stable release';
    if (name === 'MariaDB' && policy.mariadb_prefer_lts !== false) {
        preferred = packages.find(p => p.channel === 'Long Term Support') || packages[0];
        why = preferred.channel === 'Long Term Support'
            ? 'Newest officially maintained LTS series (SQL PORT conservative default)'
            : 'Newest officially supported stable series (no LTS package available)';
    } else if (name === 'PHP') {
        // Do not pin PHP to an older branch because phpMyAdmin's metadata lists an
        // upper bound. Its official 5.2.3 release page describes PHP 8.4/8.5 fixes
        // while its version.json still says <8.4. Warn for the specific pairing.
        why = 'Newest stable, officially supported PHP release';
    } else if (name === 'phpMyAdmin') {
        preferred = packages.find(p=>p.channel === 'Current stable') || packages[0];
        why = 'Current stable release published by phpMyAdmin';
    }
    return packages.map(p => ({ ...p, recommended: p.version === preferred.version,
        recommendationReason: p.version === preferred.version ? why : null }));
}
export async function availablePackages(name) {
    if (name === 'MariaDB') return withRecommended(name, await mariadbPackages());
    if (name === 'PHP') return withRecommended(name, await phpPackages());
    if (name === 'phpMyAdmin') return withRecommended(name, await phpMyAdminPackages());
    throw Error('Unknown module');
}
const recommendedFrom = pkgs => pkgs.find(p => p.recommended) || pkgs[0];
export async function latestPackage(name) { return (await availablePackages(name))[0]; }
export async function check(name) {
    const pkgs = await availablePackages(name);
    const installed = await installedVersions(name);
    const active = await installedVersion(name);
    const preferred = recommendedFrom(pkgs);
    // Recommended branch remains the status baseline unless the user explicitly
    // activated a NEWER branch. Then follow updates within that installed branch.
    // Showing supported options in the dropdown is independent of this status line.
    const branch = active?.split('.').slice(0,2).join('.');
    const sameBranch = branch ? pkgs.find(p => p.branch === branch) : null;
    const aboveRecommendation = !!active && compareVersions(active, preferred.version) > 0;
    const unsupportedBranch = aboveRecommendation && !sameBranch;
    const pkg = aboveRecommendation ? sameBranch : preferred;
    const available = pkg?.version || active || preferred.version;
    const isLts = name === 'MariaDB' && pkg?.channel === 'Long Term Support';
    return {
        module:name, installed:active, active, default:getDefault(name), installed_versions:installed,
        available, is_lts:isLts, recommended_version:preferred.version, latest_supported:pkgs[0].version,
        update_available:!!pkg && !installed.includes(pkg.version),
        unsupported_branch:unsupportedBranch,
        versions: pkgs.map(p=>({ version:p.version, branch:p.branch, channel:p.channel,
            recommended:!!p.recommended, compatibility_warning:p.compatibilityWarning || null })),
        source:pkg?.source || preferred.source,
        message:`Latest version: ${available}${isLts?' LTS':''} (${installed.includes(available) ? 'Installed' : 'Not Installed'})`
    };
}
export async function prepareInstall(name, selection={}) {
    const pkgs=await availablePackages(name);
    const requested=selection.version;
    if (requested!==undefined && (typeof requested!=='string' || !/^\d+\.\d+\.\d+$/.test(requested)))
        throw Error('Invalid selected version');
    const pkg=requested ? pkgs.find(p=>p.version===requested) : recommendedFrom(pkgs);
    if (!pkg) throw Error('Selected version is unsupported or no portable download is available.');
    // Official phpMyAdmin version.json lists <8.4 but the official downloads
    // page says PHP 7.2+; release notes include PHP 8.4/8.5 fixes. The default
    // is an advisory; users may set policy to 'block' in updates.json.
    if (pkg.compatibilityWarning && policy.phpmyadmin_compatibility_policy === 'block')
        throw Error(pkg.compatibilityWarning);
    // Side-by-side installation never overwrites or downgrades an existing module.
    const installed=await installedVersions(name);
    return {pkg, installed:await installedVersion(name), sameVersion:installed.includes(pkg.version)};
}

async function download(pkg, dest) {
    const response = await fetch(pkg.url, { signal: AbortSignal.timeout(300000), redirect: 'follow' });
    if (!response.ok) throw Error(`Package download returned HTTP ${response.status}`);
    if (new URL(response.url).protocol !== 'https:') throw Error('Package download redirected to insecure HTTP');
    const max = Number(policy.max_download_mb || 700) * 1024 * 1024;
    if (Number(response.headers.get('content-length') || 0) > max) throw Error('Download exceeds configured size limit');
    if (!response.body) throw Error('Official server returned an empty download');
    const hash = createHash('sha256');
    const stream = fs.createWriteStream(dest, { flags:'wx' });
    let total = 0;
    try {
        for await (const chunk of response.body) {
            total += chunk.byteLength;
            if (total > max) throw Error('Download exceeds configured size limit');
            hash.update(chunk);
            if (!stream.write(chunk)) await once(stream, 'drain');
        }
        stream.end();
        await once(stream, 'finish');
        if (!total) throw Error('Official download was empty');
        if (pkg.sha256 && hash.digest('hex').toLowerCase() !== pkg.sha256.toLowerCase())
            throw Error('Official SHA256 integrity verification failed');
    } catch (error) {
        stream.destroy();
        await fsp.rm(dest, { force:true }).catch(() => {});
        throw error;
    }
}

async function extract(archive, dest, format) {
    await fsp.mkdir(dest, { recursive: true });
    if (format === 'tar.gz') {
        // Stream extraction: MariaDB tarballs can be several hundred MB.
        const result = Bun.spawn(['tar', '-xzf', archive, '-C', dest], { cwd: ROOT, stdin:'ignore', stdout:'pipe', stderr:'pipe' });
        const [code, stderr] = await Promise.all([result.exited, result.stderr.text()]);
        if (code !== 0) throw Error('tar.gz extraction failed (tar is required): ' + stderr.slice(0, 500));
    } else if (format === 'zip' && platform === 'win32') {
        const ps = path.join(ROOT, 'config/updates/extract.ps1');
        const result = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, archive, dest],
            { cwd: ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
        const [code, stdout, stderr] = await Promise.all([result.exited, result.stdout.text(), result.stderr.text()]);
        if (code !== 0) throw Error(`ZIP extraction failed: ${(stderr || stdout).slice(0, 1000)}`);
    } else {
        const result = Bun.spawn(['unzip', '-q', archive, '-d', dest], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
        const [code, stderr] = await Promise.all([result.exited, result.stderr.text()]);
        if (code !== 0) throw Error('ZIP extraction requires unzip on this system: ' + stderr.slice(0, 500));
    }
}
async function locate(dir, name) {
    const expected = name === 'PHP' ? (platform === 'win32' ? 'php.exe' : 'php') :
        name === 'MariaDB' ? (platform === 'win32' ? 'mariadbd.exe' : 'mariadbd') : 'index.php';
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        for (const ent of await fsp.readdir(current, { withFileTypes: true })) {
            const full = path.join(current, ent.name);
            if (ent.isDirectory()) stack.push(full);
            else if (ent.isFile() && ent.name.toLowerCase() === expected.toLowerCase()) {
                if (name === 'MariaDB') return path.dirname(path.dirname(full));
                if (name === 'PHP' && platform !== 'win32') {
                    const parent = path.dirname(full);
                    if (path.basename(parent) === 'bin') return path.dirname(parent);
                    // StaticPHP downloads may put a single `php` at archive root.
                    const bin = path.join(parent, 'bin');
                    await fsp.mkdir(bin, { recursive:true });
                    await fsp.rename(full, path.join(bin,'php'));
                    return parent;
                }
                return path.dirname(full);
            }
        }
    }
    throw Error(`Downloaded archive missing ${expected}. No existing module was changed.`);
}
export async function configurePhpMyAdmin(version=getActive('phpMyAdmin')) {
    if (!version) return;
    const dest=modulePath('phpMyAdmin',version);
    if (!fs.existsSync(path.join(dest,'index.php'))) return;
    const configFile=path.join(dest,'config.inc.php');
    const sharedConfig=path.join(ROOT,'config/services/phpmyadmin.php');
    const relative=path.relative(dest,sharedConfig).split(path.sep).join('/');
    const loader=`<?php\n// SQL PORT: shared configuration takes precedence over this module.\nrequire __DIR__ . '/${relative}';\n`;
    const existing=fs.existsSync(configFile) ? await fsp.readFile(configFile,'utf8') : null;
    const port=Number(config.application.port||4096);
    const secret=randomBytes(32).toString('hex');
    const generated=`<?php\n$cfg['blowfish_secret'] = hex2bin('${secret}');\n$cfg['PmaAbsoluteUri'] = 'http://127.0.0.1:${port}/phpmyadmin/';\n$i = 0;\n$i++;\n$cfg['Servers'][$i]['auth_type'] = 'cookie';\n$cfg['Servers'][$i]['host'] = '127.0.0.1';\n$cfg['Servers'][$i]['port'] = '3306';\n$cfg['Servers'][$i]['connect_type'] = 'tcp';\n$cfg['Servers'][$i]['AllowNoPassword'] = false;\n`;
    if (!fs.existsSync(sharedConfig)) {
        // On an upgrade, preserve the existing settings, including custom edits.
        // Fix the old SQL PORT generator's 64-hex-character key while migrating.
        const migrated=(existing && existing!==loader ? existing : generated).replace(
            /(\$cfg\['blowfish_secret'\]\s*=\s*)'([a-f\d]{64})'\s*;/i,
            (_,prefix,hex)=>`${prefix}hex2bin('${hex}');`
        );
        try { await fsp.writeFile(sharedConfig,migrated,{flag:'wx'}); }
        catch(error) { if (error.code!=='EEXIST') throw error; }
    }
    if (existing===loader) return;
    if (existing!==null) {
        // Never silently discard a module's old config when switching to shared settings.
        const backup=configFile+'.before-shared-'+Date.now()+'.bak';
        await fsp.copyFile(configFile,backup,fs.constants.COPYFILE_EXCL);
    }
    await fsp.writeFile(configFile,loader,'utf8');
}
export async function install(name,prepared) {
    if (!prepared?.pkg || prepared.pkg.name!==name || prepared.sameVersion)
        throw Error('Missing or invalid prepared installation');
    const pkg=prepared.pkg;
    const dest=modulePath(name,pkg.version);
    const session=path.join(ROOT,'data','.update-'+name.toLowerCase()+'-'+Date.now());
    const extractDir=path.join(session,'unpacked');
    const archive=path.join(session,'package.'+(pkg.archive==='zip'?'zip':'tar.gz'));
    await fsp.mkdir(session,{recursive:true});
    let committed=false;
    try {
        await download(pkg,archive);
        await extract(archive,extractDir,pkg.archive);
        const payload=await locate(extractDir,name);
        await fsp.mkdir(path.dirname(dest),{recursive:true});
        if (fs.existsSync(dest)) throw Error(`Version ${pkg.version} already exists; refusing to overwrite it`);
        await fsp.rename(payload,dest);
        committed=true;
        if (name==='phpMyAdmin') await configurePhpMyAdmin(pkg.version);
        await registerInstalled(name,pkg.version);
        return {message:`${name} ${pkg.version} installed.`,version:pkg.version};
    } catch(e) {
        if (committed) await fsp.rm(dest,{recursive:true,force:true}).catch(()=>{});
        throw e;
    } finally {await fsp.rm(session,{recursive:true,force:true}).catch(()=>{});}
}
