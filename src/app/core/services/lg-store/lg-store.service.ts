/*
 * Download apps from the LG Content Store through the TV, as IPK files.
 *
 * Based on https://github.com/lennylxx/lg-ipk-download (Apache License 2.0). The two scripts that
 * run on the TV (assets/lg-store/download-ipk.js and ro-exchange.js) are the original files; this
 * service does what the original `lg-ipk` command line does on a computer, but through the SSH
 * connection the app already has to the TV, so that it also works on Android. Nothing is installed.
 */
import {Injectable} from '@angular/core';
import {readFile, writeFile} from '@tauri-apps/plugin-fs';
import {Device} from '../../../types';
import {RemoteCommandService} from '../remote-command.service';
import {RemoteFileService} from '../remote-file.service';
import {LocalFileService} from '../local-file.service';
import {InstallProgressHandler} from '../app-manager.service';
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
const RO_WORK_DIR = '/tmp/ncgrow';
const CEK_STORAGE_KEY = 'lgstore.ceks';

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
                private localFile: LocalFileService) {
    }

    /** Searches the store. Needs Developer Mode and Node.js on the TV (already there on webOS). */
    async search(device: Device, keyword: string, country?: string): Promise<StoreApp[]> {
        const args = ['--api-version', '10.0.0', '--timeout', '60'];
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
            const args = ['--api-version', '10.0.0', '--timeout', '180', '--app-id', appId];
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
            await this.fetchCek(device, appId, ipkInfo, country);
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
     * One live Right Object exchange, run on the TV by ro-exchange.js and the TV's own libncg_agent.
     * Needs the prebuilt TV addon at assets/lg-store/ncg_native.node (see assets/lg-store/README.md).
     * Keep this rare: repeated requests from one device risk it being blocked by LG.
     */
    private async fetchCek(device: Device, appId: string, ipkInfo: IpkInfo, country?: string): Promise<void> {
        const picked = pickNcgFile(ipkInfo, appId);
        if (!picked) throw new StoreError('No NCG file found in the package');
        if (!ipkInfo.version) throw new StoreError('Could not determine the package version');
        const addonResponse = await fetch('assets/lg-store/ncg_native.node');
        if (!addonResponse.ok) {
            throw new StoreError('The TV key addon (ncg_native.node) is not bundled in this build',
                'see src/assets/lg-store/README.md');
        }
        const addon = new Uint8Array(await addonResponse.arrayBuffer());
        const driver = await this.asset('ro-exchange.js');
        const base = picked.name.split('/').pop() ?? 'index.html';
        const toBytes = (data: Uint8Array | string) =>
            Array.from(typeof data === 'string' ? new TextEncoder().encode(data) : data);

        try {
            await this.cmd.exec(device, `rm -rf ${RO_WORK_DIR} && mkdir -p ${RO_WORK_DIR}/files ${RO_WORK_DIR}/secret`, 'utf-8');
            await this.write(device, `${RO_WORK_DIR}/ro-exchange.js`, toBytes(driver));
            await this.write(device, `${RO_WORK_DIR}/ncg_native.node`, toBytes(addon));
            await this.write(device, `${RO_WORK_DIR}/files/${base}`, toBytes(picked.data));

            const args = [
                '--addon', `${RO_WORK_DIR}/ncg_native.node`,
                '--app-id', appId,
                '--version', ipkInfo.version,
                '--verify-file', `${RO_WORK_DIR}/files/${base}`,
            ];
            if (country) args.push('--country', country);
            const command = `rm -f /var/log/ncgdrm-*.log 2>/dev/null; ${NODE_ENV} node ` +
                `${RO_WORK_DIR}/ro-exchange.js ${args.map(shellQuote).join(' ')} || true`;
            const output = await this.cmd.exec(device, command, 'utf-8', undefined, true);
            const doc = parseJsonLines(output.stdout)[0];

            let cekB64: string | undefined = doc?.ok ? doc.cek?.b64 : undefined;
            const sid: string | undefined = doc?.ok ? doc.sid : undefined;
            if (!cekB64) {
                // The library logs the CEK as it parses the response; used when the driver died late.
                const grep = await this.cmd.exec(device,
                    `grep -hoE '<cek>[A-Za-z0-9+/]{43}=</cek>' /var/log/ncgdrm-*.log 2>/dev/null | head -1`,
                    'utf-8', undefined, true).catch(() => undefined);
                cekB64 = grep?.stdout.match(/[A-Za-z0-9+/]{43}=/)?.[0];
            }
            if (!cekB64) {
                const why = doc && !doc.ok ? `stage ${doc.stage}: ${doc.error}` : 'no answer from the TV driver';
                throw new StoreError('The key exchange failed', why);
            }
            if (base64ToBytes(cekB64).length !== 32) throw new StoreError('Unexpected key size from the TV');
            // The cache is keyed by the content id of the NCG files, like the original tool does.
            CekCache.add(appId, {cid: picked.cid, cekB64, sid});
            if (doc?.cek?.cid && doc.cek.cid !== picked.cid) {
                CekCache.add(appId, {cid: doc.cek.cid, cekB64, sid});
            }
        } finally {
            await this.cmd.exec(device, `rm -rf ${RO_WORK_DIR}`, 'utf-8')
                .catch(e => console.warn('Could not clean the key exchange files', e));
        }
    }

    /** Pushes one of the original helper scripts to the TV, runs `fn`, and removes it. */
    private async withHelper<T>(device: Device, asset: string, fn: (remotePath: string) => Promise<T>): Promise<T> {
        const remote = `/tmp/lg-ipk-${self.crypto.randomUUID()}.js`;
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
