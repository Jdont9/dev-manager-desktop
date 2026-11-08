/*
 * NCG v2 decryption and IPK repackaging.
 *
 * TypeScript port of ncg/ncg-decrypt.js from https://github.com/lennylxx/lg-ipk-download
 * Copyright lennylxx, licensed under the Apache License 2.0.
 *
 * The algorithm is unchanged. Differences from the original: Uint8Array instead of Buffer,
 * WebCrypto (AES-CTR) instead of node:crypto, CompressionStream instead of node:zlib.
 */

const textLatin1 = (bytes: Uint8Array): string => {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
};

const latin1Bytes = (text: string): Uint8Array => {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
};

const NCG_MAGIC = latin1Bytes('NCGFILE_HEADER');

// 512-byte scatter table (firmware libncg_agent.so.2.0.0, file offset 0x17660).
const TABLE_HEX =
    '080d0e0f040001090e0b0f010d050a0505030f0209060d020b0d05030d09060b' +
    '0a0f080c02050801000a0102060c050106060e060b0501050201010509030b0d' +
    '0f03020b0e050807040e0c0d09010c0c0a060f0309000f07090802020e090508' +
    '0e0b060200020f050d0e0108050f030f050f0c080501020101080e0e0000000e' +
    '090b04070a050507030d0503010602070c0b030004050a0e010806010a07010d' +
    '090f000a060b0b060707030f0500060f080c05070909010b08020a000a040c08' +
    '020306070a07000c0b0100050c0804030d0a020e0d0603010e030a080f0b0900' +
    '08040d050601080c0d090709060f000c03080c0f040f0409090902010a0f0b0b' +
    '0a070901030c07020f0200070d000a0207050f0501030b040b00060b06090a00' +
    '02030a0c0d09010c09070f05050f0e080f060e050c020404080d0d0e0c040f02' +
    '0903020c0a03030606090e09060e0d0d0c02020c0e0f0103010d040207090406' +
    '0b0c0c0b050c030f0c0e0b0407070105000d010509050d0e0907060c03040800' +
    '0f0a0b09080f010b00010f05000200060103040b090404090f090a0900050503' +
    '040f090308050a09040c0b08060e0b0a090c0f07090e0a0d010407020f0b0b0e' +
    '0008030c03010a0a000a080f0205000f0d0e0504050804090007010002070a04' +
    '070f0102050b03070e020f0f0f03070300020d050e090f0909080e07080a0101';

const TABLE: Uint8Array = (() => {
    const out = new Uint8Array(TABLE_HEX.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(TABLE_HEX.substr(i * 2, 2), 16);
    if (out.length !== 512) throw new Error('scatter table is not 512 bytes');
    return out;
})();

export interface CekEntry {
    /** Base64 of the 32-byte CEK: key = first 16 bytes, iv = last 16 bytes. */
    cekB64: string;
    cid: string;
    sid?: string;
}

export function base64ToBytes(value: string): Uint8Array {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

export function isNcg(body: Uint8Array): boolean {
    return body.length >= NCG_MAGIC.length && equalBytes(body.subarray(0, NCG_MAGIC.length), NCG_MAGIC);
}

// ---------------------------------------------------------------------------------------------
// NCG v2 payload algorithm
// ---------------------------------------------------------------------------------------------

export interface NcgHeader {
    bodySize: number;
    cid: string | null;
}

export function parseHeader(buf: Uint8Array): NcgHeader {
    if (!isNcg(buf)) throw new Error('not an NCG v2 file (bad magic)');
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const bodySize = view.getUint32(0x10, true);
    let nul = buf.indexOf(0, 512);
    if (nul === -1 || nul > 1024) nul = Math.min(1024, buf.length);
    const xml = new TextDecoder('utf-8').decode(buf.subarray(512, nul));
    let cid: string | null = null;
    const i = xml.indexOf('<cid>');
    if (i >= 0) {
        const j = xml.indexOf('</cid>', i);
        if (j > i) cid = xml.slice(i + 5, j).trim();
    }
    return {bodySize, cid};
}

export function seedFor(cid: string): number {
    let sum = 0;
    for (const b of new TextEncoder().encode(cid)) sum += b;
    return sum % 16;
}

/** AES-128-CTR keystream, 512 bytes, from the CEK. The counter restarts from the IV every block. */
export async function keystream(cek: Uint8Array): Promise<Uint8Array> {
    if (cek.length !== 32) throw new Error(`expected 32-byte CEK, got ${cek.length}`);
    const key = await crypto.subtle.importKey('raw', cek.slice(0, 16), {name: 'AES-CTR'}, false, ['encrypt']);
    const out = await crypto.subtle.encrypt(
        {name: 'AES-CTR', counter: cek.slice(16, 32), length: 128}, key, new Uint8Array(512));
    return new Uint8Array(out);
}

export function decryptPayload(payload: Uint8Array, ks: Uint8Array, seed: number): Uint8Array {
    const tbl = TABLE.subarray(32 * seed, 32 * seed + 32);
    const n = payload.length;
    const out = new Uint8Array(n);
    const keys = new Uint8Array(32);
    let i = 0;
    while (i + 512 <= n) {
        const block = out.subarray(i, i + 512);
        block.set(payload.subarray(i, i + 512));
        for (let k = 0; k < 32; k++) keys[k] = block[16 * k + tbl[k]];
        for (let j = 0; j < 480; j++) block[j] ^= keys[j % 32];
        for (let k = 0; k < 32; k++) block[16 * k + tbl[k]] = keys[k] ^ ks[k];
        // block[480:512] is stored in the clear
        i += 512;
    }
    for (let j = 0; i + j < n; j++) out[i + j] = payload[i + j] ^ ks[j];
    return out;
}

// ---------------------------------------------------------------------------------------------
// gzip through the platform streams
// ---------------------------------------------------------------------------------------------

async function pipeThrough(data: Uint8Array, stream: { writable: WritableStream; readable: ReadableStream }):
    Promise<Uint8Array> {
    const writer = stream.writable.getWriter();
    const written = writer.write(data as unknown as BufferSource).then(() => writer.close());
    const result = new Response(stream.readable).arrayBuffer();
    await written;
    return new Uint8Array(await result);
}

export const gunzip = (data: Uint8Array) => pipeThrough(data, new DecompressionStream('gzip'));
export const gzip = (data: Uint8Array) => pipeThrough(data, new CompressionStream('gzip'));

// ---------------------------------------------------------------------------------------------
// ar container (IPK)
// ---------------------------------------------------------------------------------------------

const AR_MAGIC = latin1Bytes('!<arch>\n');
const AR_HDR = 60;
const AR_SIZE_OFF = 48;

export interface ArMember {
    hdr: Uint8Array;
    body: Uint8Array;
}

export function arRead(data: Uint8Array): ArMember[] {
    if (!equalBytes(data.subarray(0, 8), AR_MAGIC)) throw new Error('not an ar archive');
    const members: ArMember[] = [];
    let off = 8;
    while (off + AR_HDR <= data.length) {
        const hdr = data.subarray(off, off + AR_HDR);
        if (hdr[58] !== 0x60 || hdr[59] !== 0x0a) throw new Error(`bad ar magic at offset 0x${off.toString(16)}`);
        const size = parseInt(textLatin1(hdr.subarray(AR_SIZE_OFF, AR_SIZE_OFF + 10)).trim(), 10);
        const bodyOff = off + AR_HDR;
        if (!Number.isFinite(size) || bodyOff + size > data.length) {
            throw new Error(`ar member body overruns file at 0x${off.toString(16)}`);
        }
        members.push({hdr, body: data.subarray(bodyOff, bodyOff + size)});
        off = bodyOff + size + (size & 1);
    }
    if (off !== data.length) throw new Error('trailing bytes after last ar member');
    return members;
}

export function arWrite(members: ArMember[]): Uint8Array {
    const out: Uint8Array[] = [AR_MAGIC];
    for (const {hdr, body} of members) {
        out.push(hdr, body);
        if (body.length & 1) out.push(latin1Bytes('\n'));
    }
    return concat(out);
}

export function arMemberName(hdr: Uint8Array): string {
    let name = textLatin1(hdr.subarray(0, 16)).replace(/\s+/g, '');
    if (name.endsWith('/')) name = name.slice(0, -1);
    return name;
}

// ---------------------------------------------------------------------------------------------
// tar (data.tar.gz)
// ---------------------------------------------------------------------------------------------

export interface TarEntry {
    name: string;
    type: string;
    mode: number;
    uid: number;
    gid: number;
    size: number;
    mtime: number;
    linkname: string;
    uname: string;
    gname: string;
    rawHeader: Uint8Array;
    data?: Uint8Array;
    modified?: boolean;
}

function tarOctal(buf: Uint8Array, off: number, len: number): number {
    let s = '';
    for (let i = 0; i < len; i++) {
        const b = buf[off + i];
        if (b === 0 || b === 0x20) break;
        s += String.fromCharCode(b);
    }
    if (s === '') return 0;
    if ((s.charCodeAt(0) & 0x80) !== 0) throw new Error('unsupported GNU base-256 tar field');
    const v = parseInt(s, 8);
    if (Number.isNaN(v)) throw new Error(`bad tar octal field "${s}"`);
    return v;
}

function tarCstr(buf: Uint8Array, off: number, len: number): string {
    let end = buf.indexOf(0, off);
    if (end === -1 || end > off + len) end = off + len;
    return textLatin1(buf.subarray(off, end));
}

export function tarRead(tar: Uint8Array): TarEntry[] {
    const members: TarEntry[] = [];
    let off = 0;
    let pendingName: string | null = null;
    let pendingLink: string | null = null;
    const pad = (size: number) => (512 - (size % 512)) % 512;
    while (off + 512 <= tar.length) {
        const hdr = tar.subarray(off, off + 512);
        if (hdr.every(b => b === 0)) {
            const rest = tar.subarray(off + 512);
            if (rest.length > 0 && rest.some(b => b !== 0)) {
                throw new Error('trailing non-zero bytes after tar EOF blocks');
            }
            return members;
        }
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : hdr[i];
        const chk = tarOctal(hdr, 148, 8);
        if (chk !== sum) throw new Error(`bad tar checksum at offset ${off}`);
        let name = tarCstr(hdr, 0, 100);
        if (textLatin1(hdr.subarray(257, 262)) !== 'ustar') throw new Error(`unsupported tar magic at offset ${off}`);
        const prefix = tarCstr(hdr, 345, 155);
        if (prefix) name = prefix + '/' + name;
        const type = (hdr[156] || 0) === 0 ? '0' : String.fromCharCode(hdr[156]);
        const entry: TarEntry = {
            name, type,
            mode: tarOctal(hdr, 100, 8),
            uid: tarOctal(hdr, 108, 8),
            gid: tarOctal(hdr, 116, 8),
            size: tarOctal(hdr, 124, 12),
            mtime: tarOctal(hdr, 136, 12),
            linkname: tarCstr(hdr, 157, 100),
            uname: tarCstr(hdr, 265, 32),
            gname: tarCstr(hdr, 297, 32),
            rawHeader: hdr.slice(),
        };
        off += 512;
        if (type === 'L' || type === 'K') {
            if (off + entry.size > tar.length) throw new Error('tar long name overruns data');
            const value = textLatin1(tar.subarray(off, off + entry.size));
            if (type === 'L') pendingName = value; else pendingLink = value;
            off += entry.size + pad(entry.size);
            continue;
        }
        if (type === 'x' || type === 'g') throw new Error('pax tar extension is not supported');
        if (type === 'S') throw new Error('sparse tar members are not supported');
        if (pendingName !== null) {
            entry.name = pendingName;
            pendingName = null;
        }
        if (pendingLink !== null) {
            entry.linkname = pendingLink;
            pendingLink = null;
        }
        if (entry.type === '0') {
            if (off + entry.size > tar.length) throw new Error(`tar member ${entry.name} overruns data`);
            entry.data = tar.slice(off, off + entry.size);
            off += entry.size + pad(entry.size);
        }
        members.push(entry);
    }
    if (off !== tar.length) throw new Error('tar data does not end on a block boundary');
    return members;
}

function tarFieldOctal(v: number, len: number): Uint8Array {
    return latin1Bytes(v.toString(8).padStart(len - 1, '0') + '\0');
}

function tarFieldStr(s: string, len: number): Uint8Array {
    const b = latin1Bytes(s);
    if (b.length > len) throw new Error(`tar field too long: "${s}"`);
    const out = new Uint8Array(len);
    out.set(b, 0);
    return out;
}

function tarHeaderFor(entry: TarEntry): Uint8Array {
    const hdr = new Uint8Array(512);
    let name = entry.name;
    let prefix = '';
    if (name.length > 100) {
        const cut = name.lastIndexOf('/', 155);
        if (cut <= 0 || name.length - cut - 1 > 100) throw new Error(`tar name too long and unsplittable: ${name}`);
        prefix = name.slice(0, cut);
        name = name.slice(cut + 1);
    }
    hdr.set(tarFieldStr(name, 100), 0);
    hdr.set(tarFieldOctal(entry.mode, 8), 100);
    hdr.set(tarFieldOctal(entry.uid, 8), 108);
    hdr.set(tarFieldOctal(entry.gid, 8), 116);
    hdr.set(tarFieldOctal(entry.size, 12), 124);
    hdr.set(tarFieldOctal(entry.mtime, 12), 136);
    hdr.fill(0x20, 148, 156);
    hdr[156] = entry.type === '0' ? 0x30 : entry.type.charCodeAt(0);
    hdr.set(tarFieldStr(entry.linkname || '', 100), 157);
    hdr.set(latin1Bytes('ustar\0'), 257);
    hdr.set(latin1Bytes('00'), 263);
    hdr.set(tarFieldStr(entry.uname || '', 32), 265);
    hdr.set(tarFieldStr(entry.gname || '', 32), 297);
    hdr.set(tarFieldStr(prefix, 155), 345);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += hdr[i];
    hdr.set(latin1Bytes(sum.toString(8).padStart(6, '0') + ' \0'), 148);
    return hdr;
}

export function tarWrite(members: TarEntry[]): Uint8Array {
    const out: Uint8Array[] = [];
    for (const m of members) {
        out.push(m.rawHeader && !m.modified ? m.rawHeader : tarHeaderFor(m));
        if (m.data) {
            out.push(m.data);
            const pad = (512 - (m.data.length % 512)) % 512;
            if (pad) out.push(new Uint8Array(pad));
        }
    }
    out.push(new Uint8Array(1024));
    return concat(out);
}

// ---------------------------------------------------------------------------------------------
// IPK level operations
// ---------------------------------------------------------------------------------------------

export interface IpkNcgFile {
    name: string;
    cid: string;
    data: Uint8Array;
}

export interface IpkInfo {
    version: string | null;
    ncgFiles: IpkNcgFile[];
}

async function dataTarMembers(ipk: Uint8Array): Promise<{ members: ArMember[]; entries: TarEntry[] }> {
    const members = arRead(ipk);
    const data = members.find(m => arMemberName(m.hdr) === 'data.tar.gz');
    if (!data) throw new Error('data.tar.gz not found in IPK');
    return {members, entries: tarRead(await gunzip(data.body))};
}

/** Lists the NCG-protected files in an IPK, plus the package version from its control file. */
export async function inspectIpk(ipk: Uint8Array): Promise<IpkInfo> {
    const {members, entries} = await dataTarMembers(ipk);
    const ncgFiles: IpkNcgFile[] = [];
    for (const e of entries) {
        if (e.type !== '0' || !e.data || !isNcg(e.data)) continue;
        const cid = parseHeader(e.data).cid;
        if (cid) ncgFiles.push({name: e.name, cid, data: e.data});
    }
    let version: string | null = null;
    const control = members.find(m => arMemberName(m.hdr) === 'control.tar.gz');
    if (control) {
        for (const e of tarRead(await gunzip(control.body))) {
            if (e.name.endsWith('control') && e.data) {
                for (const line of new TextDecoder().decode(e.data).split('\n')) {
                    if (line.startsWith('Version:')) version = line.slice('Version:'.length).trim();
                }
                break;
            }
        }
    }
    return {version, ncgFiles};
}

/** The NCG file used for the key exchange: an index.html of the app when there is one. */
export function pickNcgFile(info: IpkInfo, appId: string): IpkNcgFile | undefined {
    const prefix = `./usr/palm/applications/${appId}/`;
    const preferred = info.ncgFiles.filter(f => f.name.startsWith(prefix) && f.name.endsWith('/index.html'));
    return (preferred.length ? preferred : info.ncgFiles)[0];
}

function printableRatio(data: Uint8Array, sample = 4096): number {
    const head = data.subarray(0, sample);
    if (!head.length) return 0;
    let text: string;
    try {
        text = new TextDecoder('utf-8', {fatal: true}).decode(head, {stream: head.length < data.length});
    } catch {
        return 0;
    }
    let ok = 0;
    let total = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0)!;
        if ((code >= 32 && (code < 127 || code > 159)) || code === 9 || code === 10 || code === 13) ok++;
        total++;
    }
    return total === 0 ? 0 : ok / total;
}

export interface DecryptResult {
    ipk: Uint8Array;
    replaced: string[];
    warnings: string[];
}

export class MissingCekError extends Error {
    constructor(public cid: string, public file: string) {
        super(`no CEK for ${file} (cid=${cid})`);
    }
}

/**
 * Decrypts every NCG file of the IPK. `findCek` returns the CEK of a content id, or undefined.
 * The result is verified before it is returned: nothing NCG may be left, and every ar member that
 * was not replaced must be byte-identical.
 */
export async function decryptIpk(ipk: Uint8Array, findCek: (cid: string) => CekEntry | undefined):
    Promise<DecryptResult> {
    const {members, entries} = await dataTarMembers(ipk);
    const keystreams = new Map<string, Uint8Array>();
    const replaced: string[] = [];
    const warnings: string[] = [];
    for (const m of entries) {
        if (m.type !== '0' || !m.data || !isNcg(m.data)) continue;
        const {bodySize, cid} = parseHeader(m.data);
        if (!cid) throw new Error(`${m.name}: NCG header has no <cid>`);
        let ks = keystreams.get(cid);
        if (!ks) {
            const cek = findCek(cid);
            if (!cek) throw new MissingCekError(cid, m.name);
            ks = await keystream(base64ToBytes(cek.cekB64));
            keystreams.set(cid, ks);
        }
        const dec = decryptPayload(m.data.subarray(512 + bodySize), ks, seedFor(cid));
        if (isNcg(dec)) throw new Error(`${m.name}: output still starts with the NCG magic (wrong CEK?)`);
        if (printableRatio(dec) < 0.9 && /\.(html?|js|css|json|txt)$/i.test(m.name)) {
            warnings.push(`${m.name} decrypted but does not look like text`);
        }
        m.data = dec;
        m.size = dec.length;
        m.modified = true;
        replaced.push(m.name);
    }
    if (!replaced.length) throw new Error('no NCG files found in data.tar.gz');

    const gz = await gzip(tarWrite(entries));
    const out: ArMember[] = members.map(({hdr, body}) => {
        if (arMemberName(hdr) !== 'data.tar.gz') return {hdr, body};
        const sizeHdr = hdr.slice();
        sizeHdr.fill(0x20, AR_SIZE_OFF, AR_SIZE_OFF + 10);
        sizeHdr.set(latin1Bytes(String(gz.length).padEnd(10, ' ')), AR_SIZE_OFF);
        return {hdr: sizeHdr, body: gz};
    });
    const result = arWrite(out);

    // Verify the repacked archive end to end.
    const check = await dataTarMembers(result);
    let left = 0;
    for (const e of check.entries) if (e.type === '0' && e.data && isNcg(e.data)) left++;
    if (left) throw new Error(`${left} members still NCG-encrypted after decryption`);
    const original = new Map(members.map(m => [arMemberName(m.hdr), m.body]));
    for (const m of check.members) {
        const name = arMemberName(m.hdr);
        if (name !== 'data.tar.gz' && !equalBytes(original.get(name) ?? new Uint8Array(), m.body)) {
            throw new Error(`${name} differs from the input but was not replaced`);
        }
    }
    return {ipk: result, replaced, warnings};
}
