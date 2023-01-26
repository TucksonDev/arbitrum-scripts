import { providers } from "ethers";
import { NodeInterface__factory } from "@arbitrum/sdk/dist/lib/abi/factories/NodeInterface__factory";
import { NODE_INTERFACE_ADDRESS } from "@arbitrum/sdk/dist/lib/dataEntities/constants";
import { SequencerInbox__factory } from "@arbitrum/sdk/dist/lib/abi/factories/SequencerInbox__factory";
import { getL2Network } from "@arbitrum/sdk";

export async function findL1BatchContainingTx(txHash: string, baseL1Provider: providers.StaticJsonRpcProvider, baseL2Provider: providers.StaticJsonRpcProvider) {
    // Instantiate a node interface and the sequencer
    const nodeInterface = NodeInterface__factory.connect(NODE_INTERFACE_ADDRESS, baseL2Provider);

    const l2Network = await getL2Network(baseL2Provider);
    const sequencer = SequencerInbox__factory.connect(l2Network.ethBridge.sequencerInbox, baseL1Provider);

    // Get the txn receipt
    const txnReceipt = await baseL2Provider.getTransactionReceipt(txHash);

    // Find out the L1 txn hash that contains the Batch that contains this txn
    let l1BlockHash = "";
    try {
        // Get the batch number first, and then the events emitted
        const batchResult = await (await nodeInterface.functions.findBatchContainingBlock(txnReceipt.blockNumber)).batch;
        const queryBatch = sequencer.filters.SequencerBatchDelivered(batchResult);
        const emittedEvent = await sequencer.queryFilter(queryBatch);

        // Get the L1 Batch Block event to get the L1 transaction hash
        if (emittedEvent.length !== 0) {
            l1BlockHash = emittedEvent[0].transactionHash;
        }
    } catch(e) {
        throw new Error("Error trying to get the hash of the Batch Block txn, reason: " + e);
    }

    // Find out the number of confirmations of that L1 Batch transaction
    let confirmations = -1;
    try {
        const l1ConfirmationsResult = await nodeInterface.functions.getL1Confirmations(txnReceipt.blockHash);
        confirmations = l1ConfirmationsResult.confirmations.toNumber();
    } catch(e) {
        throw new Error("Error trying to get the confirmations of a block: " + e);
    }

    // Result
    return {
        l2TxHash: txHash,
        l1BlockHash: l1BlockHash,
        confirmations: confirmations
    };
}