import { Transaction } from '../pipeline/stream';

/***
 * Fraud detection rule interface
 */
export interface FraudRule {
  id: string;
  name: string;
  description: string;
  weight: number; // 0-1, contribution to final anomaly score
  evaluate: (txn: Transaction, context: RuleContext) => boolean;
}

export interface RuleContext {
  userHistory: Transaction[];
  recentTransactions: Transaction[];
  userStats: UserStats;
}

export interface UserStats {
  avgAmount: number;
  stdDevAmount: number;
  txnCount: number;
  uniqueDevices: Set<string>;
  uniqueEmails: Set<string>;
  activeHours: Set<number>;
  commonCountries: Map<string, number>;
}

/***
 * High-risk email domains (free/temporary providers)
 */
const HIGH_RISK_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'protonmail.com', 'tutanota.com',
  'tempmail.com', '10minutemail.com', 'guerrillamail.com',
  'mailinator.com', 'yopmail.com', 'throwawaymail.com'
]);

/***
 * High-risk product categories
 */
const HIGH_RISK_PRODUCTS = new Set(['W', 'C', 'R']); // Digital goods, gift cards, etc.

/***
 * Known VPN/Proxy/TOR ASN ranges (simplified)
 */
const ANONYMOUS_NETWORK_ASNS = new Set([
  '16509', '14618', '13335', '209242', // Cloud providers often used for VPN
]);

/***
 * Builds user statistics from transaction history
 */
export function buildUserStats(transactions: Transaction[]): Map<string, UserStats> {
  const stats = new Map<string, UserStats>();

  for (const txn of transactions) {
    const cardId = txn.card1 as string;
    let userStat = stats.get(cardId);

    if (!userStat) {
      userStat = {
        avgAmount: 0,
        stdDevAmount: 0,
        txnCount: 0,
        uniqueDevices: new Set(),
        uniqueEmails: new Set(),
        activeHours: new Set(),
        commonCountries: new Map(),
      };
      stats.set(cardId, userStat);
    }

    const amount = txn.TransactionAmt as number;
    userStat.avgAmount = (userStat.avgAmount * userStat.txnCount + amount) / (userStat.txnCount + 1);
    userStat.txnCount++;
    
    if (txn.card3) userStat.uniqueDevices.add(txn.card3 as string);
    if (txn.P_emaildomain) userStat.uniqueEmails.add((txn.P_emaildomain as string).toLowerCase());
    
    const hour = Math.floor((txn.TransactionDT as number) / 3600) % 24;
    userStat.activeHours.add(hour);
    
    if (txn.addr1) {
      const country = txn.addr1 as string;
      userStat.commonCountries.set(country, (userStat.commonCountries.get(country) || 0) + 1);
    }
  }

  // Calculate standard deviation
  for (const [cardId, stat] of stats) {
    const userTxns = transactions.filter(t => t.card1 === cardId);
    const mean = stat.avgAmount;
    const variance = userTxns.reduce((sum, t) => sum + Math.pow((t.TransactionAmt as number) - mean, 2), 0) / userTxns.length;
    stat.stdDevAmount = Math.sqrt(variance);
  }

  return stats;
}

/***
 * Creates the 12 fraud detection rules
 */
export function createFraudRules(config: Record<string, unknown> = {}): FraudRule[] {
  const getWeight = (id: string, defaultWeight: number) =>
    (config[id] as { weight?: number })?.weight ?? defaultWeight;

  return [
    // Rule 1: High Amount Velocity
    {
      id: 'high_amount_velocity',
      name: 'High Amount Velocity',
      description: 'Rapid succession of high-value transactions (>3x avg) within 1 hour',
      weight: getWeight('high_amount_velocity', 0.15),
      evaluate: (txn, ctx) => {
        const amount = txn.TransactionAmt as number;
        const threshold = ctx.userStats.avgAmount * 3;
        if (amount < threshold) return false;

        const recentHigh = ctx.recentTransactions.filter(t =>
          t.card1 === txn.card1 &&
          (t.TransactionDT as number) > (txn.TransactionDT as number) - 3600 &&
          (t.TransactionAmt as number) > threshold
        );
        return recentHigh.length >= 2;
      },
    },

    // Rule 2: Card-Not-Present Mismatch
    {
      id: 'cnp_mismatch',
      name: 'Card-Not-Present Mismatch',
      description: 'CNP transaction with billing/shipping address mismatch',
      weight: getWeight('cnp_mismatch', 0.12),
      evaluate: (txn) => {
        const isCNP = txn.ProductCD === 'W' || txn.ProductCD === 'C';
        const addrMismatch = txn.addr1 !== txn.addr2;
        return isCNP && addrMismatch && (txn.TransactionAmt as number) > 500;
      },
    },

    // Rule 3: Device Fingerprint Anomaly
    {
      id: 'device_anomaly',
      name: 'Device Fingerprint Anomaly',
      description: 'New device (card3) with high transaction value',
      weight: getWeight('device_anomaly', 0.1),
      evaluate: (txn, ctx) => {
        const device = txn.card3 as string;
        const amount = txn.TransactionAmt as number;
        const isNewDevice = device && !ctx.userStats.uniqueDevices.has(device);
        return isNewDevice && amount > ctx.userStats.avgAmount * 2;
      },
    },

    // Rule 4: Email Domain Risk
    {
      id: 'email_domain_risk',
      name: 'Email Domain Risk',
      description: 'Free/temporary email domain used for high-value transaction',
      weight: getWeight('email_domain_risk', 0.08),
      evaluate: (txn) => {
        const email = (txn.P_emaildomain as string)?.toLowerCase();
        const amount = txn.TransactionAmt as number;
        return email && HIGH_RISK_EMAIL_DOMAINS.has(email) && amount > 300;
      },
    },

    // Rule 5: Address Verification Failure
    {
      id: 'avs_failure',
      name: 'Address Verification Failure',
      description: 'AVS mismatch (addr1 != addr2) on high-value transaction',
      weight: getWeight('avs_failure', 0.1),
      evaluate: (txn) => {
        const mismatch = txn.addr1 && txn.addr2 && txn.addr1 !== txn.addr2;
        const highValue = (txn.TransactionAmt as number) > 400;
        return mismatch && highValue;
      },
    },

    // Rule 6: Timezone Deviation
    {
      id: 'timezone_deviation',
      name: 'Timezone Deviation',
      description: 'Transaction outside user\'s normal active hours (2AM-6AM)',
      weight: getWeight('timezone_deviation', 0.07),
      evaluate: (txn, ctx) => {
        const hour = Math.floor((txn.TransactionDT as number) / 3600) % 24;
        const isNightHour = hour >= 2 && hour <= 6;
        const isUnusual = !ctx.userStats.activeHours.has(hour);
        return isNightHour && isUnusual && (txn.TransactionAmt as number) > 200;
      },
    },

    // Rule 7: Transaction Frequency Burst
    {
      id: 'frequency_burst',
      name: 'Transaction Frequency Burst',
      description: 'Unusual spike in transaction count (>10 in 10 minutes)',
      weight: getWeight('frequency_burst', 0.1),
      evaluate: (txn, ctx) => {
        const recent = ctx.recentTransactions.filter(t =>
          t.card1 === txn.card1 &&
          (t.TransactionDT as number) > (txn.TransactionDT as number) - 600
        );
        return recent.length >= 10;
      },
    },

    // Rule 8: Cross-Border Velocity
    {
      id: 'cross_border_velocity',
      name: 'Cross-Border Velocity',
      description: 'Rapid transactions from different countries',
      weight: getWeight('cross_border_velocity', 0.1),
      evaluate: (txn, ctx) => {
        const country = txn.addr1 as string;
        const recentCountries = new Set(
          ctx.recentTransactions
            .filter(t => t.card1 === txn.card1 && (t.TransactionDT as number) > (txn.TransactionDT as number) - 3600)
            .map(t => t.addr1 as string)
            .filter(Boolean)
        );
        return recentCountries.size >= 3 && country && !ctx.userStats.commonCountries.has(country);
      },
    },

    // Rule 9: Product Category Mismatch
    {
      id: 'product_category_mismatch',
      name: 'Product Category Mismatch',
      description: 'High-risk product category (digital goods, gift cards) with new card',
      weight: getWeight('product_category_mismatch', 0.08),
      evaluate: (txn, ctx) => {
        const isHighRisk = HIGH_RISK_PRODUCTS.has(txn.ProductCD);
        const isNewCard = ctx.userStats.txnCount < 5;
        return isHighRisk && isNewCard && (txn.TransactionAmt as number) > 100;
      },
    },

    // Rule 10: Identity Mismatch
    {
      id: 'identity_mismatch',
      name: 'Identity Mismatch',
      description: 'PII fields (card2-card6) inconsistent with historical patterns',
      weight: getWeight('identity_mismatch', 0.07),
      evaluate: (txn, ctx) => {
        if (ctx.userStats.txnCount < 3) return false;
        
        const mismatches = ['card2', 'card4', 'card5', 'card6'].filter(field => {
          const value = txn[field] as string;
          return value && value !== 'unknown';
        }).length;
        
        return mismatches >= 3;
      },
    },

    // Rule 11: Network Anonymization
    {
      id: 'network_anonymization',
      name: 'Network Anonymization',
      description: 'Transaction originating from VPN/Proxy/TOR exit node',
      weight: getWeight('network_anonymization', 0.12),
      evaluate: (txn) => {
        // In real implementation, would check IP against threat intel feeds
        // Using card6 as proxy for network ASN in this dataset
        const asn = txn.card6 as string;
        return asn && ANONYMOUS_NETWORK_ASNS.has(asn);
      },
    },

    // Rule 12: Behavioral Deviation (Statistical Outlier)
    {
      id: 'behavioral_deviation',
      name: 'Behavioral Deviation',
      description: 'Transaction amount is statistical outlier (>3 std dev from user mean)',
      weight: getWeight('behavioral_deviation', 0.11),
      evaluate: (txn, ctx) => {
        const amount = txn.TransactionAmt as number;
        const { avgAmount, stdDevAmount } = ctx.userStats;
        if (stdDevAmount === 0) return false;
        const zScore = Math.abs(amount - avgAmount) / stdDevAmount;
        return zScore > 3;
      },
    },
  ];
}
