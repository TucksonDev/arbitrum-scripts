import { providers, Contract, BigNumber } from 'ethers';
import { getL2Network } from '@arbitrum/sdk';
import { parseTypedLogs } from '@arbitrum/sdk/dist/lib/dataEntities/event';
import { RollupCore__factory } from '@arbitrum/sdk/dist/lib/abi/factories/RollupCore__factory';
import { Outbox__factory } from '@arbitrum/sdk/dist/lib/abi/factories/Outbox__factory';
import { ArbSys__factory } from '@arbitrum/sdk/dist/lib/abi/factories/ArbSys__factory';

// Importing configuration //
import 'dotenv/config';

// Constants
const L1_BLOCK_SPAN_IN_SECONDS = 12.5;

// Initial setup //
const l1Provider = new providers.StaticJsonRpcProvider(process.env.L1RPC);
const l2Provider = new providers.StaticJsonRpcProvider(process.env.L2RPC);

const main = async (l2TransactionHashToVerify: string) => {
  // Use l2Network to find the Rollup contract's address and instantiate a contract handler (we'll need that later)
  const l2Network = await getL2Network(l2Provider);
  const rollupAddress = l2Network.ethBridge.rollup;
  const rollup = new Contract(rollupAddress, RollupCore__factory.abi, l1Provider);
  console.log(`Rollup contract found at address ${rollup.address}`);
  const outboxAddress = l2Network.ethBridge.outbox;
  const outbox = new Contract(outboxAddress, Outbox__factory.abi, l1Provider);
  console.log(`Outbox contract found at address ${outbox.address}`);

  // Getting the L2ToL1Tx event
  const l2TransactionReceipt = await l2Provider.getTransactionReceipt(l2TransactionHashToVerify);
  const parsedLogs = parseTypedLogs(ArbSys__factory, l2TransactionReceipt.logs, 'L2ToL1Tx');
  const l2ToL1TxEvent = parsedLogs[0];
  console.log('L2ToL1Tx event:');
  console.log(l2ToL1TxEvent);

  // Getting the position of this L2->L1 message on the sendMerkle tree
  const positionOfMessage = l2ToL1TxEvent.position.toNumber();
  console.log(`Position of the message in the sendMerkle tree: ${positionOfMessage}`);

  // Getting the latest L2 block processed in the assertion of the latest confirmed RBlock
  const latestConfirmedNode = await rollup.latestConfirmed();
  const latestConfirmedNodeCreatedEventFilter = rollup.filters.NodeCreated(latestConfirmedNode);
  const latestConfirmedNodeCreatedEvents = await rollup.queryFilter(latestConfirmedNodeCreatedEventFilter);
  if (!latestConfirmedNodeCreatedEvents) {
    console.log(`INTERNAL ERROR: NodeCreated events not found for Rblock/node: ${latestConfirmedNode}`);
    return;
  }
  const latestConfirmedNodeCreatedEvent = latestConfirmedNodeCreatedEvents[0];
  if (!latestConfirmedNodeCreatedEvent.args) {
    console.log(`INTERNAL ERROR: NodeCreated event does not have an assertion for Rblock/node: ${latestConfirmedNode}`);
    return;
  }
  // (We need to use provider.send, instead of getBlock, to get the sendCount property, which is specific to Arbitrum)
  const latestL2BlockInConfirmedNode = await l2Provider.send('eth_getBlockByHash', [
    latestConfirmedNodeCreatedEvent.args.assertion.afterState.globalState.bytes32Vals[0],
    false, // Only returns the hashes of the transactions, instead of the full objects
  ]);
  const latestL2BlockNumberInConfirmedNode = BigNumber.from(latestL2BlockInConfirmedNode.number).toNumber();
  const latestL2BlockSendCountInConfirmedNode = BigNumber.from(latestL2BlockInConfirmedNode.sendCount).toNumber();
  console.log(
    `Latest confirmed RBlock is ${latestConfirmedNode} which processed L2 block ${latestL2BlockNumberInConfirmedNode}, which has a sendCount of ${latestL2BlockSendCountInConfirmedNode}`
  );

  // Scenario 1: position of the message is lower than the current confirmed sendCount
  if (latestL2BlockSendCountInConfirmedNode > positionOfMessage) {
    // Check if it has been executed (spent) already
    const messageWasExecuted = await outbox.isSpent(positionOfMessage);
    if (messageWasExecuted) {
      console.log(`L2-to-L1 message from transaction ${l2TransactionHashToVerify} has been executed on L1`);
      return;
    } else {
      console.log(`L2-to-L1 message from transaction ${l2TransactionHashToVerify} can be executed on L1`);
    }
  }

  // Traverse the created RBlock after the latest confirmed, to find the first RBlock that includes the L2->L1 message
  // Here we are just incrementing the node number, but nodes can have multiple children, in a tree-like structure,
  // so in an environment were many disputes are created (and nodes branch out regularly), this method might not be the
  // quickest method to find what we want.
  const latestCreatedNode = await rollup.latestNodeCreated();
  console.log('Searching through the created RBlocks (this process might take a while)');
  for (let nodeId = Number(latestConfirmedNode) + 1; nodeId <= latestCreatedNode; nodeId++) {
    const nodeCreatedEventFilter = rollup.filters.NodeCreated(nodeId);
    const nodeCreatedEvents = await rollup.queryFilter(nodeCreatedEventFilter);
    if (!nodeCreatedEvents || nodeCreatedEvents.length <= 0) {
      continue;
    }
    const nodeCreatedEvent = nodeCreatedEvents[0];
    if (!nodeCreatedEvent.args) {
      continue;
    }
    // (We need to use provider.send, instead of getBlock, to get the sendCount property, which is specific to Arbitrum)
    const latestL2BlockInNode = await l2Provider.send('eth_getBlockByHash', [
      nodeCreatedEvent.args.assertion.afterState.globalState.bytes32Vals[0],
      false, // Only returns the hashes of the transactions, instead of the full objects
    ]);
    const latestL2BlockSendCountInNode = BigNumber.from(latestL2BlockInNode.sendCount).toNumber();

    if (latestL2BlockSendCountInNode > positionOfMessage) {
      console.log(
        `L2-to-L1 message from transaction ${l2TransactionHashToVerify} can be executed when RBlock ${nodeId} is confirmed.`
      );

      // Calculating the date at which it will be confirmed approximately
      const node = await rollup.getNode(nodeId);
      const nodeCreationL1Block = await l1Provider.getBlock(node.createdAtBlock.toNumber());
      const nodeConfirmationDateApprox = new Date(
        (nodeCreationL1Block.timestamp +
          (node.deadlineBlock.toNumber() - node.createdAtBlock.toNumber()) * L1_BLOCK_SPAN_IN_SECONDS) *
          1000
      );
      console.log(`Node ${nodeId} will be confirmed approximately on ${nodeConfirmationDateApprox.toUTCString()}`);
      return;
    }
  }

  console.log(
    `L2-to-L1 message from transaction ${l2TransactionHashToVerify} has not been processed as part of any RBlock yet.`
  );
};

// Getting the transaction hash from the command arguments
if (process.argv.length < 3) {
  console.log(`Missing L2 transaction to verify whether its L2-to-L1 message can be executed on L1 already`);
  console.log(`Usage: npx ts-node src/monitor-withdrawal-transaction.ts <L2 transaction hash>`);
  process.exit();
}

const l2TransactionHash = process.argv[2];

// Calling main
main(l2TransactionHash)
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
