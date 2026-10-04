import { pipeline } from './pipeline/stream';
import { loadTransactions } from './data/loader';
import { createRuleEngine } from './detection/engine';
import { startMetricsServer, recordBatchMetrics } from './metrics/prometheus';
import { logger } from './utils/logger';
import * as fs from 'fs';
import * as path from 'path';

interface Config {
  batchSize: number;
  workers: number;
  dataPath: string;
  ruleConfigPath: string;
  metricsPort: number;
}

function loadConfig(): Config {
  return {
    batchSize: parseInt(process.env.BATCH_SIZE || '10000', 10),
    workers: parseInt(process.env.WORKERS || '4', 10),
    dataPath: process.env.DATA_PATH || './data',
    ruleConfigPath: process.env.RULE_CONFIG || './config/rules.json',
    metricsPort: parseInt(process.env.METRICS_PORT || '9464', 10),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  
  logger.info('Starting UPI Fraud Detection Pipeline', {
    batchSize: config.batchSize,
    workers: config.workers,
    dataPath: config.dataPath,
  });

  // Start Prometheus metrics server
  startMetricsServer(config.metricsPort);
  logger.info(`Metrics server started on port ${config.metricsPort}`);

  // Load rule configuration
  let ruleConfig: Record<string, unknown> = {};
  try {
    const configContent = fs.readFileSync(config.ruleConfigPath, 'utf-8');
    ruleConfig = JSON.parse(configContent);
    logger.info('Loaded rule configuration', { ruleCount: Object.keys(ruleConfig).length });
  } catch (error) {
    logger.warn('No rule config found, using defaults', { error: (error as Error).message });
  }

  // Create rule engine
  const engine = createRuleEngine(ruleConfig);

  // Load transactions from CSV
  const transactionPath = path.join(config.dataPath, 'train_transaction.csv');
  const identityPath = path.join(config.dataPath, 'train_identity.csv');

  if (!fs.existsSync(transactionPath)) {
    logger.error('Transaction CSV not found', { path: transactionPath });
    logger.error('Please download the IEEE-CIS dataset from Kaggle and place train_transaction.csv in the data/ directory');
    process.exit(1);
  }

  logger.info('Loading transactions...', { transactionPath, identityPath });
  const transactions = await loadTransactions(transactionPath, identityPath);
  logger.info(`Loaded ${transactions.length} transactions`);

  // Process through pipeline
  const startTime = Date.now();
  let processed = 0;
  let anomalies = 0;

  for await (const batch of pipeline(transactions, config.batchSize, config.workers)) {
    const batchStart = Date.now();
    
    // Run detection on batch
    const results = await engine.scoreBatch(batch);
    
    const batchAnomalies = results.filter(r => r.isAnomaly).length;
    anomalies += batchAnomalies;
    processed += batch.length;
    
    const duration = (Date.now() - batchStart) / 1000;
    recordBatchMetrics(batch.length, batchAnomalies, duration);
    
    if (processed % 50000 === 0) {
      logger.info('Progress', { processed, anomalies, rate: (processed / ((Date.now() - startTime) / 1000)).toFixed(0) });
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  logger.info('Pipeline completed', {
    totalTransactions: processed,
    totalAnomalies: anomalies,
    anomalyRate: ((anomalies / processed) * 100).toFixed(2) + '%',
    totalTimeSeconds: totalTime.toFixed(1),
    throughput: (processed / totalTime).toFixed(0) + ' txn/s',
  });

  // Keep process alive for metrics scraping
  setTimeout(() => process.exit(0), 5000);
}

main().catch((error) => {
  logger.error('Pipeline failed', { error: error.message, stack: error.stack });
  process.exit(1);
});
