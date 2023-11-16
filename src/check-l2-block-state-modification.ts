import { providers, Contract, utils, BigNumber } from 'ethers';
import { EventFetcher, getL2Network } from '@arbitrum/sdk';
import { RollupCore__factory } from '@arbitrum/sdk/dist/lib/abi/factories/RollupCore__factory';

// Importing configuration //
import 'dotenv/config';

// Constants
const L1_BLOCK_SPAN_IN_SECONDS = 12.5;
const SLOTS_IN_EPOCH = 32;

// Initial setup //
const l1Provider = new providers.StaticJsonRpcProvider(process.env.L1RPC);
const l2Provider = new providers.StaticJsonRpcProvider(process.env.L2RPC);

const main = async (l2BlockNumberToVerify: number) => {
  // Use l2Network to find the Rollup contract's address and instantiate a contract handler
  const l2Network = await getL2Network(l2Provider);
  const rollupAddress = l2Network.ethBridge.rollup;
  const rollup = new Contract(rollupAddress, RollupCore__factory.abi, l1Provider);
  console.log(`Rollup contract found at address ${rollup.address}`);

  const latestL1Block = await l1Provider.getBlockNumber();
  const latestL1SafeBlock = latestL1Block - SLOTS_IN_EPOCH;
  const latestL1FinalizedBlock = latestL1SafeBlock - SLOTS_IN_EPOCH;

  // Getting the L2 block
  // (We need to use provider.send, instead of getBlock, to get the l1BlockNumber, which is specific
  // to Arbitrum)
  const l2BlockNumberHex = utils.hexValue(BigNumber.from(l2BlockNumberToVerify).toHexString());
  const l2Block = await l2Provider.send('eth_getBlockByNumber', [
    l2BlockNumberHex,
    false, // Only returns the hashes of the transactions, instead of the full objects
  ]);

  // Calculating the L1 block numbers to filter events
  // RBlocks/Nodes are created roughly every hour. We'll add the number of L1 blocks that
  // roughly correspond to 2 hours of time (to give it some leeway).
  // This would give us 2 (or possibly 1) NodeCreated events
  const l1BlockNumberFrom = BigNumber.from(l2Block.l1BlockNumber).toNumber();
  const l1BlockNumberTo = l1BlockNumberFrom + (2 * 60 * 60) / L1_BLOCK_SPAN_IN_SECONDS;

  // Searching NodeCreated events in that range of blocks
  const eventFetcher = new EventFetcher(l1Provider);
  const nodeCreatedEventsRaw = await eventFetcher.getEvents(
    RollupCore__factory,
    contract => contract.filters.NodeCreated(),
    {
      fromBlock: l1BlockNumberFrom,
      toBlock: l1BlockNumberTo,
      address: rollup.address,
    }
  );
  if (nodeCreatedEventsRaw.length <= 0) {
    console.log(`Block ${l2BlockNumberToVerify} has not been processed yet as part of any assertion.`);
    return;
  }

  // We traverse the events found, to detect which event created the node that
  // contains this L2 block
  // (We are assuming the events are ordered by creation time)
  const nodeCreatedEvents = nodeCreatedEventsRaw.filter(async event => {
    // Get the last L2 block hash that was processed for this assertion
    const lastL2BlockHashOfNode = event.event.assertion.afterState.globalState.bytes32Vals[0];

    // And find the corresponding L2 block number
    const lastL2BlockOfNode = await l2Provider.getBlock(lastL2BlockHashOfNode);
    return lastL2BlockOfNode.number >= l2BlockNumberToVerify;
  });
  if (nodeCreatedEvents.length <= 0) {
    console.log(`L2 block ${l2BlockNumberToVerify} has not been processed yet as part of any assertion.`);
    return;
  }

  // We take the first of the filtered events
  const nodeCreatedEvent = nodeCreatedEvents[0];
  const createdNodeId = nodeCreatedEvent.event.nodeNum.toNumber();
  const createdNode = await rollup.getNode(createdNodeId);
  const nodeCreationL1Block = await l1Provider.getBlock(createdNode.createdAtBlock.toNumber());
  console.log(
    `L2 block ${l2BlockNumberToVerify} was processed on node ${createdNodeId} at L1 block ${nodeCreationL1Block.number}.`
  );

  // We get the latest confirmed node and check against it
  const latestConfirmedNode = await rollup.latestConfirmed();
  if (latestConfirmedNode >= createdNodeId) {
    // Getting L1 block where this node was confirmed
    const nodeConfirmedEventRaw = await eventFetcher.getEvents(
      RollupCore__factory,
      contract => contract.filters.NodeConfirmed(createdNodeId),
      {
        fromBlock: l1BlockNumberFrom,
        toBlock: 'latest',
        address: rollup.address,
      }
    );
    if (nodeConfirmedEventRaw.length <= 0) {
      console.log(
        `INTERNAL ERROR: Could not find the NodeConfirmed event for already confirmed node ${createdNodeId}.`
      );
      return;
    }
    const nodeConfirmationL1Block = nodeConfirmedEventRaw[0].blockNumber;
    console.log(
      `Node ${createdNodeId} was confirmed at block ${nodeConfirmationL1Block}, and the latest confirmed node is ${latestConfirmedNode}.`
    );

    // Checking L1 finality of the L1 block where this node was confirmed
    if (nodeConfirmationL1Block >= latestL1SafeBlock) {
      console.log(
        `L1 block ${nodeConfirmationL1Block} has not been marked as "Safe" yet. Latest L1 block is ${latestL1Block}`
      );
    } else if (nodeConfirmationL1Block >= latestL1FinalizedBlock) {
      console.log(
        `L1 block ${nodeConfirmationL1Block} has been marked as "Safe", but not "Finalized" yet. Latest L1 block is ${latestL1Block}`
      );
    } else {
      console.log(
        `L1 block ${nodeConfirmationL1Block} has been marked as "Finalized". Latest L1 block is ${latestL1Block}`
      );
    }
    return;
  }

  // We get the latest created node and check against it
  const latestCreatedNode = await rollup.latestNodeCreated();
  if (latestCreatedNode >= createdNodeId) {
    console.log(`Node ${createdNodeId} has not been confirmed yet (Latest confirmed node is ${latestConfirmedNode}).`);

    // Calculating the date at which it will be confirmed approximately
    const nodeConfirmationDateApprox = new Date(
      (nodeCreationL1Block.timestamp +
        (createdNode.deadlineBlock.toNumber() - createdNode.createdAtBlock.toNumber()) * L1_BLOCK_SPAN_IN_SECONDS) *
        1000
    );
    console.log(`Node ${createdNodeId} will be confirmed approximately on ${nodeConfirmationDateApprox.toUTCString()}`);
    return;
  }
};

// Getting the transaction hash from the command arguments
if (process.argv.length < 3) {
  console.log(`Missing L2 block number to verify whether it has been processed in the assertion of an RBlock/node`);
  console.log(`Usage: npx ts-node src/check-l2-block-state-modification <L2 block number>`);
  process.exit();
}

const l2BlockNumber = Number(process.argv[2]);

// Calling main
main(l2BlockNumber)
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
