import { providers } from 'ethers';
import { findL1BatchContainingTx } from './utils/arb-basics';

// Importing configuration //
require('dotenv').config();

// Initial setup //
const baseL1Provider = new providers.JsonRpcProvider(process.env.L1RPC);
const baseL2Provider = new providers.JsonRpcProvider(process.env.L2RPC);

var args = process.argv.slice(2);
if (args.length === 0) {
  console.log('You must specify an L2 transaction hash as the first parameter of the command.');
} else {
  findL1BatchContainingTx(args[0], baseL1Provider, baseL2Provider)
    .then(result => {
      if (result.l1BlockHash === '') {
        console.log('Txn ' + result.l2TxHash + ' has not been included in L1 yet.');
      } else if (result.confirmations <= 0) {
        console.log(
          'Txn ' +
            result.l2TxHash +
            ' has been included in an L1 Batch Block in txn ' +
            result.l1BlockHash +
            ' but it has not been confirmed yet.'
        );
      } else {
        console.log(
          'Txn ' +
            result.l2TxHash +
            ' was included in an L1 Batch Block in txn ' +
            result.l1BlockHash +
            ' which has ' +
            result.confirmations +
            ' confirmations.'
        );
      }
      process.exit(0);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
