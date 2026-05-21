// src/knowledge/pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCorpus, corpusDir, readMeta } from './corpus.js';
import { runTextPipeline, readChunks } from './pipeline.js';

let tmpFolder: string;

beforeEach(() => {
  tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
});

afterEach(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
});

describe('runTextPipeline', () => {
  it('processes text files and sets status to ready', async () => {
    const meta = createCorpus(tmpFolder, { name: 'test', sourceType: 'text' });
    // Write a source file
    fs.writeFileSync(
      path.join(corpusDir(tmpFolder, meta.id), 'raw', 'hello.txt'),
      'The quick brown fox. A lazy dog sleeps. The fox and the dog are friends.'
    );

    await runTextPipeline(tmpFolder, meta.id);

    const updated = readMeta(tmpFolder, meta.id);
    expect(updated.status).toBe('ready');
    expect(updated.chunkCount).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(corpusDir(tmpFolder, meta.id), 'chunks.jsonl'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(corpusDir(tmpFolder, meta.id), 'bm25.db'))
    ).toBe(true);
  });

  it('sets status to error if raw dir is empty', async () => {
    const meta = createCorpus(tmpFolder, { name: 'empty', sourceType: 'text' });
    await runTextPipeline(tmpFolder, meta.id);
    const updated = readMeta(tmpFolder, meta.id);
    expect(updated.status).toBe('error');
  });
});

describe('readChunks', () => {
  it('returns chunks after pipeline runs', async () => {
    const meta = createCorpus(tmpFolder, { name: 'r', sourceType: 'text' });
    fs.writeFileSync(
      path.join(corpusDir(tmpFolder, meta.id), 'raw', 'r.txt'),
      'Sentence one. Sentence two. Sentence three.'
    );
    await runTextPipeline(tmpFolder, meta.id);
    const chunks = readChunks(tmpFolder, meta.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].corpusId).toBe(meta.id);
  });

  it('returns empty array if chunks.jsonl does not exist', () => {
    const meta = createCorpus(tmpFolder, { name: 'none', sourceType: 'text' });
    const chunks = readChunks(tmpFolder, meta.id);
    expect(chunks).toEqual([]);
  });
});
