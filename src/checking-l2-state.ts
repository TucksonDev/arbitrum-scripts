import { providers, Contract, utils, BigNumber } from "ethers"
import { getL2Network } from '@arbitrum/sdk'
import { RollupCore__factory } from "@arbitrum/sdk/dist/lib/abi/factories/RollupCore__factory"

// Importing configuration //
import 'dotenv/config';

// Initial setup //
const l1Provider = new providers.StaticJsonRpcProvider(process.env.L1RPC)
const l2Provider = new providers.StaticJsonRpcProvider(process.env.L2RPC)

// Configuration //
const useCreatedNodeInsteadOfConfirmed = false;

const main = async () => {
  // Use l2Network to find the Rollup contract's address and instantiate a contract handler
  const l2Network = await getL2Network(l2Provider)
  const rollupAddress = l2Network.ethBridge.rollup
  const rollup = new Contract(rollupAddress, RollupCore__factory.abi, l1Provider)
  console.log(`Rollup contract found at address ${rollup.address}`)

  // Get the latest node created or confirmed
  const nodeId = useCreatedNodeInsteadOfConfirmed ? await rollup.latestNodeCreated() : await rollup.latestConfirmed()
  console.log(`Latest ${useCreatedNodeInsteadOfConfirmed ? 'created' : 'confirmed'} Rblock/node: ${nodeId}`)

  // Get the node for future use
  const node = await rollup.getNode(nodeId)

  // Find the NodeCreated event
  const nodeCreatedEventFilter = rollup.filters.NodeCreated(nodeId)
  const nodeCreatedEvents = await rollup.queryFilter(nodeCreatedEventFilter)
  if (!nodeCreatedEvents) {
    console.log(`INTERNAL ERROR: NodeCreated events not found for Rblock/node: ${nodeId}`)
    return
  }
  const nodeCreatedEvent = nodeCreatedEvents[0]
  console.log(`NodeCreated event found in transaction ${nodeCreatedEvent.transactionHash}`)

  // Finding the assertion within the NodeCreated event, and getting the afterState
  if (!nodeCreatedEvent.args) {
    console.log(`INTERNAL ERROR: NodeCreated event does not have an assertion for Rblock/node: ${nodeId}`)
    return
  }
  const assertion = nodeCreatedEvent.args.assertion

  ///////////////////
  // Global states //
  ///////////////////
  // Before state
  const beforeStateNodeInfo = {
    l2BlockHash: assertion.beforeState.globalState.bytes32Vals[0],
    sendRoot: assertion.beforeState.globalState.bytes32Vals[1],
    inboxPosition: assertion.beforeState.globalState.u64Vals[0],
    positionInMessage: assertion.beforeState.globalState.u64Vals[1]
  }
  const beforeStateL2Block = await l2Provider.getBlock(beforeStateNodeInfo.l2BlockHash)
  const beforeStateL2BlockNumber = beforeStateL2Block.number
  const beforeStateconfirmData = utils.keccak256(utils.solidityPack(['bytes32','bytes32'], [beforeStateNodeInfo.l2BlockHash, beforeStateNodeInfo.sendRoot]))
  console.log('')
  console.log(`------------`)
  console.log(`BEFORE STATE`)
  console.log(`------------`)
  console.log(`Last L2 block hash: ${beforeStateNodeInfo.l2BlockHash} (Block number: ${beforeStateL2BlockNumber})`)
  console.log(`Sendroot: ${beforeStateNodeInfo.sendRoot}`)
  console.log(`Batch number: ${beforeStateNodeInfo.inboxPosition}`)
  console.log(`Position in batch: ${beforeStateNodeInfo.positionInMessage}`)
  console.log(`Confirm data hash: ${beforeStateconfirmData}`)

  // After state
  const afterStateNodeInfo = {
    l2BlockHash: assertion.afterState.globalState.bytes32Vals[0],
    sendRoot: assertion.afterState.globalState.bytes32Vals[1],
    inboxPosition: assertion.afterState.globalState.u64Vals[0],
    positionInMessage: assertion.afterState.globalState.u64Vals[1]
  }
  const afterStateL2Block = await l2Provider.getBlock(afterStateNodeInfo.l2BlockHash)
  const afterStateL2BlockNumber = afterStateL2Block.number
  const afterStateconfirmData = utils.keccak256(utils.solidityPack(['bytes32','bytes32'], [afterStateNodeInfo.l2BlockHash, afterStateNodeInfo.sendRoot]))
  console.log('')
  console.log(`------------`)
  console.log(`AFTER STATE`)
  console.log(`------------`)
  console.log(`Last L2 block hash: ${afterStateNodeInfo.l2BlockHash} (Block number: ${afterStateL2BlockNumber})`)
  console.log(`Sendroot: ${afterStateNodeInfo.sendRoot}`)
  console.log(`Batch number: ${afterStateNodeInfo.inboxPosition}`)
  console.log(`Position in batch: ${afterStateNodeInfo.positionInMessage}`)
  console.log(`Confirm data hash: ${afterStateconfirmData}`)
  
  // Processed blocks
  console.log('')
  console.log(`----------------`)
  console.log(`PROCESSED BLOCKS`)
  console.log(`----------------`)
  console.log(`Number of processed L2 blocks: ${assertion.numBlocks}`)

  ////////////////////////////
  // Node data verification //
  ////////////////////////////
  // We want to authenticate the data from the assertino against the node's confirm data pre-image
  // (This is the process followed in Rollup.confirmNode())
  if (afterStateconfirmData != node.confirmData) {
    console.log(`ERROR: After state confirm data is different than the node's confirm data`)
    return
  }
  console.log(`After state confirm data has been authenticated against the node's confirm data`)

  ////////////////////////////////
  // L2 block hash verification //
  ////////////////////////////////
  const afterStateL2BlockHashes = await l2Provider.send('eth_getBlockByHash', [
    afterStateNodeInfo.l2BlockHash,
    false // Only returns the hashes of the transactions, instead of the full objects
  ])
  
  const afterStateL2BlockInfoArray = [ 
    afterStateL2BlockHashes.parentHash, 
    afterStateL2BlockHashes.sha3Uncles, 
    afterStateL2BlockHashes.miner,
    afterStateL2BlockHashes.stateroot, 
    afterStateL2BlockHashes.transactionsRoot,
    afterStateL2BlockHashes.receiptsRoot,
    afterStateL2BlockHashes.logsBloom,
    BigNumber.from(afterStateL2BlockHashes.difficulty).toHexString(),
    BigNumber.from(afterStateL2BlockHashes.number).toHexString(),
    BigNumber.from(afterStateL2BlockHashes.gasLimit).toHexString(),
    BigNumber.from(afterStateL2BlockHashes.gasUsed).toHexString(),
    BigNumber.from(afterStateL2BlockHashes.timestamp).toHexString(),
    afterStateL2BlockHashes.extraData,
    afterStateL2BlockHashes.mixHash,
    afterStateL2BlockHashes.nonce,
    BigNumber.from(afterStateL2BlockHashes.baseFeePerGas).toHexString(),
  ]
  const afterStateCalculateL2BlockHash = utils.keccak256(utils.RLP.encode(afterStateL2BlockInfoArray))
  if (afterStateCalculateL2BlockHash != afterStateNodeInfo.l2BlockHash) {
    console.log(`ERROR: After state L2 block hash is different than the block's hash`)
    return
  }
  console.log(`After state L2 block hash has been correctly calculated`)
};

// Calling main
main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    });