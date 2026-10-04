import { Transaction } from '../pipeline/stream';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

interface IdentityRecord {
  TransactionID: string;
  id_01: string;
  id_02: string;
  id_03: string;
  id_04: string;
  id_05: string;
  id_06: string;
  id_07: string;
  id_08: string;
  id_09: string;
  id_10: string;
  id_11: string;
  id_12: string;
  id_13: string;
  id_14: string;
  id_15: string;
  id_16: string;
  id_17: string;
  id_18: string;
  id_19: string;
  id_20: string;
  id_21: string;
  id_22: string;
  id_23: string;
  id_24: string;
  id_25: string;
  id_26: string;
  id_27: string;
  id_28: string;
  id_29: string;
  id_30: string;
  id_31: string;
  id_32: string;
  id_33: string;
  id_34: string;
  id_35: string;
  id_36: string;
  id_37: string;
  id_38: string;
}

/***
 * Loads transactions from the IEEE-CIS CSV files
 * Merges transaction and identity data on TransactionID
 */
export async function loadTransactions(
  transactionPath: string,
  identityPath?: string
): Promise<Transaction[]> {
  logger.info('Loading transaction data', { transactionPath, identityPath });

  if (!fs.existsSync(transactionPath)) {
    throw new Error(`Transaction file not found: ${transactionPath}`);
  }

  // Load identity data first if available
  let identityMap = new Map<string, IdentityRecord>();
  if (identityPath && fs.existsSync(identityPath)) {
    logger.info('Loading identity data...');
    const identityContent = fs.readFileSync(identityPath, 'utf-8');
    const identityRecords = parse(identityContent, {
      columns: true,
      skip_empty_lines: true,
      cast: (value, context) => {
        if (context.column === 'TransactionID') return value;
        return value === '' ? null : value;
      },
    }) as IdentityRecord[];

    for (const record of identityRecords) {
      identityMap.set(record.TransactionID, record);
    }
    logger.info(`Loaded ${identityMap.size} identity records`);
  }

  // Load transaction data
  logger.info('Parsing transaction CSV...');
  const transactionContent = fs.readFileSync(transactionPath, 'utf-8');
  
  const records = parse(transactionContent, {
    columns: true,
    skip_empty_lines: true,
    cast: (value, context) => {
      if (!value || value === '') return null;
      
      // Numeric columns
      const numericColumns = [
        'TransactionDT', 'TransactionAmt', 'card3', 'card5',
        'addr1', 'addr2', 'dist1', 'dist2',
        'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10',
        'C11', 'C12', 'C13', 'C14',
        'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10',
        'D11', 'D12', 'D13', 'D14', 'D15'
      ];
      
      if (numericColumns.includes(context.column)) {
        const num = parseFloat(value);
        return isNaN(num) ? null : num;
      }
      
      // Integer columns
      const intColumns = ['card1', 'card2', 'card4', 'card6'];
      if (intColumns.includes(context.column)) {
        const int = parseInt(value, 10);
        return isNaN(int) ? null : int;
      }

      return value;
    },
  }) as Transaction[];

  logger.info(`Parsed ${records.length} transaction records`);

  // Merge identity data into transactions
  let mergedCount = 0;
  for (const record of records) {
    const identity = identityMap.get(record.TransactionID);
    if (identity) {
      // Add identity fields with id_ prefix
      for (const [key, value] of Object.entries(identity)) {
        if (key !== 'TransactionID' && value !== null) {
          (record as Record<string, unknown>)[key] = value;
        }
      }
      mergedCount++;
    }
  }

  logger.info(`Merged identity data for ${mergedCount} transactions`);

  // Sort by TransactionDT for temporal processing
  records.sort((a, b) => (a.TransactionDT as number) - (b.TransactionDT as number));

  return records;
}

/***
 * Loads a sample of transactions for testing
 */
export async function loadSampleTransactions(
  transactionPath: string,
  sampleSize: number = 1000
): Promise<Transaction[]> {
  const allTransactions = await loadTransactions(transactionPath);
  
  // Stratified sample: take every Nth transaction
  const step = Math.max(1, Math.floor(allTransactions.length / sampleSize));
  const sampled: Transaction[] = [];
  
  for (let i = 0; i < allTransactions.length && sampled.length < sampleSize; i += step) {
    sampled.push(allTransactions[i]);
  }

  logger.info(`Created sample of ${sampled.length} transactions`);
  return sampled;
}
