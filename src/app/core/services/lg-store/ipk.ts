/*
 * Minimal IPK (Debian-style package) builder, enough for the small TV helper
 * package. Pure TypeScript: ustar tar archives, gzip with stored (uncompressed)
 * deflate blocks, and the ar container. Nothing is actually compressed, but the
 * produced files are valid IPKs opkg and appinstalld accept.
 *
 * The output mirrors what real LG/webOS IPKs look like, because appinstalld is
 * picky: data.tar.gz entries are relative ("./usr/palm/..."), every parent
 * directory is listed explicitly as a tar directory entry, and ar header fields
 * are space-padded like GNU ar does.
 */

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function octal(value: number, digits: number): string {
    return value.toString(8).padStart(digits, '0') + '\0';
}

/** Space-padded fixed-width text field, like GNU ar and tar write them. */
function padField(text: string, length: number): string {
    if (text.length > length) throw new Error('field too long: ' + text);
    return text.padEnd(length, ' ');
}

export interface TarEntry {
    path: string;
    data?: Uint8Array;
    /** Entry type: '0' file (default), '5' directory. */
    type?: '0' | '5';
    mode?: number;
}

/** "./usr/palm/x" style relative path, whatever the caller wrote. */
function normalizePath(path: string): string {
    let name = path.replace(/\/+/, '/');
    while (name.startsWith('/')) name = name.slice(1);
    if (name === '') throw new Error('empty tar path');
    if (!name.startsWith('./')) name = './' + name;
    return name;
}

function tarHeaderFor(name: string, type: '0' | '5', mode: number, size: number): Uint8Array {
    const header = new Uint8Array(512);
    const put = (text: string, offset: number, length: number) =>
        header.set(encoder.encode(text).subarray(0, length), offset);
    if (name.length > 100) throw new Error('Tar path too long: ' + name);
    put(name, 0, 100);
    put(octal(mode, 7), 100, 8);
    put(octal(0, 7), 108, 8);
    put(octal(0, 7), 116, 8);
    put(octal(size, 11), 124, 12);
    put(octal(0, 11), 136, 12);
    put('        ', 148, 8); // checksum placeholder: spaces
    header[156] = type === '5' ? 0x35 : 0x30;
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    put('root', 265, 8);
    put('root', 297, 8);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(octal(sum, 6) + ' ', 148, 8);
    return header;
}

/** Writes a ustar archive (two trailing zero blocks included). */
export function tar(entries: TarEntry[]): Uint8Array {
    const blocks: Uint8Array[] = [];
    const emittedDirs = new Set<string>();
    const emitDir = (dir: string) => {
        // "./usr/palm/applications/" -> also emit "./usr/" and "./usr/palm/" first.
        if (dir === './' || emittedDirs.has(dir)) return;
        emittedDirs.add(dir);
        const parent = dir.slice(0, dir.lastIndexOf('/', dir.length - 2) + 1);
        if (parent) emitDir(parent);
        blocks.push(tarHeaderFor(dir, '5', 0o755, 0));
    };
    for (const entry of entries) {
        const isDir = entry.type === '5';
        const name = normalizePath(isDir && !entry.path.endsWith('/') ? entry.path + '/' : entry.path);
        if (isDir) {
            emitDir(name);
            continue;
        }
        const slash = name.lastIndexOf('/');
        if (slash > 0) emitDir(name.slice(0, slash + 1));
        const size = entry.data?.length ?? 0;
        blocks.push(tarHeaderFor(name, '0', entry.mode ?? 0o644, size));
        if (entry.data) {
            blocks.push(entry.data);
            const padding = (512 - (entry.data.length % 512)) % 512;
            if (padding) blocks.push(new Uint8Array(padding));
        }
    }
    blocks.push(new Uint8Array(1024));
    return concat(blocks);
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Valid gzip stream using stored (uncompressed) deflate blocks. */
export function gzipStore(data: Uint8Array): Uint8Array {
    const parts: Uint8Array[] = [
        new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]),
    ];
    if (data.length === 0) {
        parts.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]));
    }
    let offset = 0;
    while (offset < data.length) {
        const length = Math.min(65535, data.length - offset);
        const isFinal = offset + length >= data.length ? 1 : 0;
        const head = new Uint8Array(5);
        head[0] = isFinal;
        head[1] = length & 0xFF;
        head[2] = (length >>> 8) & 0xFF;
        head[3] = (~length) & 0xFF;
        head[4] = ((~length) >>> 8) & 0xFF;
        parts.push(head, data.subarray(offset, offset + length));
        offset += length;
    }
    const trailer = new Uint8Array(8);
    const view = new DataView(trailer.buffer);
    view.setUint32(0, crc32(data), true);
    view.setUint32(4, data.length, true);
    parts.push(trailer);
    return concat(parts);
}

/** ar archive, the IPK container format (GNU ar style: space-padded fields). */
export function ar(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const file of files) {
        const header = new Uint8Array(60);
        const put = (text: string, offset: number, length: number) =>
            header.set(encoder.encode(padField(text, length)).subarray(0, length), offset);
        put(file.name + '/', 0, 16);
        put('0', 16, 12); // mtime
        put('0', 28, 6); // uid
        put('0', 34, 6); // gid
        put('100644', 40, 8); // mode
        put(String(file.data.length), 48, 10); // size
        header[58] = 0x60;
        header[59] = 0x0a; // magic
        parts.push(header, file.data);
        if (file.data.length % 2) parts.push(new Uint8Array([0x0a]));
    }
    return concat(parts);
}

export interface IpkInput {
    /** debian control file content */
    control: string;
    /** data.tar entries, absolute paths as they will land on the TV */
    files: TarEntry[];
}

export function buildIpk(input: IpkInput): Uint8Array {
    return ar([
        { name: 'debian-binary', data: encoder.encode('2.0\n') },
        { name: 'control.tar.gz', data: gzipStore(tar([{ path: './control', data: encoder.encode(input.control) }])) },
        { name: 'data.tar.gz', data: gzipStore(tar(input.files)) },
    ]);
}
