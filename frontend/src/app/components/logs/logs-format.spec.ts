import { parseAnsi, sgrToClass, isContinuationLine, formatRelative, parseStructured, parseJsonDetail } from './logs-format';

describe('logs-format', () => {
  describe('parseAnsi', () => {
    it('returns a single uncoloured run for plain text', () => {
      expect(parseAnsi('hello world')).toEqual([{ t: 'hello world', cls: '' }]);
    });

    it('splits a coloured segment into runs and maps SGR fg to a class', () => {
      // red "ERR" then reset, then plain
      const runs = parseAnsi('\x1B[31mERR\x1B[0m ok');
      expect(runs).toEqual([
        { t: 'ERR', cls: 'ansi-1' },
        { t: ' ok', cls: '' },
      ]);
    });

    it('maps bright colours (90-97) to b-prefixed classes', () => {
      expect(parseAnsi('\x1B[92mgo\x1B[0m')).toEqual([{ t: 'go', cls: 'ansi-b2' }]);
    });

    it('keeps colour active across following text until reset', () => {
      expect(parseAnsi('\x1B[34ma b c')).toEqual([{ t: 'a b c', cls: 'ansi-4' }]);
    });

    it('drops non-SGR CSI sequences (cursor moves / clears) and carriage returns', () => {
      // \x1B[2K = clear line (non-'m'), \r stripped
      expect(parseAnsi('\x1B[2Kfoo\rbar')).toEqual([{ t: 'foobar', cls: '' }]);
    });

    it('trims trailing whitespace and whitespace-only trailing runs', () => {
      expect(parseAnsi('done   ')).toEqual([{ t: 'done', cls: '' }]);
      expect(parseAnsi('msg\x1B[0m   ')).toEqual([{ t: 'msg', cls: '' }]);
    });

    it('plain text is recoverable by concatenating run text', () => {
      const raw = '\x1B[33mWARN\x1B[0m: \x1B[31mboom\x1B[0m';
      expect(parseAnsi(raw).map(r => r.t).join('')).toBe('WARN: boom');
    });

    it('handles an empty / colour-only line without throwing', () => {
      expect(parseAnsi('')).toEqual([]);
      expect(parseAnsi('\x1B[0m')).toEqual([]);
    });
  });

  describe('sgrToClass', () => {
    it('resets on 0 or empty params', () => {
      expect(sgrToClass('0', 'ansi-1')).toBe('');
      expect(sgrToClass('', 'ansi-1')).toBe('');
    });
    it('restores default fg on 39 but keeps current otherwise', () => {
      expect(sgrToClass('39', 'ansi-1')).toBe('');
    });
    it('ignores style codes like bold (1) without changing colour', () => {
      expect(sgrToClass('1', 'ansi-2')).toBe('ansi-2');
    });
    it('takes the last colour when several are present', () => {
      expect(sgrToClass('31;1;32', '')).toBe('ansi-2');
    });
  });

  describe('isContinuationLine', () => {
    it('folds indented lines', () => {
      expect(isContinuationLine('    at com.foo.Bar(Bar.java:42)')).toBeTrue();
      expect(isContinuationLine('\tnested')).toBeTrue();
    });
    it('folds common stack-trace markers even when not indented', () => {
      expect(isContinuationLine('at com.foo.Bar(Bar.java:42)')).toBeTrue();
      expect(isContinuationLine('Caused by: java.lang.NullPointerException')).toBeTrue();
      expect(isContinuationLine('... 12 more')).toBeTrue();
      expect(isContinuationLine('File "app.py", line 5, in <module>')).toBeTrue();
    });
    it('does NOT fold ordinary log lines or exception-type lines', () => {
      expect(isContinuationLine('GET /health 200')).toBeFalse();
      expect(isContinuationLine('ValueError: bad input')).toBeFalse();
      expect(isContinuationLine('')).toBeFalse();
    });
  });

  describe('formatRelative', () => {
    const base = Date.UTC(2026, 5, 27, 12, 0, 0); // 2026-06-27T12:00:00Z
    const at = (secAgo: number) => new Date(base - secAgo * 1000).toISOString();

    it('falls back when the timestamp is missing or unparseable', () => {
      expect(formatRelative('', '12:00:00', base)).toBe('12:00:00');
      expect(formatRelative('not-a-date', '12:00:00', base)).toBe('12:00:00');
    });
    it('formats sub-minute ages', () => {
      expect(formatRelative(at(0), 'x', base)).toBe('now');
      expect(formatRelative(at(12), 'x', base)).toBe('12s');
      expect(formatRelative(at(59), 'x', base)).toBe('59s');
    });
    it('formats minutes, hours and days', () => {
      expect(formatRelative(at(60), 'x', base)).toBe('1m');
      expect(formatRelative(at(3600), 'x', base)).toBe('1h');
      expect(formatRelative(at(86400 * 3), 'x', base)).toBe('3d');
    });
    it('never returns a negative age (clock skew → "now")', () => {
      expect(formatRelative(at(-30), 'x', base)).toBe('now');
    });
  });

  describe('parseStructured', () => {
    it('returns null for non-JSON or invalid-JSON lines', () => {
      expect(parseStructured('plain log line')).toBeNull();
      expect(parseStructured('GET /health 200')).toBeNull();
      expect(parseStructured('{not valid json')).toBeNull();
    });
    it('extracts the real level from the level/severity field', () => {
      expect(parseStructured('{"level":"error","msg":"boom"}')?.level).toBe('err');
      expect(parseStructured('{"level":"warn","msg":"x"}')?.level).toBe('warn');
      expect(parseStructured('{"severity":"INFO","message":"ok"}')?.level).toBe('info');
    });
    it('does NOT let a message word dictate the level', () => {
      // valid JSON, level=info, message mentions "panic" → stays info
      expect(parseStructured('{"level":"info","msg":"a panic was mentioned"}')?.level).toBe('info');
    });
    it('renders the message first, then a dimmed key=value tail', () => {
      const r = parseStructured('{"level":"info","msg":"hello","user":"alice","n":3}');
      expect(r).not.toBeNull();
      expect(r!.runs[0]).toEqual({ t: 'hello', cls: '' });
      expect(r!.runs.some(x => x.cls === 'ldim' && x.t.includes('user=alice'))).toBeTrue();
      expect(r!.runs.some(x => x.cls === 'ldim' && x.t.includes('n=3'))).toBeTrue();
      expect(r!.text).toContain('hello');
      expect(r!.text).toContain('user=alice');
    });
    it('returns null when only level/time are present (nothing useful to show)', () => {
      expect(parseStructured('{"level":"info","time":"2026-01-01T00:00:00Z"}')).toBeNull();
    });
  });

  describe('parseJsonDetail', () => {
    it('returns null for non-JSON lines', () => {
      expect(parseJsonDetail('plain log line')).toBeNull();
      expect(parseJsonDetail('{not valid json')).toBeNull();
    });
    it('splits level + message from the remaining (filterable) fields', () => {
      const d = parseJsonDetail('{"level":"error","msg":"boom","user":"alice","code":500}');
      expect(d).not.toBeNull();
      expect(d!.level).toBe('err');
      expect(d!.message).toBe('boom');
      expect(d!.fields).toEqual([{ key: 'user', value: 'alice' }, { key: 'code', value: '500' }]);
    });
    it('excludes level/message/time fields from the field list', () => {
      const d = parseJsonDetail('{"level":"info","msg":"x","time":"2026-01-01T00:00:00Z","ts":1,"region":"eu"}');
      expect(d!.fields.map(f => f.key)).toEqual(['region']);
    });
    it('stringifies non-string values and pretty-prints the whole object', () => {
      const d = parseJsonDetail('{"msg":"x","meta":{"a":1}}');
      expect(d!.fields[0]).toEqual({ key: 'meta', value: '{"a":1}' });
      expect(d!.pretty).toContain('\n'); // multi-line pretty form
    });
  });
});
