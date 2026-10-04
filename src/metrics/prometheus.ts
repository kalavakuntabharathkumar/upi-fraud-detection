import promClient from 'prom-client';
import { logger } from '../utils/logger';

// Create a Registry which registers metrics
const register = new promClient.Registry();

// Add default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({ register, prefix: 'upi_' });

// Custom metrics for the fraud detection pipeline
const transactionsProcessed = new promClient.Counter({
  name: 'upi_transactions_processed_total',
  help: 'Total number of transactions processed',
  labelNames: ['status'],
  registers: [register],
});

const batchProcessingDuration = new promClient.Histogram({
  name: 'upi_batch_processing_duration_seconds',
  help: 'Duration of batch processing in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const anomaliesDetected = new promClient.Counter({
  name: 'upi_anomalies_detected_total',
  help: 'Total number of anomalies detected by rule',
  labelNames: ['rule_id'],
  registers: [register],
});

const pipelineErrors = new promClient.Counter({
  name: 'upi_pipeline_errors_total',
  help: 'Total number of pipeline errors',
  labelNames: ['error_type', 'stage'],
  registers: [register],
});

const workerBackpressure = new promClient.Gauge({
  name: 'upi_worker_backpressure_active',
  help: 'Number of workers currently waiting (backpressure indicator)',
  registers: [register],
});

const activeWorkers = new promClient.Gauge({
  name: 'upi_active_workers',
  help: 'Number of currently active workers',
  registers: [register],
});

const anomalyScoreHistogram = new promClient.Histogram({
  name: 'upi_anomaly_score',
  help: 'Distribution of anomaly scores',
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [register],
});

let metricsServer: ReturnType<typeof require('http').createServer> | null = null;

/***
 * Starts the Prometheus metrics HTTP server
 */
export function startMetricsServer(port: number): void {
  const http = require('http');

  metricsServer = http.createServer(async (req: any, res: any) => {
    if (req.url === '/metrics') {
      try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (ex) {
        res.statusCode = 500;
        res.end(ex.message);
      }
    } else if (req.url === '/health') {
      res.set('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'healthy', timestamp: Date.now() }));
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  metricsServer.listen(port, () => {
    logger.info(`Prometheus metrics server listening on port ${port}`);
  });

  metricsServer.on('error', (error: Error) => {
    logger.error('Metrics server error', { error: error.message });
  });
}

/***
 * Records metrics for a processed batch
 */
export function recordBatchMetrics(
  batchSize: number,
  anomalyCount: number,
  durationSeconds: number
): void {
  transactionsProcessed.inc({ status: 'processed' }, batchSize);
  transactionsProcessed.inc({ status: 'anomaly' }, anomalyCount);
  batchProcessingDuration.observe(durationSeconds);
}

/***
 * Records an anomaly detection by rule
 */
export function recordAnomalyByRule(ruleId: string): void {
  anomaliesDetected.inc({ rule_id: ruleId });
}

/***
 * Records a pipeline error
 */
export function recordError(errorType: string, stage: string): void {
  pipelineErrors.inc({ error_type: errorType, stage });
}

/***
 * Updates backpressure gauge
 */
export function setBackpressure(waiting: number): void {
  workerBackpressure.set(waiting);
}

/***
 * Updates active workers gauge
 */
export function setActiveWorkers(count: number): void {
  activeWorkers.set(count);
}

/***
 * Records anomaly score distribution
 */
export function recordAnomalyScore(score: number): void {
  anomalyScoreHistogram.observe(score);
}

/***
 * Gets the Prometheus registry for custom metric access
 */
export function getRegistry(): promClient.Registry {
  return register;
}

/***
 * Gracefully shuts down the metrics server
 */
export function shutdownMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (metricsServer) {
      metricsServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}
