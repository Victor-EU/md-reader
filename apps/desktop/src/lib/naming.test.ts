import { describe, expect, it } from 'vitest';
import { fileNameFrom, proposeFileName, renamedFile, untitledNumber } from './naming.ts';

describe('a heading as a file name', () => {
  it('keeps the words, the spaces and the case', () => {
    expect(fileNameFrom('Refactor the parser')).toBe('Refactor the parser');
  });

  it('replaces what a path or Windows would refuse', () => {
    expect(fileNameFrom('Q1: read/write ratios')).toBe('Q1 read write ratios');
    expect(fileNameFrom('What about <this> | that?')).toBe('What about this that');
  });

  it('collapses the whitespace a heading can carry', () => {
    expect(fileNameFrom('  Two   spaces\tand a tab ')).toBe('Two spaces and a tab');
  });

  it('drops the invisible characters that make a name nobody can retype', () => {
    expect(fileNameFrom('Plan​ning‮')).toBe('Plan ning');
  });

  it('will not hide the file, and will not end it where Windows would trim', () => {
    expect(fileNameFrom('.hidden')).toBe('hidden');
    expect(fileNameFrom('Ends in a dot.')).toBe('Ends in a dot');
  });

  it('trims a long heading at a word rather than mid-word', () => {
    const heading =
      'A heading that runs on the way headings written as sentences tend to run on and on';
    const name = fileNameFrom(heading) ?? '';
    expect(name.length).toBeLessThanOrEqual(60);
    expect(heading.startsWith(name)).toBe(true);
    expect(name.endsWith('sentences')).toBe(true);
  });

  it('never halves an emoji when it trims', () => {
    const name = fileNameFrom(`${'x'.repeat(59)} 🚀`) ?? '';
    expect([...name].length).toBeLessThanOrEqual(60);
    expect(name).not.toContain('�');
    expect(name.endsWith('x')).toBe(true);
  });

  it('gives up on a heading with no name left in it', () => {
    expect(fileNameFrom('///')).toBeNull();
    expect(fileNameFrom('   ')).toBeNull();
    expect(fileNameFrom('...')).toBeNull();
  });

  it('gives up on the names Windows keeps for devices', () => {
    expect(fileNameFrom('CON')).toBeNull();
    expect(fileNameFrom('lpt1')).toBeNull();
    expect(fileNameFrom('nul.md')).toBeNull();
    expect(fileNameFrom('Contents')).toBe('Contents');
  });
});

describe('what the save panel opens with', () => {
  it('is the heading with the markdown extension on it', () => {
    expect(proposeFileName('Team brief', 'Untitled 2')).toBe('Team brief.md');
  });

  it('does not put a second extension on a heading that has one', () => {
    expect(proposeFileName('README.md', 'Untitled 1')).toBe('README.md');
    expect(proposeFileName('notes.txt', 'Untitled 1')).toBe('notes.txt');
  });

  it('falls back to the name the document already answers to', () => {
    expect(proposeFileName(null, 'Untitled 3')).toBe('Untitled 3.md');
    expect(proposeFileName('///', 'Untitled 3')).toBe('Untitled 3.md');
  });

  it('always proposes something, even with nothing to go on', () => {
    expect(proposeFileName(null, '')).toBe('Untitled.md');
  });
});

describe('a file renamed from the toolbar', () => {
  it('keeps the extension when the reader types only a name', () => {
    expect(renamedFile('strategy', 'plan.md')).toBe('strategy.md');
    expect(renamedFile('plan', 'notes.txt')).toBe('plan.txt');
  });

  it('takes a name that already ends in it as it is', () => {
    expect(renamedFile('strategy.md', 'plan.md')).toBe('strategy.md');
    expect(renamedFile('Strategy.MD', 'plan.md')).toBe('Strategy.MD');
  });

  it('lets the reader move between the extensions the app opens', () => {
    expect(renamedFile('plan.markdown', 'plan.md')).toBe('plan.markdown');
  });

  it('does not take a dot inside the name for an extension', () => {
    expect(renamedFile('Q3.2026', 'plan.md')).toBe('Q3.2026.md');
    expect(renamedFile('v1.2 notes', 'plan.md')).toBe('v1.2 notes.md');
  });

  it('leaves a file that had no extension without one', () => {
    expect(renamedFile('CHANGES', 'README')).toBe('CHANGES');
    expect(renamedFile('env', '.env')).toBe('env');
  });

  it('trims what the field had around the name', () => {
    expect(renamedFile('  strategy ', 'plan.md')).toBe('strategy.md');
  });
});

describe('the names the app hands out', () => {
  it('reads the number back out of one', () => {
    expect(untitledNumber('Untitled 3')).toBe(3);
    expect(untitledNumber('Untitled')).toBe(0);
  });

  it('does not count a name the reader chose, whatever it ends in', () => {
    expect(untitledNumber('Plan 2026')).toBeNull();
    expect(untitledNumber('Untitled 3 draft')).toBeNull();
  });
});
