// roster-csv unit tests — Corporate Foundation PR 2.
//
// Pure-function tests, no mocks. The load-bearing block is the
// ADDRESS-COLUMN REJECTION suite: the privacy gate that keeps
// employee addresses from ever entering Qift via a company upload
// (Corporate Core v2 §3/§5). EN + AR headers are both pinned.

import {
  MAX_ROSTER_ROWS,
  parseCsv,
  parseRoster,
  planHeaders,
} from './roster-csv';

describe('parseCsv', () => {
  it('parses plain rows and drops empty lines', () => {
    expect(parseCsv('a,b\n1,2\n\n3,4\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('handles CRLF, BOM, and a missing trailing newline', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('handles quoted fields with commas, escaped quotes, and newlines', () => {
    expect(parseCsv('name,note\n"Doe, Jane","said ""hi""\nbye"')).toEqual([
      ['name', 'note'],
      ['Doe, Jane', 'said "hi"\nbye'],
    ]);
  });
});

describe('planHeaders', () => {
  it('maps English and Arabic aliases to roster fields', () => {
    const res = planHeaders(['Full Name', 'البريد الإلكتروني', 'رقم الجوال']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect([...res.plan.mapping.values()]).toEqual([
        'fullName',
        'email',
        'phone',
      ]);
    }
  });

  it('REJECTS any address-like column — English', () => {
    const res = planHeaders(['name', 'phone', 'Home Address']);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejection.code).toBe('roster_address_columns_forbidden');
      expect(res.rejection.columns).toEqual(['Home Address']);
    }
  });

  it('REJECTS any address-like column — Arabic', () => {
    const res = planHeaders(['الاسم', 'الجوال', 'العنوان الوطني']);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejection.code).toBe('roster_address_columns_forbidden');
      expect(res.rejection.columns).toEqual(['العنوان الوطني']);
    }
  });

  it('rejection wins even when the rest of the file is perfect, and lists every offender', () => {
    const res = planHeaders(['name', 'email', 'phone', 'City', 'الحي', 'zip_code']);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejection.columns).toEqual(['City', 'الحي', 'zip_code']);
    }
  });

  it('rejects headers with no name or no contact channel', () => {
    expect(planHeaders(['email', 'phone']).ok).toBe(false); // no name
    expect(planHeaders(['name', 'department']).ok).toBe(false); // no channel
  });

  it('reports unmapped columns as ignored instead of storing them', () => {
    const res = planHeaders(['name', 'phone', 'T-Shirt Size']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.ignoredColumns).toEqual(['T-Shirt Size']);
    }
  });
});

describe('parseRoster', () => {
  const HEADER = 'name,email,phone\n';

  it('imports valid rows with normalized channels', () => {
    const res = parseRoster(
      HEADER +
        'Sara Ali,Sara@Corp.SA,0501234567\n' +
        'Omar Said,,+966555555555\n',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toEqual([
        {
          line: 2,
          fullName: 'Sara Ali',
          email: 'sara@corp.sa', // lowercased
          phone: '+966501234567', // E.164 from local format
          department: null,
          employeeRef: null,
        },
        {
          line: 3,
          fullName: 'Omar Said',
          email: null,
          phone: '+966555555555',
          department: null,
          employeeRef: null,
        },
      ]);
      expect(res.skipped).toEqual([]);
    }
  });

  it('skips rows with bad phone / bad email / no channel / no name, with line numbers', () => {
    const res = parseRoster(
      HEADER +
        'Sara Ali,sara@corp.sa,12345\n' + // bad phone
        'Omar Said,not-an-email,\n' + // bad email
        'Lina Omar,,\n' + // no channel
        ',x@y.io,\n', // no name
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toEqual([]);
      expect(res.skipped).toEqual([
        { line: 2, reason: 'phone_invalid' },
        { line: 3, reason: 'email_invalid' },
        { line: 4, reason: 'channel_missing' },
        { line: 5, reason: 'name_missing' },
      ]);
    }
  });

  it('dedups within the file on either channel', () => {
    const res = parseRoster(
      HEADER +
        'Sara Ali,sara@corp.sa,0501234567\n' +
        'Sara A.,sara@corp.sa,\n' + // dup email
        'S. Ali,,+966501234567\n', // dup phone
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toHaveLength(1);
      expect(res.skipped).toEqual([
        { line: 3, reason: 'duplicate_in_file' },
        { line: 4, reason: 'duplicate_in_file' },
      ]);
    }
  });

  it('rejects an empty file and an over-cap file', () => {
    expect(parseRoster('')).toEqual({
      ok: false,
      rejection: { code: 'roster_empty' },
    });
    const big =
      HEADER +
      Array.from(
        { length: MAX_ROSTER_ROWS + 1 },
        (_, i) => `P ${i},p${i}@x.io,\n`,
      ).join('');
    expect(parseRoster(big)).toEqual({
      ok: false,
      rejection: { code: 'roster_too_many_rows' },
    });
  });

  it('propagates the address-column rejection at file level', () => {
    const res = parseRoster('name,phone,address\nSara,0501234567,Riyadh St 5\n');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rejection.code).toBe('roster_address_columns_forbidden');
    }
  });
});
