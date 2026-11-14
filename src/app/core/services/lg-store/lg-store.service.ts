/*
 * Download apps from the LG Content Store through the TV, as IPK files.
 *
 * Based on https://github.com/lennylxx/lg-ipk-download (Apache License 2.0). The two scripts that
 * run on the TV (assets/lg-store/download-ipk.js and ro-exchange.js) are the original files,
 * except download-ipk.js, which also tries a registered LS2 identity (--service-id); this
 * service does what the original `lg-ipk` command line does on a computer, but through the SSH
 * connection the app already has to the TV, so that it also works on Android. Nothing is installed.
 *
 * The NCG key exchange no longer runs over SSH: on webOS 11 (fw 43.x) every palmbus handle
 * created outside an LS2-launched process crashes the native module
 * ("basic_string::_S_construct null not valid"). fetchCek() therefore installs a small LS2
 * helper service (com.webos.devman.sdx, built on the fly from assets/lg-store/tv/) and calls
 * luna://com.webos.devman.sdx/exchange through RemoteLunaService.
 */
import {Injectable} from '@angular/core';
import {readFile, writeFile} from '@tauri-apps/plugin-fs';
import {Device} from '../../../types';
import {RemoteCommandService} from '../remote-command.service';
import {RemoteFileService} from '../remote-file.service';
import {RemoteLunaService} from '../remote-luna.service';
import {AppManagerService, InstallProgressHandler} from '../app-manager.service';
import {LocalFileService} from '../local-file.service';
import {buildIpk, TarEntry} from './ipk';
import {
    base64ToBytes,
    CekEntry,
    decryptIpk,
    inspectIpk,
    IpkInfo,
    MissingCekError,
    pickNcgFile,
} from './ncg';

const NODE_ENV = 'NODE_PATH=/usr/lib/node_modules:/usr/lib/nodejs';
/** /tmp is not writable by the devmode user on recent webOS; this folder is. */
const TV_TEMP_DIR = '/media/developer/temp';
const RO_WORK_DIR = `${TV_TEMP_DIR}/ncgrow`;
const CEK_STORAGE_KEY = 'lgstore.ceks';
/** Registered LS2 identity the ro-exchange helper falls back to when the anonymous private
 * palmbus handle is rejected (webOS 11 / fw 43.x). The app grants it SDX access itself. */
const SDX_SERVICE_ID = 'com.webos.devman.sdx';
/** Host app id of the bundled LS2 helper service package. */
const SDX_APP_ID = 'com.webos.devman.sdx.app';

export interface StoreApp {
    id: string;
    name: string;
}

export interface StoreOptions {
    /** Two-letter store country. Empty: the TV's own region. */
    country?: string;
    /** Allow one live Right Object exchange with LG (from the TV) when a protected app has no cached key. */
    fetchCek: boolean;
}

export interface StoreDownload {
    appId: string;
    version: string;
    /** Suggested file name, e.g. `com.example.app_1.2.3.ipk`. */
    fileName: string;
    /** Temporary local file holding the IPK. Remove it with `discard()` once it is saved. */
    tempPath: string;
    /** True when the package was NCG-protected and has been decrypted. */
    decrypted: boolean;
    warnings: string[];
}

interface DownloadInfo {
    ok: true;
    appId: string;
    packageVersion: string;
    expectedSize: number;
    remotePath: string;
}

export class StoreError extends Error {
    constructor(message: string, public detail?: string) {
        super(detail ? `${message}: ${detail}` : message);
    }
}

const shellQuote = (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function parseJsonLines(output: string): any[] {
    const docs: any[] = [];
    for (const line of output.split(/\r?\n/)) {
        const text = line.trim();
        if (!text.startsWith('{')) continue;
        try {
            const doc = JSON.parse(text);
            if (doc && typeof doc === 'object') docs.push(doc);
        } catch {
            // Not the machine-readable line (the TV libraries can log into stdout).
        }
    }
    return docs;
}

function normalizeCountry(country?: string): string | undefined {
    const value = (country ?? '').trim();
    if (!value) return undefined;
    if (!/^(?:[A-Za-z]{2}|C01)$/.test(value)) {
        throw new StoreError('The country must be a two-letter code such as FR, US or DE');
    }
    const upper = value.toUpperCase();
    return upper === 'C01' ? 'CN' : upper;
}

/** CEKs obtained from LG, kept on this device only. */
class CekCache {
    private static load(): Record<string, CekEntry[]> {
        try {
            return JSON.parse(localStorage.getItem(CEK_STORAGE_KEY) ?? '{}');
        } catch {
            return {};
        }
    }

    static find(appId: string, cid: string): CekEntry | undefined {
        const all = CekCache.load();
        const ordered = [appId, ...Object.keys(all).filter(k => k !== appId)];
        for (const app of ordered) {
            const hit = (all[app] ?? []).find(e => e.cid === cid);
            if (hit) return hit;
        }
        return undefined;
    }

    static add(appId: string, entry: CekEntry): void {
        try {
            const all = CekCache.load();
            all[appId] = [...(all[appId] ?? []).filter(e => e.cid !== entry.cid), entry];
            localStorage.setItem(CEK_STORAGE_KEY, JSON.stringify(all));
        } catch (e) {
            console.warn('Could not cache the CEK', e);
        }
    }
}

@Injectable({
    providedIn: 'root'
})
export class LgStoreService {

    constructor(private cmd: RemoteCommandService, private file: RemoteFileService,
                private localFile: LocalFileService, private luna: RemoteLunaService,
                private appManager: AppManagerService) {
    }

    /** Searches the store. Needs Developer Mode and Node.js on the TV (already there on webOS). */
    async search(device: Device, keyword: string, country?: string): Promise<StoreApp[]> {
        const args = ['--api-version', '10.0.0', '--timeout', '60', '--service-id', SDX_SERVICE_ID];
        const cc = normalizeCountry(country);
        if (cc) args.push('--country', cc);
        args.push('--search', keyword);
        const response = await this.withHelper(device, 'download-ipk.js', helper => this.runHelper(device, helper, args));
        return (response['apps'] ?? []) as StoreApp[];
    }

    /**
     * Downloads an app from the store through the TV and decrypts it when needed. Nothing is
     * installed: the IPK is left in a temporary file, which the caller saves and then discards.
     */
    async download(device: Device, appId: string, options: StoreOptions,
                   progress: InstallProgressHandler): Promise<StoreDownload> {
        const country = normalizeCountry(options.country);
        const temps: string[] = [];
        let keep = false;
        try {
            // 1. The TV downloads the package from LG, with its own device credentials.
            progress(undefined, 'Asking the LG store...');
            const args = ['--api-version', '10.0.0', '--timeout', '180', '--app-id', appId,
                '--service-id', SDX_SERVICE_ID];
            if (country) args.push('--country', country);
            const info = await this.withHelper(device, 'download-ipk.js',
                helper => this.runHelper(device, helper, args)) as unknown as DownloadInfo;

            // 2. Bring it here.
            const localPath = await this.localFile.tempPath('.ipk');
            temps.push(localPath);
            try {
                await this.file.get(device, info.remotePath, localPath, (copied, total) =>
                    progress(total ? copied / total * 100 : undefined, 'Transferring the package...'));
            } finally {
                await this.cmd.exec(device, `rm -f -- ${shellQuote(info.remotePath)}`, 'utf-8')
                    .catch(e => console.warn('Could not clean the TV download', e));
            }
            const bytes = await readFile(localPath);
            if (bytes.length !== info.expectedSize) {
                throw new StoreError('Incomplete download',
                    `expected ${info.expectedSize} bytes, received ${bytes.length}`);
            }

            // 3. Decrypt NCG-protected content, if any.
            progress(undefined, 'Checking the package...');
            const ipkInfo = await inspectIpk(bytes);
            let tempPath = localPath;
            let decrypted = false;
            let warnings: string[] = [];
            if (ipkInfo.ncgFiles.length) {
                const result = await this.decrypt(device, appId, bytes, ipkInfo, country, options, progress);
                tempPath = await this.localFile.tempPath('.ipk');
                temps.push(tempPath);
                await writeFile(tempPath, result.ipk);
                decrypted = true;
                warnings = result.warnings;
            }
            const safeVersion = String(info.packageVersion).replace(/[^A-Za-z0-9._-]/g, '_');
            keep = true;
            // The original tool names a decrypted package `<name>_dec.ipk`.
            const fileName = `${info.appId}_${safeVersion}${decrypted ? '_dec' : ''}.ipk`;
            // Only the file that is handed over stays; the other one (encrypted original) goes.
            for (const path of temps.filter(p => p !== tempPath)) {
                await this.localFile.remove(path).catch(() => undefined);
            }
            return {appId: info.appId, version: info.packageVersion, fileName, tempPath, decrypted, warnings};
        } finally {
            if (!keep) {
                for (const path of temps) {
                    await this.localFile.remove(path).catch(() => undefined);
                }
            }
        }
    }

    /** Copies a downloaded IPK to the place the user picked. */
    async save(download: StoreDownload, target: string, progress?: InstallProgressHandler): Promise<void> {
        await this.localFile.copy(download.tempPath, target, (copied, total) =>
            progress?.(total ? copied / total * 100 : undefined, 'Saving the file...'));
    }

    /** Removes the temporary file of a download. */
    async discard(download: StoreDownload): Promise<void> {
        await this.localFile.remove(download.tempPath).catch(() => undefined);
    }

    private async decrypt(device: Device, appId: string, bytes: Uint8Array, ipkInfo: IpkInfo,
                          country: string | undefined, options: StoreOptions, progress: InstallProgressHandler) {
        const find = (cid: string) => CekCache.find(appId, cid);
        const missing = ipkInfo.ncgFiles.filter(f => !find(f.cid));
        if (missing.length) {
            if (!options.fetchCek) {
                throw new StoreError('This app is protected (NCG) and no decryption key is cached. ' +
                    'Enable "Fetch the decryption key" to let the TV request it from LG once');
            }
            progress(undefined, 'Requesting the decryption key from LG (one request)...');
            await this.fetchCek(device, appId, ipkInfo, country, progress);
        }
        progress(undefined, 'Decrypting the package...');
        try {
            return await decryptIpk(bytes, find);
        } catch (e) {
            if (e instanceof MissingCekError) {
                throw new StoreError('The key exchange did not provide a key for every protected file', e.message);
            }
            throw e;
        }
    }

    /**
     * One live Right Object exchange, performed on the TV by the com.webos.devman.sdx LS2
     * service and the TV's own libncg_agent (see assets/lg-store/tv/). The service is installed
     * on demand: on webOS 11 (fw 43.x) no palmbus handle works from an SSH session, so the
     * exchange must run inside an LS2-launched process.
     * Keep this rare: repeated requests from one device risk it being blocked by LG.
     */
    private async fetchCek(device: Device, appId: string, ipkInfo: IpkInfo,
                           country?: string, progress?: InstallProgressHandler): Promise<void> {
        const picked = pickNcgFile(ipkInfo, appId);
        if (!picked) throw new StoreError('No NCG file found in the package');
        if (!ipkInfo.version) throw new StoreError('Could not determine the package version');
        const addonResponse = await fetch('assets/lg-store/ncg_native.node');
        if (!addonResponse.ok) {
            throw new StoreError('The TV key addon (ncg_native.node) is not bundled in this build',
                'see src/assets/lg-store/README.md');
        }
        const addon = new Uint8Array(await addonResponse.arrayBuffer());
        const base = picked.name.split('/').pop() ?? 'index.html';
        const toBytes = (data: Uint8Array | string) =>
            Array.from(typeof data === 'string' ? new TextEncoder().encode(data) : data);

        try {
            await this.ensureExchangeService(device, progress);
            await this.cmd.exec(device, `rm -rf ${RO_WORK_DIR} && mkdir -p ${RO_WORK_DIR}/files ${RO_WORK_DIR}/secret`, 'utf-8');
            await this.write(device, `${RO_WORK_DIR}/ncg_native.node`, toBytes(addon));
            await this.write(device, `${RO_WORK_DIR}/files/${base}`, toBytes(picked.data));

            const params: Record<string, unknown> = {
                addonPath: `${RO_WORK_DIR}/ncg_native.node`,
                appId,
                appVersion: ipkInfo.version,
                verifyFile: `${RO_WORK_DIR}/files/${base}`,
                secretDir: `${RO_WORK_DIR}/secret`,
            };
            if (country) params['country'] = country;
            const resp = await this.luna.call(device, `luna://${SDX_SERVICE_ID}/exchange`, params, false);
            if (!resp || resp['ok'] !== true) {
                throw new StoreError('The key exchange failed',
                    resp ? `stage ${resp['stage']}: ${resp['error']}` : 'empty answer from the TV service');
            }
            const cekB64 = resp['cek']?.['b64'] as string | undefined;
            const sid = resp['sid'] as string | undefined;
            if (!cekB64 || base64ToBytes(cekB64).length !== 32) {
                throw new StoreError('Unexpected key size from the TV');
            }
            // The cache is keyed by the content id of the NCG files, like the original tool does.
            CekCache.add(appId, {cid: picked.cid, cekB64, sid});
            const cekCid = resp['cek']?.['cid'] as string | undefined;
            if (cekCid && cekCid !== picked.cid) {
                CekCache.add(appId, {cid: cekCid, cekB64, sid});
            }
        } finally {
            await this.cmd.exec(device, `rm -rf ${RO_WORK_DIR}`, 'utf-8')
                .catch(e => console.warn('Could not clean the key exchange files', e));
        }
    }

    /** Installs the bundled LS2 helper service once per device; later calls reuse it. */
    private async ensureExchangeService(device: Device, progress?: InstallProgressHandler): Promise<void> {
        const installed = await this.appManager.info(device, SDX_APP_ID).catch(() => null);
        if (installed) return;
        progress?.(undefined, 'Installing the TV helper service...');
        const files: TarEntry[] = [];
        const add = async (path: string, asset: string) =>
            files.push({path, data: new TextEncoder().encode(await this.asset(asset))});
        await add('/usr/palm/applications/com.webos.devman.sdx.app/appinfo.json', 'tv/appinfo.json');
        await add('/usr/palm/applications/com.webos.devman.sdx.app/index.html', 'tv/index.html');
        await add('/usr/palm/services/com.webos.devman.sdx/index.js', 'tv/index.js');
        await add('/usr/palm/services/com.webos.devman.sdx/package.json', 'tv/package.json');
        await add('/usr/palm/services/com.webos.devman.sdx/services.json', 'tv/services.json');
        await add('/usr/share/luna-service2/manifests.d/com.webos.devman.sdx.manifest.json', 'tv/manifest.json');
        await add('/usr/share/luna-service2/roles.d/com.webos.devman.sdx.role.json', 'tv/role.json');
        await add('/usr/share/luna-service2/client-permissions.d/com.webos.devman.sdx.perm.json', 'tv/perm.json');
        await add('/usr/share/luna-service2/services.d/com.webos.devman.sdx.service', 'tv/service-file');
        const control = 'Package: com.webos.devman.sdx.app\n' +
            'Version: 1.0.0\nSection: webos\nArchitecture: all\n' +
            'Maintainer: Jdont9\n' +
            'Description: LG store key exchange helper for webOS Dev Manager\n';
        const localPath = await this.localFile.tempPath('.ipk');
        await writeFile(localPath, buildIpk({control, files}));
        try {
            await this.appManager.installByPath(device, localPath);
        } finally {
            await this.localFile.remove(localPath).catch(() => undefined);
        }
    }

    /** Pushes one of the original helper scripts to the TV, runs `fn`, and removes it. */
    private async withHelper<T>(device: Device, asset: string, fn: (remotePath: string) => Promise<T>): Promise<T> {
        const remote = `${TV_TEMP_DIR}/lg-ipk-${self.crypto.randomUUID()}.js`;
        const script = await this.asset(asset);
        await this.write(device, remote, Array.from(new TextEncoder().encode(script)));
        try {
            return await fn(remote);
        } finally {
            await this.cmd.exec(device, `rm -f -- ${shellQuote(remote)}`, 'utf-8')
                .catch(e => console.warn('Could not remove the TV helper', e));
        }
    }

    private async runHelper(device: Device, remotePath: string, args: string[]): Promise<Record<string, any>> {
        // `|| true`: the helper reports failures as a JSON line plus a non-zero exit status.
        const command = `${NODE_ENV} node ${shellQuote(remotePath)} ${args.map(shellQuote).join(' ')} || true`;
        const output = await this.cmd.exec(device, command, 'utf-8', undefined, true);
        const docs = parseJsonLines(output.stdout);
        const doc = docs[docs.length - 1];
        if (!doc) {
            throw new StoreError('The TV did not answer', (output.stderr || output.stdout).trim().slice(-300) || undefined);
        }
        if (!doc['ok']) {
            throw new StoreError(String(doc['error'] ?? 'The TV request failed'), doc['detail'] ?? undefined);
        }
        return doc;
    }

    private async asset(name: string): Promise<string> {
        const response = await fetch(`assets/lg-store/${name}`);
        if (!response.ok) throw new StoreError(`Missing bundled file ${name}`);
        return response.text();
    }

    private async write(device: Device, path: string, content: number[]): Promise<void> {
        // The backend expects a byte array; this is the same encoding RemoteCommandService uses for stdin.
        await this.file.write(device, path, content as unknown as Uint8Array);
    }
}
