# Command line utils for Arbitrum
This repository holds some scripts that have served me to learn about Arbitrum's protocol.

# Available utils
Following is a description of the scripts available right now:
- Retryable transactions (`find-retryable-tx`): It shows all the information regarding a retryable transaction providing either the L1 transaction or the final L2 transaction.
- L2-to-L1 messages (`find-l2-to-l1-tx`): It shows all the information regarding a L1-to-L2 message providing the initial L2 transaction.
- L1 transaction that contains the batch containing an L2 transaction (`find-l1-batch-containing-tx`): It shows the L1 transaction that contains the batch where an L2 transaction is part of.

# Commands
- To execute: `npx ts-node ./src/<TS_SCRIPT> <ARGS>`
- To compile: `npm run build"`
