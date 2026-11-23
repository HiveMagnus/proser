/// <reference types="jest" />
import path from 'node:path';
import request from 'supertest';
import app from '../index';
import { isLoopbackOrigin } from '../server';
import { resolveInside } from '../lib/safePath';
import { stripSurroundingMarkup } from '../lib/utils/sanitize';

describe('storage paths stay inside their directory', () => {
  const root = path.resolve('/srv/proser/exports');
  it('resolves ordinary names', () => {
    expect(resolveInside(root, '1', '2')).toBe(path.join(root, '1', '2'));
    expect(resolveInside(root, 'a'.repeat(64) + '.md')).toBe(path.join(root, 'a'.repeat(64) + '.md'));
  });
  it('refuses traversal and absolute segments', () => {
    expect(() => resolveInside(root, '..', 'secrets')).toThrow('escapes');
    expect(() => resolveInside(root, '1', '../../etc/passwd')).toThrow('escapes');
    expect(() => resolveInside(root, '/etc/passwd')).toThrow('escapes');
    expect(() => resolveInside(root, '../exports-other/file')).toThrow('escapes');
  });
});

describe('stripSurroundingMarkup', () => {
  it('keeps the previous trimming behaviour', () => {
    expect(stripSurroundingMarkup('**Lady Vex**')).toBe('Lady Vex');
    expect(stripSurroundingMarkup('  -- "Harbor Town"; ')).toBe('Harbor Town');
    expect(stripSurroundingMarkup('…Ash • Ember…')).toBe('Ash • Ember');
    expect(stripSurroundingMarkup('!!!')).toBe('');
  });
  it('stays linear on long runs of whitespace', () => {
    const input = `x${'\t'.repeat(200_000)}y`;
    const started = Date.now();
    expect(stripSurroundingMarkup(input)).toBe(input);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('development CORS', () => {
  it('accepts browser origins on this machine only', () => {
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('https://127.0.0.1:8443')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
    expect(isLoopbackOrigin('https://evil.example')).toBe(false);
    expect(isLoopbackOrigin('http://localhost.evil.example')).toBe(false);
    expect(isLoopbackOrigin('file:///tmp/page.html')).toBe(false);
    expect(isLoopbackOrigin('not a url')).toBe(false);
  });
  it('reflects only loopback origins outside production', async () => {
    const local = await request(app).get('/api/readiness').set('Origin', 'http://localhost:3000');
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const foreign = await request(app).get('/api/readiness').set('Origin', 'https://evil.example');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});
