import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultDigesters } from '../local-scanner.js';
import { QuickXorHash, quickXor } from '../remote/quickxor.js';

/** Published by rclone (backend/onedrive/quickxorhash/quickxorhash_test.go): base64 in → out. */
const RCLONE_VECTORS: Array<[number, string, string]> = [
  [0, '', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='],
  [1, 'Sg==', 'SgAAAAAAAAAAAAAAAQAAAAAAAAA='],
  [2, 'tbQ=', 'taAFAAAAAAAAAAAAAgAAAAAAAAA='],
  [3, '0pZP', '0rDEEwAAAAAAAAAAAwAAAAAAAAA='],
  [4, 'jRRDVA==', 'jaDAEKgAAAAAAAAABAAAAAAAAAA='],
  [5, 'eAV52qE=', 'eChAHrQRCgAAAAAABQAAAAAAAAA='],
  [6, 'luBZlaT6', 'lgBHFipBCn0AAAAABgAAAAAAAAA='],
  [7, 'qaApEj66lw==', 'qQBFCiTgA11cAgAABwAAAAAAAAA='],
  [8, '/aNzzCFPS/A=', '/RjFHJgRgicsAR4ACAAAAAAAAAA='],
  [9, 'n6Neh7p6fFgm', 'nxiFFw6hCz3wAQsmCQAAAAAAAAA='],
  [10, 'J9iPGCbfZSTNyw==', 'J8DGIzBggm+UgQTNUgYAAAAAAAA='],
  [11, 'i+UZyUGJKh+ISbk=', 'iyhHBpIRhESo4AOIQ0IuAAAAAAA='],
  [12, 'h490d57Pqz5q2rtT', 'h3gEHe7giWeswgdq3MYupgAAAAA='],
  [13, 'vPgoDjOfO6fm71RxLw==', 'vMAHChwwg0/s4BTmdQcV4vACAAA='],
  [14, 'XoJ1AsoR4fDYJrDqYs4=', 'XhBEHQSgjAiEAx7YPgEs1CEGZwA='],
  [15, 'gQaybEqS/4UlDc8e4IJm', 'gDCALNigBEn8oxAlZ8AzPAAOQZg='],
  [16, '2fuxhBJXtpWFe8dOfdGeHw==', 'O9tHLAghgSvYohKFyMMxnNCHaHg='],
  [17, 'XBV6YKU9V7yMakZnFIxIkuU=', 'HbplHsBQih5cgReMQYMRzkABRiA='],
  [18, 'XJZSOiNO2bmfKnTKD7fztcQX', '/6ZArHQwAidkIxefQgEdlPGAW8w='],
  [19, 'g8VtAh+2Kf4k0kY5tzji2i2zmA==', 'wDNrgwHWAVukwB8kg4YRcnALHIg='],
  [20, 'T6LYJIfDh81JrAK309H2JMJTXis=', 'zBTHrspn3mEcohlJdIUAbjGNaNg='],
  [21, 'DWAAX5/CIfrmErgZa8ot6ZraeSbu', 'LR2Z0PjuRYGKQB/mhQAuMrAGZbQ='],
  [24, 'bU2j/0XYdgfPFD4691jV0AOUEUPR4Z5E', 'bnLBiLpVgnxVkXhNsIAPdHAPLFQ='],
  [32, 'NbYXsp5/K6mR+NmHwExjvWeWDJFnXTKWVlzYHoesp2E=', 'wjuAuWDiq04qDt1R8hHWDDcwVoQ='],
  [
    111,
    'jyibxJSzO6ZiZ0O1qe3tG/bvIAYssvukh9suIT5wEy1JBINVgPiqdsTW0cOpP0aUfP7mgqLfADkzI/m/GgCuVhr8oFLrOCoTx1/psBOWwhltCbhUx51Icm9aH8tY4Z3ccU+6BKpYQkLCy0B/A9Zc',
    'hZfLIilSITC6N3e3tQ/iSgEzkto=',
  ],
  [
    128,
    'ikwCorI7PKWz17EI50jZCGbV9JU2E8bXVfxNMg5zdmqSZ2NlsQPp0kqYIPjzwTg1MBtfWPg53k0h0P2naJNEVgrqpoHTfV2b3pJ4m0zYPTJmUX4Bg/lOxcnCxAYKU29Y5F0U8Quz7ZXFBEweftXxJ7RS4r6N7BzJrPsLhY7hgck=',
    'imAoFvCWlDn4yVw3/oq1PDbbm6U=',
  ],
  [
    256,
    'qwGf2ESubE5jOUHHyc94ORczFYYbc2OmEzo+hBIyzJiNwAzC8PvJqtTzwkWkSslgHFGWQZR2BV5+uYTrYT7HVwRM40vqfj0dBgeDENyTenIOL1LHkjtDKoXEnQ0mXAHoJ8PjbNC93zi5TovVRXTNzfGEs5dpWVqxUzb5lc7dwkyvOluBw482mQ4xrzYyIY1t+//OrNi1ObGXuUw2jBQOFfJVj2Y6BOyYmfB1y36eBxi3zxeG5d5NYjm2GSh6e08QMAwu3zrINcqIzLOuNIiGXBtl7DjKt7b5wqi4oFiRpZsCyx2smhSrdrtK/CkdU6nDN+34vSR/M8rZpWQdBE7a8g==',
    'WYT9JY3JIo/pEBp+tIM6Gt2nyTM=',
  ],
];

/**
 * Bit-by-bit reference written straight from the definition: bit k of input byte n goes to
 * state bit (11n + k) mod 160 (little-endian bit order); then the length is XORed in.
 */
function reference(data: Uint8Array): string {
  const state = new Uint8Array(20);
  for (let n = 0; n < data.length; n++) {
    for (let k = 0; k < 8; k++) {
      if ((((data[n] as number) >> k) & 1) === 0) continue;
      const bit = (11 * n + k) % 160;
      state[bit >> 3] = (state[bit >> 3] as number) ^ (1 << (bit & 7));
    }
  }
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(data.length));
  for (let i = 0; i < 8; i++) state[12 + i] = (state[12 + i] as number) ^ (length[i] as number);
  return Buffer.from(state).toString('base64');
}

describe('QuickXorHash', () => {
  it.each(RCLONE_VECTORS)('matches rclone vector of %i bytes', (size, input, out) => {
    const data = Buffer.from(input, 'base64');
    expect(data.length).toBe(size);
    expect(quickXor(data)).toBe(out);
    expect(reference(data)).toBe(out);
  });

  it('hashes empty input to zeros', () => {
    expect(new QuickXorHash().digest()).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  });

  it('matches the reference on inputs that wrap the 160-bit state many times', () => {
    for (const size of [159, 160, 161, 319, 320, 1000, 4096 + 7]) {
      const data = randomBytes(size);
      expect(quickXor(data)).toBe(reference(data));
    }
  });

  it('does not depend on chunk boundaries', () => {
    const data = randomBytes(5000);
    const whole = quickXor(data);
    for (const step of [1, 2, 7, 64, 159, 160, 161, 999]) {
      const h = new QuickXorHash();
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step));
      expect(h.digest()).toBe(whole);
    }
  });

  it('is the default quickXor digester', () => {
    const data = randomBytes(300);
    const d = defaultDigesters('quickXor');
    d.update(data.subarray(0, 100));
    d.update(data.subarray(100));
    expect(d.digest()).toBe(quickXor(data));
  });
});
