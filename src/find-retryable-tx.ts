//
// TODO:
//  - Support goerli and mainnet at the same time
//  - Other TODOs in the code
//  - Add verbose logs as an argument option
//  - Reverse searching (Get full history from an L2 transaction) still has some cases where it wouldn't
//      work. For example, the case where the retryable ticket does not emit a RedeemedScheduled event.
//

import { providers } from 'ethers';
import { L1TransactionReceipt, L2TransactionReceipt } from '@arbitrum/sdk';
import { printVerboseLog } from './utils/presentation';
import { findRetryableTxFromL1, findRetryableTxFromL2 } from './utils/crosschain-messaging';

// Importing configuration //
require('dotenv').config();

// Initial setup //
const baseL1Provider = new providers.StaticJsonRpcProvider(process.env.L1RPC);
const baseL2Provider = new providers.StaticJsonRpcProvider(process.env.L2RPC);

const findRetryableTx = async (txHash: string) => {
  // We first try to find the transaction receipt on L1
  const l1txReceipt = await baseL1Provider.getTransactionReceipt(txHash);
  if (l1txReceipt) {
    console.log('Transaction with hash ' + txHash + ' found on L1.');
    const l1TxSearchResult = await findRetryableTxFromL1(
      new L1TransactionReceipt(l1txReceipt),
      baseL1Provider,
      baseL2Provider
    );
    printVerboseLog('L1 transaction receipt', l1TxSearchResult.l1txReceipt);

    if (l1TxSearchResult.l1ToL2Message) {
      printVerboseLog('L1 to L2 message', l1TxSearchResult.l1ToL2Message);
      printVerboseLog('Retryable Ticket Id', l1TxSearchResult.retryableTicketId);
      printVerboseLog('Retryable Transaction Receipt', l1TxSearchResult.retryableTxReceipt);
      printVerboseLog('Retryable Ticket Redeem Events', l1TxSearchResult.ticketRedeemEvents);
      printVerboseLog('L2 Transaction Receipt', l1TxSearchResult.l2txReceipt);
    } else {
      printVerboseLog('Deposit message', l1TxSearchResult.depositMessage);
      printVerboseLog('L2 deposit transaction hash', l1TxSearchResult.l2DepositTx);
      printVerboseLog('Deposit Transaction Receipt', l1TxSearchResult.l2DepositTxReceipt);
    }

    return;
  }

  // If we don't find it, we search on L2
  const l2txReceipt = await baseL2Provider.getTransactionReceipt(txHash);
  if (l2txReceipt) {
    console.log('Transaction with hash ' + txHash + ' found on L2.');
    const l2TxSearchResult = await findRetryableTxFromL2(
      new L2TransactionReceipt(l2txReceipt),
      baseL1Provider,
      baseL2Provider
    );
    printVerboseLog('L2 transaction receipt', l2TxSearchResult.l2txReceipt);
    printVerboseLog('Redeem event', l2TxSearchResult.ticketRedeemEvents);
    printVerboseLog('Retryable Transaction Receipt', l2TxSearchResult.retryableTxReceipt);

    if (l2TxSearchResult.l1ToL2Message) {
      printVerboseLog('L1ToL2Message', l2TxSearchResult.l1ToL2Message);
    } else {
      printVerboseLog('DepositMessage', l2TxSearchResult.depositMessage);
    }

    printVerboseLog('L1 Transaction Receipt', l2TxSearchResult.l1txReceipt);
    return;
  }

  console.log('Transaction with hash ' + txHash + ' was NOT found on L1 or L2.');
  return;
};

var args = process.argv.slice(2);
if (args.length === 0) {
  console.log('You must specify an L1 or L2 transaction hash as the first parameter of the command.');
} else {
  findRetryableTx(args[0])
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
