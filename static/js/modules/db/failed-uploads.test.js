/**
 * Tests for the local-download safety-net helper (issue #297).
 *
 * triggerLocalDownload is the last-resort fallback when both the upload and
 * IndexedDB persistence fail. It builds a blob URL, attaches an anchor,
 * synthesises a click, and revokes the URL afterwards. We mock the DOM
 * and URL APIs to verify the call shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { triggerLocalDownload, storeFailedUpload, updateRetryCount } from './failed-uploads.js';

describe('triggerLocalDownload', () => {
    let originalDocument;
    let originalURL;
    let createObjectURL;
    let revokeObjectURL;
    let appendChild;
    let removeChild;
    let click;
    let anchor;

    beforeEach(() => {
        createObjectURL = vi.fn(() => 'blob:test-url');
        revokeObjectURL = vi.fn();
        click = vi.fn();
        appendChild = vi.fn();
        removeChild = vi.fn();
        anchor = {
            click,
            style: {},
            set href(val) { this._href = val; },
            get href() { return this._href; },
            set download(val) { this._download = val; },
            get download() { return this._download; },
        };
        originalURL = global.URL;
        originalDocument = global.document;
        global.URL = { createObjectURL, revokeObjectURL };
        global.document = {
            createElement: vi.fn(() => anchor),
            body: { appendChild, removeChild },
        };
    });

    afterEach(() => {
        global.URL = originalURL;
        global.document = originalDocument;
    });

    it('returns false for falsy file', () => {
        expect(triggerLocalDownload(null, 'a.webm')).toBe(false);
        expect(triggerLocalDownload(undefined, 'a.webm')).toBe(false);
    });

    it('returns false for zero-size blob', () => {
        expect(triggerLocalDownload({ size: 0 }, 'a.webm')).toBe(false);
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('synthesises a click on an anchor for a non-empty blob', () => {
        const fakeFile = { name: 'recording.webm', size: 1024, type: 'audio/webm' };
        const result = triggerLocalDownload(fakeFile, 'recording.webm');
        expect(result).toBe(true);
        expect(createObjectURL).toHaveBeenCalledWith(fakeFile);
        expect(global.document.createElement).toHaveBeenCalledWith('a');
        expect(anchor.href).toBe('blob:test-url');
        expect(anchor.download).toBe('recording.webm');
        expect(click).toHaveBeenCalledOnce();
        expect(appendChild).toHaveBeenCalledWith(anchor);
        expect(removeChild).toHaveBeenCalledWith(anchor);
    });

    it('falls back to a generated name when none is supplied', () => {
        const fakeFile = { size: 100 };
        triggerLocalDownload(fakeFile);
        expect(anchor.download).toMatch(/^speakr-recording-\d+\.webm$/);
    });

    it('returns false when DOM access throws', () => {
        global.URL.createObjectURL = vi.fn(() => { throw new Error('boom'); });
        const result = triggerLocalDownload({ size: 1 }, 'x.webm');
        expect(result).toBe(false);
    });
});

/**
 * Regression tests for the IndexedDB transaction-lifetime bug (TransactionInactiveError).
 *
 * IndexedDB auto-commits ("finishes") a transaction as soon as control returns
 * to the event loop with no pending requests outstanding against it. So any
 * `await` of a non-IndexedDB promise (e.g. File.arrayBuffer(), or a nested
 * helper that opens its own transaction) between `db.transaction(...)` and the
 * first request kills the transaction. These tests model that semantics: the
 * mock transaction goes inactive on the next microtask, and add()/put() throw
 * if used after that, exactly like a real browser.
 */
describe('IndexedDB transaction lifetime', () => {
    let originalIndexedDB;
    let store;

    // Build a mock that mirrors the real auto-commit-on-yield behaviour.
    const makeMockDB = () => {
        store = new Map();
        let nextId = 1;

        const makeRequest = (op) => {
            const request = {};
            // Fire callbacks asynchronously, like a real IDBRequest.
            queueMicrotask(() => {
                try {
                    const result = op();
                    request.result = result;
                    request.onsuccess?.();
                } catch (err) {
                    request.error = err;
                    request.onerror?.();
                }
            });
            return request;
        };

        const db = {
            transaction() {
                const tx = { _active: true };
                // The transaction commits/finishes once the current task yields.
                queueMicrotask(() => { tx._active = false; });

                const objectStore = {
                    add(value) {
                        if (!tx._active) {
                            throw new DOMException(
                                "Failed to execute 'add' on 'IDBObjectStore': The transaction has finished.",
                                'TransactionInactiveError'
                            );
                        }
                        return makeRequest(() => {
                            const id = nextId++;
                            store.set(id, { ...value, id });
                            return id;
                        });
                    },
                    put(value) {
                        if (!tx._active) {
                            throw new DOMException(
                                "Failed to execute 'put' on 'IDBObjectStore': The transaction has finished.",
                                'TransactionInactiveError'
                            );
                        }
                        return makeRequest(() => {
                            store.set(value.id, { ...value });
                            return value.id;
                        });
                    },
                    get(id) {
                        return makeRequest(() => store.get(id));
                    },
                };
                tx.objectStore = () => objectStore;
                return tx;
            },
            objectStoreNames: { contains: () => true },
        };
        return db;
    };

    beforeEach(() => {
        originalIndexedDB = global.indexedDB;
        const db = makeMockDB();
        global.indexedDB = {
            open: vi.fn(() => {
                const request = {};
                queueMicrotask(() => {
                    request.result = db;
                    request.onsuccess?.();
                });
                return request;
            }),
        };
    });

    afterEach(() => {
        global.indexedDB = originalIndexedDB;
        vi.resetModules();
    });

    it('storeFailedUpload persists a record when the file must be read to an ArrayBuffer', async () => {
        const file = {
            name: 'recording.webm',
            size: 2048,
            type: 'audio/webm',
            arrayBuffer: async () => new ArrayBuffer(8),
        };

        const id = await storeFailedUpload({
            file,
            clientId: 'client-123',
            notes: 'n',
            tags: ['t'],
            asrOptions: {},
            error: '413 Payload Too Large',
        });

        expect(id).toBeTruthy();
        const stored = store.get(id);
        expect(stored.fileName).toBe('recording.webm');
        expect(stored.fileData).toBeInstanceOf(ArrayBuffer);
        expect(stored.lastError).toBe('413 Payload Too Large');
    });

    it('updateRetryCount updates an existing record without a finished transaction', async () => {
        // Seed a record first.
        const file = {
            name: 'r.webm', size: 10, type: 'audio/webm',
            arrayBuffer: async () => new ArrayBuffer(4),
        };
        const id = await storeFailedUpload({ file, clientId: 'c' });

        await expect(updateRetryCount(id, 2, 'still failing')).resolves.not.toThrow();
        const updated = store.get(id);
        expect(updated.retryCount).toBe(2);
        expect(updated.lastError).toBe('still failing');
    });
});
