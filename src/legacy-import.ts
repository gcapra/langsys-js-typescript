/**
 * MIG-9: the one-time import of the translations an app already has.
 *
 * Before an app on legacy keys deletes its other languages' files, each key's
 * source value is registered with that key's translation in every target file,
 * through the `translations` list on `POST /translatable-items`. Langsys stores
 * them as human translations, so they show at once and are never machine
 * translated. Run once, from a developer's machine or a build step, with a key
 * that can write: never from the browser.
 *
 * `buildLegacyImport` is pure and decides what is sent; `importLegacyTranslations`
 * sends it in batches and adds up the API's answers.
 */
import { stripC0Controls } from './identity.js';
import { createLegacyKeys, type LegacyKeyFile } from './legacy-keys.js';
import { canonicalizeLocale } from './locale.js';

/** Why a key's translation for a locale is not sent. */
export type LegacyImportSkipReason = 'missing' | 'empty' | 'not_converted';

export interface LegacyImportSkip {
    key: string;
    locale: string;
    reason: LegacyImportSkipReason;
}

/** One phrase item as `POST /translatable-items` takes it. */
export interface LegacyImportItem {
    type: 'phrase';
    phrase: string;
    category: string | null;
    translations: Array<{ locale: string; translation: string }>;
}

export interface LegacyImportPlan {
    items: LegacyImportItem[];
    skipped: LegacyImportSkip[];
}

export interface LegacyImportOptions {
    projectid: string;
    /** A key that can write. A public read key is refused by the API. */
    key: string;
    /** The source language's files, as `legacyKeys` takes them in `init()`. */
    source: LegacyKeyFile[];
    /** Each target locale's files, in the same formats: `{ 'es-es': [{ name: 'es.json', format: 'i18next', data: es }] }`. */
    targets: Record<string, LegacyKeyFile[]>;
    /** Defaults to `https://api.langsys.dev/api`. */
    apiUrl?: string;
    /** Items per request; the API takes up to 200. */
    batchSize?: number;
    /** Build the request and send nothing. */
    dryRun?: boolean;
    /** For tests and runtimes without a global `fetch`. */
    fetch?: typeof fetch;
}

export interface LegacyImportResult {
    success: boolean;
    /** Why nothing, or not everything, was sent: `send_failed` with the status and message. */
    reason: string | null;
    phrases: number;
    translations: number;
    human_translations_saved: number;
    human_translations_skipped: number;
    /** Translations the API skipped for the plan's human-translation word limit, when it names them. */
    skipped_translations: unknown[];
    /** Translations not sent: the target file lacks the key, its value is empty, or it does not convert. */
    skipped: LegacyImportSkip[];
    /** What was sent, or with `dryRun` what would be. */
    items: LegacyImportItem[];
}

const DEFAULT_API_URL = 'https://api.langsys.dev/api';
const DEFAULT_BATCH_SIZE = 200;

/**
 * The items an import sends: one phrase per source key, registered as `t()`
 * registers it (the key's converted value under its category), with each target
 * locale's converted value for the same key. A value that converts to nothing
 * recognised is still a source phrase, as in `t()`, but is not sent as a
 * translation, since its placeholders or plural would not match.
 */
export function buildLegacyImport(source: LegacyKeyFile[], targets: Record<string, LegacyKeyFile[]>): LegacyImportPlan {
    const sourceKeys = createLegacyKeys(source);
    const readers = Object.entries(targets).map(([locale, files]) => [canonicalizeLocale(locale), createLegacyKeys(files)] as const);
    const items = new Map<string, LegacyImportItem>();
    const skipped: LegacyImportSkip[] = [];

    for (const key of sourceKeys.keys()) {
        const hit = sourceKeys.resolve(key);
        const phrase = hit ? stripC0Controls(hit.phrase) : '';
        if (!hit || phrase.trim() === '') continue;

        const category = hit.category || null;
        const id = JSON.stringify([category, phrase]);
        const item = items.get(id) ?? { type: 'phrase' as const, phrase, category, translations: [] };
        items.set(id, item);

        for (const [locale, reader] of readers) {
            if (item.translations.some((entry) => entry.locale === locale)) continue;
            const reason = skipReason(reader.resolve(key));
            if (reason) {
                skipped.push({ key, locale, reason });
                continue;
            }
            item.translations.push({ locale, translation: stripC0Controls(reader.resolve(key)!.phrase) });
        }
    }

    return { items: [...items.values()], skipped };
}

function skipReason(hit: ReturnType<ReturnType<typeof createLegacyKeys>['resolve']>): LegacyImportSkipReason | null {
    if (!hit) return 'missing';
    if (hit.phrase.trim() === '') return 'empty';
    return hit.recognised ? null : 'not_converted';
}

/**
 * Send the import. Never throws for an answer the API gives: a refused batch
 * ends the run with `success: false` and the API's status and message in
 * `reason`, and what the batches before it saved is still counted.
 */
export async function importLegacyTranslations(options: LegacyImportOptions): Promise<LegacyImportResult> {
    const { items, skipped } = buildLegacyImport(options.source, options.targets);
    const result: LegacyImportResult = {
        success: false,
        reason: null,
        phrases: items.length,
        translations: items.reduce((total, item) => total + item.translations.length, 0),
        human_translations_saved: 0,
        human_translations_skipped: 0,
        skipped_translations: [],
        skipped,
        items,
    };

    if (options.dryRun) return { ...result, success: true };

    const send = options.fetch ?? globalThis.fetch;
    const url = `${(options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, '')}/translatable-items`;
    const size = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE));

    for (let offset = 0; offset < items.length; offset += size) {
        let response: Response;
        let body: { data?: Record<string, unknown>; error?: { message?: string; code?: string } } | null;
        try {
            response = await send(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-Authorization': options.key },
                body: JSON.stringify({ project_id: options.projectid, translatable_items: items.slice(offset, offset + size) }),
            });
            body = await response.json().catch(() => null);
        } catch (error) {
            return { ...result, reason: `send_failed: ${error instanceof Error ? error.message : String(error)}` };
        }

        if (!response.ok) {
            const message = body?.error?.message ?? response.statusText;
            return { ...result, reason: `send_failed: HTTP ${response.status}${message ? ` ${message}` : ''}` };
        }

        const data = body?.data ?? {};
        result.human_translations_saved += Number(data.human_translations_saved ?? 0);
        result.human_translations_skipped += Number(data.human_translations_skipped ?? 0);
        if (Array.isArray(data.skipped_translations)) result.skipped_translations.push(...data.skipped_translations);
    }

    return { ...result, success: true };
}
