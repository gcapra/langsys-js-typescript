import { describe, expect, it, vi } from 'vitest';
import { buildLegacyImport, importLegacyTranslations } from '../src/import.js';
import { createLegacyKeys, type LegacyKeyFile } from '../src/legacy-keys.js';

const file = (name: string, data: Record<string, unknown>): LegacyKeyFile[] => [{ name, format: 'i18next', data }];

const EN = file('en.json', {
    nav: { home: 'Home', cart: 'Cart' },
    cart: { items_one: '{{count}} item', items_other: '{{count}} items' },
    footer: { copyright: '© {{year}} Northwind Shop.' },
});
const ES = file('es.json', {
    nav: { home: 'Inicio', cart: 'Carrito' },
    cart: { items_one: '{{count}} artículo', items_other: '{{count}} artículos' },
    footer: { copyright: '© {{year}} Tienda Northwind.' },
});
const FR = file('fr.json', {
    nav: { home: 'Accueil', cart: '' },
    cart: { items_one: '{{count}} article', items_many: '{{count}} d’articles', items_other: '{{count}} articles' },
});

function answer(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, statusText: status === 403 ? 'Forbidden' : 'OK', json: async () => body } as Response;
}

describe('MIG-9: buildLegacyImport', () => {
    it('registers each source key as t() does, with every target locale’s converted value', () => {
        const { items } = buildLegacyImport(EN, { es: ES, 'FR_fr': FR });
        const home = items.find((item) => item.phrase === 'Home')!;
        expect(home).toEqual({
            type: 'phrase',
            phrase: 'Home',
            category: 'nav',
            translations: [
                { locale: 'es', translation: 'Inicio' },
                { locale: 'fr-fr', translation: 'Accueil' },
            ],
        });
        const source = createLegacyKeys(EN).resolve('footer.copyright')!;
        expect(items.find((item) => item.category === 'footer')!.phrase).toBe(source.phrase);
    });

    it('sends a plural set as one phrase, each language converted with its own plural forms', () => {
        const { items } = buildLegacyImport(EN, { es: ES, 'fr-fr': FR });
        const cart = items.find((item) => item.category === 'cart')!;
        expect(cart.phrase).toBe(createLegacyKeys(EN).resolve('cart.items')!.phrase);
        expect(cart.translations.map((entry) => entry.locale)).toEqual(['es', 'fr-fr']);
        expect(cart.translations[1]!.translation).toBe(createLegacyKeys(FR).resolve('cart.items')!.phrase);
        expect(cart.translations[1]!.translation).toContain('many');
    });

    it('names each translation it does not send: missing from the file, or empty', () => {
        const { skipped } = buildLegacyImport(EN, { 'fr-fr': FR });
        expect(skipped).toEqual([
            { key: 'nav.cart', locale: 'fr-fr', reason: 'empty' },
            { key: 'footer.copyright', locale: 'fr-fr', reason: 'missing' },
        ]);
    });

    it('does not send a translation that does not convert, and still registers its source phrase', () => {
        const plain = (data: Record<string, unknown>): LegacyKeyFile[] => [{ name: 'x.json', format: 'plain', data }];
        const { items, skipped } = buildLegacyImport(plain({ a: { b: 'Hello' } }), { es: plain({ a: { b: 'Hola | Holas' } }) });
        expect(items).toEqual([{ type: 'phrase', phrase: 'Hello', category: 'a', translations: [] }]);
        expect(skipped).toEqual([{ key: 'a.b', locale: 'es', reason: 'not_converted' }]);
    });

    it('control: keys() lists each key once, a plural set by its base key', () => {
        expect(createLegacyKeys(EN).keys()).toEqual(['nav.home', 'nav.cart', 'cart.items', 'footer.copyright']);
    });
});

describe('MIG-9: importLegacyTranslations', () => {
    const options = { projectid: 'p-1', key: 'write-key', source: EN, targets: { es: ES }, apiUrl: 'https://api.test/api/' };

    it('posts the items to translatable-items with the key, in batches, and adds up the answers', async () => {
        const fetch = vi.fn(async () => answer(200, { data: { human_translations_saved: 2, human_translations_skipped: 1, skipped_translations: [{ locale: 'es' }] } }));
        const result = await importLegacyTranslations({ ...options, batchSize: 3, fetch: fetch as unknown as typeof globalThis.fetch });

        expect(fetch).toHaveBeenCalledTimes(2);
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.test/api/translatable-items');
        expect((init.headers as Record<string, string>)['x-Authorization']).toBe('write-key');
        const body = JSON.parse(init.body as string);
        expect(body.project_id).toBe('p-1');
        expect(body.translatable_items).toHaveLength(3);
        expect(result).toMatchObject({ success: true, reason: null, phrases: 4, translations: 4, human_translations_saved: 4, human_translations_skipped: 2 });
        expect(result.skipped_translations).toHaveLength(2);
    });

    it('a dry run sends nothing and returns what it would send', async () => {
        const fetch = vi.fn();
        const result = await importLegacyTranslations({ ...options, dryRun: true, fetch: fetch as unknown as typeof globalThis.fetch });
        expect(fetch).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.items).toHaveLength(4);
    });

    it('a refused batch ends the run with the API’s status and message, counting what was saved before it', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(answer(200, { data: { human_translations_saved: 3 } }))
            .mockResolvedValueOnce(answer(403, { error: { message: 'This key cannot write.' } }));
        const result = await importLegacyTranslations({ ...options, batchSize: 3, fetch });
        expect(result).toMatchObject({ success: false, reason: 'send_failed: HTTP 403 This key cannot write.', human_translations_saved: 3 });
    });

    it('a network failure is a result, never a throw', async () => {
        const fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
        const result = await importLegacyTranslations({ ...options, fetch });
        expect(result).toMatchObject({ success: false, reason: 'send_failed: connect ECONNREFUSED' });
    });
});
