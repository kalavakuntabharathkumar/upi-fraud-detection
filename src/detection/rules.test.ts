import { createFraudRules, buildUserStats } from './rules';
import { Transaction } from '../pipeline/stream';

function createMockTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    TransactionID: 'test-1',
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

describe('Fraud Rules', () => {
  const rules = createFraudRules();

  const mockContext = {
    userHistory: [],
    recentTransactions: [],
    userStats: {
      avgAmount: 150,
      stdDevAmount: 50,
      txnCount: 10,
      uniqueDevices: new Set(['device-1']),
      uniqueEmails: new Set(['gmail.com']),
      activeHours: new Set([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
      commonCountries: new Map([['US', 10]]),
    },
  };

  test('should have 12 rules', () => {
    expect(rules).toHaveLength(12);
  });

  test('high_amount_velocity triggers on rapid high-value transactions', () => {
    const txn = createMockTransaction({ TransactionAmt: 500 });
    const context = {
      ...mockContext,
      recentTransactions: [
        createMockTransaction({ TransactionID: 't1', TransactionAmt: 600, TransactionDT: 86000 }),
        createMockTransaction({ TransactionID: 't2', TransactionAmt: 700, TransactionDT: 86200 }),
      ],
    };
    const rule = rules.find(r => r.id === 'high_amount_velocity')!;
    expect(rule.evaluate(txn, context)).toBe(true);
  });

  test('cnp_mismatch triggers on CNP with address mismatch', () => {
    const txn = createMockTransaction({ ProductCD: 'W', addr1: 'US', addr2: 'CA', TransactionAmt: 600 });
    const rule = rules.find(r => r.id === 'cnp_mismatch')!;
    expect(rule.evaluate(txn, mockContext)).toBe(true);
  });

  test('device_anomaly triggers on new device with high amount', () => {
    const txn = createMockTransaction({ card3: 'new-device', TransactionAmt: 400 });
    const rule = rules.find(r => r.id === 'device_anomaly')!;
    expect(rule.evaluate(txn, mockContext)).toBe(true);
  });

  test('email_domain_risk triggers on free email with high amount', () => {
    const txn = createMockTransaction({ P_emaildomain: 'gmail.com', TransactionAmt: 400 });
    const rule = rules.find(r => r.id === 'email_domain_risk')!;
    expect(rule.evaluate(txn, mockContext)).toBe(true);
  });

  test('behavioral_deviation triggers on statistical outlier', () => {
    const txn = createMockTransaction({ TransactionAmt: 500 }); // 3.5 std dev from mean 150, std 50
    const rule = rules.find(r => r.id === 'behavioral_deviation')!;
    expect(rule.evaluate(txn, mockContext)).toBe(true);
  });

  test('behavioral_deviation does not trigger on normal transaction', () => {
    const txn = createMockTransaction({ TransactionAmt: 180 }); // Within 1 std dev
    const rule = rules.find(r => r.id === 'behavioral_deviation')!;
    expect(rule.evaluate(txn, mockContext)).toBe(false);
  });
});

describe('buildUserStats', () => {
  test('builds stats from transactions', () => {
    const transactions = [
      createMockTransaction({ TransactionID: '1', TransactionAmt: 100, card3: 'dev1', P_emaildomain: 'a@b.com', addr1: 'US', TransactionDT: 0 }),
      createMockTransaction({ TransactionID: '2', TransactionAmt: 200, card3: 'dev2', P_emaildomain: 'c@d.com', addr1: 'US', TransactionDT: 3600 }),
      createMockTransaction({ TransactionID: '3', TransactionAmt: 300, card3: 'dev1', P_emaildomain: 'a@b.com', addr1: 'CA', TransactionDT: 7200 }),
    ];

    const stats = buildUserStats(transactions);
    const userStat = stats.get('card-1');

    expect(userStat).toBeDefined();
    expect(userStat!.txnCount).toBe(3);
    expect(userStat!.avgAmount).toBe(200);
    expect(userStat!.uniqueDevices.size).toBe(2);
    expect(userStat!.uniqueEmails.size).toBe(2);
    expect(userStat!.activeHours.size).toBe(3);
    expect(userStat!.commonCountries.get('US')).toBe(2);
    expect(userStat!.commonCountries.get('CA')).toBe(1);
  });
});
