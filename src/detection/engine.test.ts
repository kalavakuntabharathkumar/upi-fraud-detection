import { createRuleEngine } from './engine';
import { Transaction } from '../pipeline/stream';

function createMockTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    TransactionID: `txn-${Math.random()}`, 
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

describe('RuleEngine', () => {
  const engine = createRuleEngine({ anomalyThreshold: 0.3 });

  test('scores normal transaction as non-anomaly', async () => {
    const txn = createMockTransaction({ TransactionAmt: 100 });
    const results = await engine.scoreBatch([txn]);
    
    expect(results).toHaveLength(1);
    expect(results[0].isAnomaly).toBe(false);
    expect(results[0].anomalyScore).toBeLessThan(0.3);
  });

  test('scores high-risk transaction as anomaly', async () => {
    const txn = createMockTransaction({
      TransactionAmt: 5000,
      ProductCD: 'W',
      addr1: 'US',
      addr2: 'CA',
      card3: 'new-device',
      P_emaildomain: 'tempmail.com',
    });
    
    // Add some history so rules have context
    const history = Array(10).fill(null).map((_, i) => 
      createMockTransaction({ TransactionID: `hist-${i}`, TransactionAmt: 100, TransactionDT: 80000 + i * 100 })
    );
    await engine.scoreBatch(history);
    
    const results = await engine.scoreBatch([txn]);
    
    expect(results[0].isAnomaly).toBe(true);
    expect(results[0].anomalyScore).toBeGreaterThan(0.3);
    expect(results[0].triggeredRules.length).toBeGreaterThan(0);
  });

  test('processes batch of transactions', async () => {
    const batch = Array(100).fill(null).map((_, i) =>
      createMockTransaction({ TransactionID: `batch-${i}`, TransactionAmt: 100 + i })
    );

    const results = await engine.scoreBatch(batch);
    
    expect(results).toHaveLength(100);
    expect(results.every(r => typeof r.anomalyScore === 'number')).toBe(true);
    expect(results.every(r => typeof r.isAnomaly === 'boolean')).toBe(true);
  });

  test('tracks user stats across batches', async () => {
    const batch1 = Array(5).fill(null).map((_, i) =>
      createMockTransaction({ TransactionID: `b1-${i}`, TransactionAmt: 100, card1: 'user-1' })
    );
    await engine.scoreBatch(batch1);

    const batch2 = [createMockTransaction({ TransactionID: 'b2-1', TransactionAmt: 5000, card1: 'user-1' })];
    const results = await engine.scoreBatch(batch2);

    // Should detect behavioral deviation
    expect(results[0].ruleScores.behavioral_deviation).toBeGreaterThan(0);
  });
});
