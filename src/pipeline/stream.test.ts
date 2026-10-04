import { pipeline, transformBatch, filterBatch, mapBatch } from './stream';
import { Transaction } from './stream';

function createMockTransaction(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    TransactionID: id,
    TransactionDT: 86400,
    TransactionAmt: 100,
    ProductCD: 'W',
    card1: 'card-1',
    card2: 'visa',
    card3: 'device-1',
    card4: 'us',
    card5: 100,
    card6: 'asn-123',
    addr1: 'US',
    addr2: 'US',
    dist1: 10,
    dist2: 20,
    P_emaildomain: 'gmail.com',
    R_emaildomain: 'yahoo.com',
    ...overrides,
  };
}

describe('Stream Pipeline', () => {
  test('pipeline yields batches of correct size', async () => {
    const transactions = Array(25).fill(null).map((_, i) => createMockTransaction(`txn-${i}`));
    const batches: Transaction[][] = [];

    for await (const batch of pipeline(transactions, 10, 2)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(10);
    expect(batches[1]).toHaveLength(10);
    expect(batches[2]).toHaveLength(5);
  });

  test('transformBatch applies functions in sequence', () => {
    const batch = [1, 2, 3, 4, 5];
    const result = transformBatch(
      batch,
      (arr) => arr.filter(x => x > 2),
      (arr) => arr.map(x => x * 2)
    );
    expect(result).toEqual([6, 8, 10]);
  });

  test('filterBatch filters correctly', () => {
    const batch = [createMockTransaction('1', { TransactionAmt: 50 }),
                   createMockTransaction('2', { TransactionAmt: 150 }),
                   createMockTransaction('3', { TransactionAmt: 200 })];
    const filtered = filterBatch(batch, t => (t.TransactionAmt as number) > 100);
    expect(filtered).toHaveLength(2);
  });

  test('mapBatch transforms correctly', () => {
    const batch = [createMockTransaction('1'), createMockTransaction('2')];
    const mapped = mapBatch(batch, t => t.TransactionID);
    expect(mapped).toEqual(['1', '2']);
  });
});
