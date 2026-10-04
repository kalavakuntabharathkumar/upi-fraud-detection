import { Transaction } from '../pipeline/stream';
import { FraudRule, RuleContext, UserStats, createFraudRules, buildUserStats } from './rules';
import { logger } from '../utils/logger';

/***
 * Anomaly detection result for a single transaction
 */
export interface AnomalyResult {
  transactionId: string;
  isAnomaly: boolean;
  anomalyScore: number; // 0-1
  triggeredRules: string[];
  ruleScores: Record<string, number>;
}

/***
 * Rule engine configuration
 */
export interface EngineConfig {
  anomalyThreshold: number;
  rules: FraudRule[];
}

const DEFAULT_CONFIG: EngineConfig = {
  anomalyThreshold: 0.5,
  rules: createFraudRules(),
};

/***
 * Creates a configured rule engine
 */
export function createRuleEngine(config: Record<string, unknown> = {}): RuleEngine {
  const rules = createFraudRules(config);
  const threshold = (config.anomalyThreshold as number) ?? DEFAULT_CONFIG.anomalyThreshold;
  return new RuleEngine(rules, threshold);
}

/***
 * Rule engine for scoring transactions against fraud patterns
 */
export class RuleEngine {
  private rules: FraudRule[];
  private threshold: number;
  private userStats: Map<string, UserStats> = new Map();
  private recentWindow: Transaction[] = [];
  private readonly WINDOW_SIZE = 10000; // Keep last 10K transactions for context

  constructor(rules: FraudRule[], threshold: number) {
    this.rules = rules;
    this.threshold = threshold;
    logger.info('Rule engine initialized', { ruleCount: rules.length, threshold });
  }

  /****
   * Scores a batch of transactions
   */
  async scoreBatch(transactions: Transaction[]): Promise<AnomalyResult[]> {
    // Build/update user stats from current batch
    this.updateUserStats(transactions);

    const results: AnomalyResult[] = [];

    for (const txn of transactions) {
      const context = this.buildContext(txn);
      const result = this.scoreTransaction(txn, context);
      results.push(result);

      // Add to recent window for velocity rules
      this.recentWindow.push(txn);
      if (this.recentWindow.length > this.WINDOW_SIZE) {
        this.recentWindow.shift();
      }
    }

    return results;
  }

  /****
   * Scores a single transaction against all rules
   */
  private scoreTransaction(txn: Transaction, context: RuleContext): AnomalyResult {
    const triggeredRules: string[] = [];
    const ruleScores: Record<string, number> = {};
    let totalScore = 0;
    let totalWeight = 0;

    for (const rule of this.rules) {
      try {
        const triggered = rule.evaluate(txn, context);
        ruleScores[rule.id] = triggered ? rule.weight : 0;
        
        if (triggered) {
          triggeredRules.push(rule.id);
          totalScore += rule.weight;
        }
        totalWeight += rule.weight;
      } catch (error) {
        logger.warn('Rule evaluation failed', { rule: rule.id, error: (error as Error).message });
        ruleScores[rule.id] = 0;
      }
    }

    const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : 0;

    return {
      transactionId: txn.TransactionID,
      isAnomaly: normalizedScore >= this.threshold,
      anomalyScore: normalizedScore,
      triggeredRules,
      ruleScores,
    };
  }

  /****
   * Builds rule evaluation context for a transaction
   */
  private buildContext(txn: Transaction): RuleContext {
    const cardId = txn.card1 as string;
    const userStats = this.userStats.get(cardId) || this.getDefaultStats();
    
    // Get recent transactions for this user (last hour)
    const oneHourAgo = (txn.TransactionDT as number) - 3600;
    const recentTransactions = this.recentWindow.filter(t =>
      t.card1 === cardId && (t.TransactionDT as number) > oneHourAgo
    );

    return {
      userHistory: [], // Would be populated from historical data in production
      recentTransactions,
      userStats,
    };
  }

  /****
   * Updates user statistics with new transactions
   */
  private updateUserStats(transactions: Transaction[]): void {
    const newStats = buildUserStats(transactions);
    
    for (const [cardId, stats] of newStats) {
      const existing = this.userStats.get(cardId);
      if (existing) {
        // Merge stats (simplified - in production use proper streaming stats)
        existing.txnCount += stats.txnCount;
        existing.avgAmount = (existing.avgAmount + stats.avgAmount) / 2;
        for (const device of stats.uniqueDevices) existing.uniqueDevices.add(device);
        for (const email of stats.uniqueEmails) existing.uniqueEmails.add(email);
        for (const hour of stats.activeHours) existing.activeHours.add(hour);
        for (const [country, count] of stats.commonCountries) {
          existing.commonCountries.set(country, (existing.commonCountries.get(country) || 0) + count);
        }
      } else {
        this.userStats.set(cardId, stats);
      }
    }
  }

  private getDefaultStats(): UserStats {
    return {
      avgAmount: 150,
      stdDevAmount: 100,
      txnCount: 0,
      uniqueDevices: new Set(),
      uniqueEmails: new Set(),
      activeHours: new Set(),
      commonCountries: new Map(),
    };
  }

  /****
   * Gets engine statistics
   */
  getStats(): { ruleCount: number; threshold: number; trackedUsers: number } {
    return {
      ruleCount: this.rules.length,
      threshold: this.threshold,
      trackedUsers: this.userStats.size,
    };
  }
}
