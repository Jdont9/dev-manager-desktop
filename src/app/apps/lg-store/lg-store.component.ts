import {ChangeDetectionStrategy, Component, NgZone} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgbActiveModal, NgbProgressbar} from '@ng-bootstrap/ng-bootstrap';
import {save as showSaveDialog} from '@tauri-apps/plugin-dialog';
import {Device} from '../../types';
import {defaultDownloadDir} from '../../shared/paths';
import {LgStoreService, StoreApp, StoreDownload} from '../../core/services/lg-store/lg-store.service';

/**
 * Searches the LG Content Store through the TV and saves an app's IPK file. Nothing is installed.
 * See core/services/lg-store/lg-store.service.ts.
 */
@Component({
    selector: 'app-lg-store',
    imports: [FormsModule, NgbProgressbar],
    templateUrl: './lg-store.component.html',
    changeDetection: ChangeDetectionStrategy.Eager,
})
export class LgStoreComponent {
    /** Set by the opener. */
    device!: Device;

    keyword = '';
    country = '';
    fetchCek = false;

    results: StoreApp[] | null = null;
    busy = false;
    status?: string;
    progress?: number;
    error?: string;
    success?: string;

    constructor(public modal: NgbActiveModal, private store: LgStoreService, private zone: NgZone) {
    }

    async search(): Promise<void> {
        const keyword = this.keyword.trim();
        if (!keyword || this.busy) return;
        this.begin('Searching the LG store...');
        try {
            this.results = await this.store.search(this.device, keyword, this.country);
        } catch (e) {
            this.fail(e);
        } finally {
            this.busy = false;
            this.status = undefined;
        }
    }

    async download(app: StoreApp): Promise<void> {
        if (this.busy) return;
        this.begin(`Preparing ${app.name}...`);
        let result: StoreDownload | undefined;
        try {
            result = await this.store.download(this.device, app.id,
                {country: this.country, fetchCek: this.fetchCek},
                (progress, text) => this.zone.run(() => {
                    this.progress = progress;
                    if (text) this.status = text;
                }));
            this.status = 'Choose where to save the file...';
            this.progress = undefined;
            const dir = await defaultDownloadDir();
            const target = await showSaveDialog({
                defaultPath: dir ? `${dir.replace(/[\\/]$/, '')}/${result.fileName}` : result.fileName,
                filters: [{name: 'IPK package', extensions: ['ipk']}],
            });
            if (!target) return;
            await this.store.save(result, target, (progress, text) => this.zone.run(() => {
                this.progress = progress;
                if (text) this.status = text;
            }));
            this.success = `${app.name} ${result.version} saved as ${result.fileName}` +
                (result.decrypted ? ' (protected content decrypted).' : '.') +
                (result.warnings.length ? ` Warnings: ${result.warnings.join('; ')}` : '');
        } catch (e) {
            this.fail(e);
        } finally {
            if (result) await this.store.discard(result);
            this.busy = false;
            this.status = undefined;
            this.progress = undefined;
        }
    }

    private begin(status: string): void {
        this.busy = true;
        this.status = status;
        this.progress = undefined;
        this.error = undefined;
        this.success = undefined;
    }

    private fail(e: unknown): void {
        console.warn(e);
        this.error = e instanceof Error ? e.message : String(e);
    }
}
