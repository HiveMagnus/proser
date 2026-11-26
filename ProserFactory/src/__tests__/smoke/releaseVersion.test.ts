import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseVersion } from '../../core/releaseVersion';

describe('release version', () => {
  const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proser-version-'));

  it('prefers the VERSION file stamped into release images', () => {
    const root = directory();
    fs.writeFileSync(path.join(root, 'VERSION'), '1.0.8\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    expect(releaseVersion(root)).toBe('1.0.8');
  });

  it('falls back to the package version in a source checkout', () => {
    const root = directory();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.7' }));
    expect(releaseVersion(root)).toBe('1.0.7');
    expect(releaseVersion(directory())).toBe('unknown');
  });

  it('refuses a malformed stamped version', () => {
    const root = directory();
    fs.writeFileSync(path.join(root, 'VERSION'), 'latest\n');
    expect(() => releaseVersion(root)).toThrow('VERSION is invalid');
  });

  it('keeps the root and Factory package versions in step', () => {
    const read = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string }).version;
    expect(read(path.resolve(__dirname, '../../../package.json'))).toBe(read(path.resolve(__dirname, '../../../../package.json')));
  });
});
