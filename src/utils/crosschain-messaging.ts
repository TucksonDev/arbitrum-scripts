import { BigNumber, providers } from "ethers";
import { EventFetcher, getL1Network, getL2Network, L1ToL2MessageReader, L1TransactionReceipt, L2ToL1MessageStatus, L2TransactionReceipt } from "@arbitrum/sdk";
import { L2ToL1Message } from "@arbitrum/sdk/dist/lib/message/L2ToL1Message";
import * as eventTools from "@arbitrum/sdk/dist/lib/dataEntities/event";
import { ArbSys__factory } from "@arbitrum/sdk/dist/lib/abi/factories/ArbSys__factory";
import { Outbox__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Outbox__factory";
import { ArbRetryableTx__factory } from "@arbitrum/sdk/dist/lib/abi/factories/ArbRetryableTx__factory";
import { NodeInterface__factory } from "@arbitrum/sdk/dist/lib/abi/factories/NodeInterface__factory";
import { SequencerInbox__factory } from "@arbitrum/sdk/dist/lib/abi/factories/SequencerInbox__factory";
import { Bridge__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Bridge__factory";
import { Inbox__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Inbox__factory";
import { EthDepositMessage, L1ToL2Message, L1ToL2MessageStatus } from "@arbitrum/sdk/dist/lib/message/L1ToL2Message";
import * as Constants from "@arbitrum/sdk/dist/lib/dataEntities/constants";
import { getL2RPC } from "./network";
import { SubmitRetryableMessageDataParser } from "@arbitrum/sdk/dist/lib/message/messageDataParser";

// Constants //
const L2_MAX_SEARCHABLE_BLOCKS = 10000;
const L2_SEARCHABLE_BLOCK_CHUNK = 1000;

const L1_ONE_WEEK_BLOCK_OFFSET = 45000;
const L1_MAX_SEARCHABLE_BLOCKS = 10000;
const L1_SEARCHABLE_BLOCK_CHUNK = 1000;


///
////////////////////
// L1 to L2 messaging functions (Retryables)
////////////////////
///
export declare type RetryableSearchResult = {
    l1txReceipt: undefined | L1TransactionReceipt | providers.TransactionReceipt,
    l2txReceipt: undefined | L2TransactionReceipt | providers.TransactionReceipt,

    l1ToL2Message: undefined | L1ToL2MessageReader,
    retryableTicketId: undefined | string,
    retryableTxReceipt: undefined | providers.TransactionReceipt,
    ticketRedeemEvents: undefined | object,

    depositMessage: undefined | EthDepositMessage,
    l2DepositTx: undefined | string,
    l2DepositTxReceipt: undefined | providers.TransactionReceipt,
}

export async function findRetryableTxFromL1(l1txReceipt: L1TransactionReceipt, baseL1Provider: providers.StaticJsonRpcProvider, baseL2Provider: providers.StaticJsonRpcProvider) {
    // Initializing some variables we will need later on
    const l1Network = await getL1Network(baseL1Provider);
    let l1ToL2Messages: L1ToL2MessageReader[] = [];
    let depositMessages: EthDepositMessage[] = [];

    // We instantiate the result object
    let resultObj: RetryableSearchResult = {
        l1txReceipt: l1txReceipt,
        l1ToL2Message: undefined,
        retryableTicketId: undefined,
        retryableTxReceipt: undefined,
        ticketRedeemEvents: undefined,
        l2txReceipt: undefined,
        depositMessage: undefined,
        l2DepositTx: undefined,
        l2DepositTxReceipt: undefined,
    };

    // We then find all logs from the Inbox of one of the L2s (Nitro or Nova)
    for (let l2ChainId of Array.from(new Set(l1Network.partnerChainIDs))) {
        const l2Network = await getL2Network(l2ChainId);

        // The common log sent by the Inbox is InboxMessageDelivered
        const logFromL2Inbox = l1txReceipt.logs.filter((log) => {
            return (
                log.address.toLowerCase() === l2Network.ethBridge.inbox.toLowerCase()
            );
        });
        if (logFromL2Inbox.length === 0) continue;

        // Get the RPC of the L2 chain we are analyzing
        // and set a provider
        const l2RpcUrl = getL2RPC(l2ChainId);
        if (!l2RpcUrl) {
            throw new Error("RPC Url not found for L2 chain id " + l2ChainId);
        }
        const l2Provider = new providers.JsonRpcProvider(l2RpcUrl);

        // We now find all l1-to-l2 messages, searching events emitted by the Bridge
        // for this L1 transaction, and checking its type is L1MessageType_submitRetryableTx (9)
        const currentL1ToL2Messages = await l1txReceipt.getL1ToL2Messages(l2Provider);
        l1ToL2Messages = l1ToL2Messages.concat(currentL1ToL2Messages);

        // And we do the same process for deposits (type is L1MessageType_ethDeposit (12))
        const currentEthDepositMessages = await l1txReceipt.getEthDeposits(l2Provider);
        depositMessages = depositMessages.concat(currentEthDepositMessages);
    }

    if ((l1ToL2Messages.length === 0) && (depositMessages.length === 0)) {
        console.log("No messages were found for transaction with hash " + l1txReceipt.transactionHash);
        return resultObj;
    }

    // Until now, we haven't searched anything on L2, all pieces of info
    // here are scrapped from the L1 transaction

    // We now loop through all found L1-to-L2 messages and try to find the txn on L2
    if (l1ToL2Messages) {
        for (const l1ToL2Message of l1ToL2Messages) {
            // Saving the L1ToL2Message
            resultObj.l1ToL2Message = l1ToL2Message;

            // We first get the Retryable Ticket ID so we know if the L2
            // txn has been executed or not
            const retryableTicketId = l1ToL2Message.retryableCreationId;
            resultObj.retryableTicketId = retryableTicketId;

            // We then check whether the retryable txn has been executed
            const l2RpcUrl = getL2RPC(l1ToL2Message.chainId);
            if (!l2RpcUrl) {
                throw new Error("RPC Url not found for L2 chain id " + l1ToL2Message.chainId);
            }
            const l2Provider = new providers.JsonRpcProvider(l2RpcUrl);

            const retryableTxReceipt = await l2Provider.getTransactionReceipt(retryableTicketId);
            if (!retryableTxReceipt) {
                console.log("Retryable transaction with hash " + retryableTicketId + " was not found on L2 (if the Ticket was just submitted it might still be pending).");
                return resultObj;
            }
            resultObj.retryableTxReceipt = retryableTxReceipt;

            // Check if the creation failed
            if (retryableTxReceipt.status === 0) {
                console.log("Retryable transaction with hash " + retryableTicketId + " FAILED to be created (maybe because the fees paid during the L1 submission was not enough to cover the L2 transaction).");
                return resultObj;
            }

            // Wrapping the transaction receipt into an SDK object
            const l2RetryableTxReceipt = new L2TransactionReceipt(retryableTxReceipt);

            // At this point, we now have a created retryable ticket that might have been executed on L2
            let l2txHash = "";

            // We find if the ticket was autoredeemed (it was automatically executed using the gas
            // provided when submitting the ticket, or scheduled afterwards)
            const ticketRedeemEvents = l2RetryableTxReceipt.getRedeemScheduledEvents();
            if (ticketRedeemEvents.length > 1) {
                console.log("An error occured: Ticket with hash " + retryableTicketId + " has more than 1 redeem events.");
                return resultObj;
            }
            if (ticketRedeemEvents.length === 1) {
                resultObj.ticketRedeemEvents = ticketRedeemEvents;
                l2txHash = ticketRedeemEvents[0].retryTxHash;
            } else {
                console.log("Ticket with hash " + retryableTicketId + " was not autoredeemed");
            }

            // If it wasn't autoredeemed, we look for the a manual redeem
            // To do this, we would search block by block from the moment the ticket was created. We would be searching
            // for the events emitted by the ArbRetryable precompiled contract that holds the retryable ticket ID in its parameters.
            // However, to make things simpler, there's already a function in the SDK that does that: L1ToL2Message.getSuccessfulRedeem().
            // We'll use that instead
            if (l2txHash === "") {
                const manualSearchResult = await l1ToL2Message.getSuccessfulRedeem();
                if (!manualSearchResult) {
                    console.log("An error occurred while manually searching the redemption of the ticket.");
                    return resultObj;
                }

                if (manualSearchResult.status === L1ToL2MessageStatus.EXPIRED) {
                    console.log("Ticket with hash " + retryableTicketId + " has expired.");
                    return resultObj;
                }

                if (manualSearchResult.status === L1ToL2MessageStatus.REDEEMED) {
                    l2txHash = manualSearchResult.l2TxReceipt.transactionHash;
                }
            }

            const l2txReceipt = await l2Provider.getTransactionReceipt(l2txHash);
            if (!l2txReceipt) {
                console.log("L2 transaction with hash " + l2txHash + " was not found on L2 (it might not have been executed yet).");
                return resultObj;
            }
            resultObj.l2txReceipt = l2txReceipt;
        }
    }

    // And now we do the same process for deposit messages
    if (depositMessages) {
        for (const depositMessage of depositMessages) {
            // Saving the EthDeposit message
            resultObj.depositMessage = depositMessage;

            // We first get the calculated deposit transaction in L2
            const l2DepositTx = depositMessage.l2DepositTxHash;
            resultObj.l2DepositTx = l2DepositTx;

            // We then check whether the txn has been executed
            const l2RpcUrl = getL2RPC(depositMessage.l2ChainId);
            if (!l2RpcUrl) {
                throw new Error("RPC Url not found for L2 chain id " + depositMessage.l2ChainId);
            }
            const l2Provider = new providers.JsonRpcProvider(l2RpcUrl);

            const l2DepositTxReceipt = await l2Provider.getTransactionReceipt(l2DepositTx);
            if (!l2DepositTxReceipt) {
                console.log("Deposit transaction with hash " + l2DepositTx + " was not found on L2 (it might not have been executed yet).");
                return resultObj;
            }
            resultObj.l2DepositTxReceipt = l2DepositTxReceipt;
        }
    }

    return resultObj;
}


export async function findRetryableTxFromL2(l2txReceipt: L2TransactionReceipt, baseL1Provider: providers.StaticJsonRpcProvider, baseL2Provider: providers.StaticJsonRpcProvider) {
    // We form the result object
    let resultObj: RetryableSearchResult = {
        l1txReceipt: undefined,
        l1ToL2Message: undefined,
        retryableTicketId: undefined,
        retryableTxReceipt: undefined,
        ticketRedeemEvents: undefined,
        l2txReceipt: l2txReceipt,
        depositMessage: undefined,
        l2DepositTx: undefined,
        l2DepositTxReceipt: undefined,
    };

    // We now search the events of the ArbRetryableTx precompiled contract
    // for a "RedeemedScheduled" event with the hash of the transaction we're looking for
    let retryableTicketId = "";
    const l2EventFetcher = new EventFetcher(baseL2Provider);
    let l2CurrentToBlock = l2txReceipt.blockNumber;
    let l2MinSearchableBlock = l2CurrentToBlock - L2_MAX_SEARCHABLE_BLOCKS;
    while (
        (retryableTicketId === "") &&
        (l2CurrentToBlock > l2MinSearchableBlock)
    ) {
        const redeemEvents = await l2EventFetcher.getEvents(ArbRetryableTx__factory, contract => contract.filters.RedeemScheduled(null, l2txReceipt.transactionHash), {
            fromBlock: l2CurrentToBlock - L2_SEARCHABLE_BLOCK_CHUNK,
            toBlock: l2CurrentToBlock,
            address: Constants.ARB_RETRYABLE_TX_ADDRESS,
        });

        // TODO: Error check
        if (redeemEvents.length > 0) {
            resultObj.ticketRedeemEvents = redeemEvents[0];
            retryableTicketId = redeemEvents[0].transactionHash;
        }

        l2CurrentToBlock = l2CurrentToBlock - L2_SEARCHABLE_BLOCK_CHUNK;
    }

    let isL1ToL2Message = false;
    if (retryableTicketId !== "") {
        // It is an L1ToL2Message, we get the Retryable ticket transaction Receipt
        const retryableTxReceipt = await baseL2Provider.getTransactionReceipt(retryableTicketId);
        if (!retryableTxReceipt) {
            console.log("Retryable transaction with hash " + retryableTicketId + " was not found on L2.");
            return resultObj;
        }
        isL1ToL2Message = true;
        resultObj.retryableTxReceipt = retryableTxReceipt;
    }
    

    // We now find the L1 block where this transaction was submitted, to have a reference point
    // for the final search
    // Instantiate a node interface and the sequencer
    const baseL2Network = await getL2Network(baseL2Provider);
    const nodeInterface = NodeInterface__factory.connect(Constants.NODE_INTERFACE_ADDRESS, baseL2Provider);
    const sequencer = SequencerInbox__factory.connect(baseL2Network.ethBridge.sequencerInbox, baseL1Provider);

    // Get the batch number first, and then the events emitted
    const batchResult = await (await nodeInterface.functions.findBatchContainingBlock(l2txReceipt.blockNumber)).batch;
    const queryBatch = sequencer.filters.SequencerBatchDelivered(batchResult);
    const emittedEvent = await sequencer.queryFilter(queryBatch);

    // Get the L1 block event to get the L1 transaction hash
    if (emittedEvent.length === 0) {
        console.log("Could not find the transaction in any submitted batch.");
        return resultObj;
    }
    const l1BatchTxHash = emittedEvent[0].transactionHash;

    // We get the transaction, and obtain the block
    const l1BatchtxReceipt = await baseL1Provider.getTransactionReceipt(l1BatchTxHash);
    const l1BatchBlock = l1BatchtxReceipt.blockNumber;

    // Finally, we try to search the originator transaction on L1
    // Now this is tricky to do, but we'll search for 1K blocks see if we find it.
    // Allow a bit of time for this piece of code to execute
    let l1TxHash = "";
    const l1EventFetcher = new EventFetcher(baseL1Provider);
    let l1CurrentToBlock = l1BatchBlock;
    let l1MinSearchableBlock = l1CurrentToBlock - L1_MAX_SEARCHABLE_BLOCKS;
    while (
        (l1TxHash === "") &&
        (l1CurrentToBlock > l1MinSearchableBlock)
    ) {
        const messageDeliveredEvents = await l1EventFetcher.getEvents(Bridge__factory, contract => contract.filters.MessageDelivered(), {
            fromBlock: l1CurrentToBlock - L1_SEARCHABLE_BLOCK_CHUNK,
            toBlock: l1CurrentToBlock,
            address: baseL2Network.ethBridge.bridge,
        });

        const inboxMessageDeliveredEvents = await l1EventFetcher.getEvents(Inbox__factory, contract => contract.filters.InboxMessageDelivered(), {
            fromBlock: l1CurrentToBlock - L1_SEARCHABLE_BLOCK_CHUNK,
            toBlock: l1CurrentToBlock,
            address: baseL2Network.ethBridge.inbox,
        });
        
        if (messageDeliveredEvents.length > 0) {
            for (let i = 0; i < messageDeliveredEvents.length; i++) {
                const currentMessageDeliveredEvent = messageDeliveredEvents[i];
                const currentInboxMessageDeliveredEvent = inboxMessageDeliveredEvents.filter(elem => elem.event.messageNum.eq(currentMessageDeliveredEvent.event.messageIndex))[0];
                if (currentMessageDeliveredEvent && currentInboxMessageDeliveredEvent) {
                    try {
                        if (isL1ToL2Message) {
                            const l1ToL2Message = L1ToL2Message.fromEventComponents(
                                baseL2Provider,
                                baseL2Network.chainID,
                                currentMessageDeliveredEvent.event.sender,
                                currentInboxMessageDeliveredEvent.event.messageNum,
                                currentMessageDeliveredEvent.event.baseFeeL1,
                                new SubmitRetryableMessageDataParser().parse(currentInboxMessageDeliveredEvent.event.data)
                            );

                            if (
                                l1ToL2Message &&
                                (l1ToL2Message.retryableCreationId == retryableTicketId)
                            ) {
                                // FOUND IT !!!
                                resultObj.l1ToL2Message = l1ToL2Message;
                                l1TxHash = currentMessageDeliveredEvent.transactionHash;
                            }
                        } else {
                            const depositMessage = await EthDepositMessage.fromEventComponents(
                                baseL2Provider,
                                currentInboxMessageDeliveredEvent.event.messageNum,
                                currentMessageDeliveredEvent.event.sender,
                                currentInboxMessageDeliveredEvent.event.data
                            );
                            if (
                                depositMessage &&
                                (depositMessage.l2DepositTxHash == l2txReceipt.transactionHash)
                            ) {
                                // FOUND IT !!!
                                resultObj.depositMessage = depositMessage;
                                l1TxHash = currentMessageDeliveredEvent.transactionHash;
                            }
                        }
                    } catch (e: any) {
                        // console.log("Error trying to decode information of the message data");
                    }
                }
            }
        }

        l1CurrentToBlock = l1CurrentToBlock - L1_SEARCHABLE_BLOCK_CHUNK;
    }
    
    if (l1TxHash === "") {
        console.log("Could not find the L1 transaction after searching for " + L1_MAX_SEARCHABLE_BLOCKS + " blocks.");
        return resultObj;
    }

    const l1txReceipt = await baseL1Provider.getTransactionReceipt(l1TxHash);
    resultObj.l1txReceipt = l1txReceipt;
    
    return resultObj;
}



///
////////////////////
// L2 to L1 messaging functions
////////////////////
///
export async function findL2ToL1TxFromL2(l2TxReceipt: L2TransactionReceipt, baseL1Provider: providers.StaticJsonRpcProvider, baseL2Provider: providers.StaticJsonRpcProvider) {
    // We first get all events to have all needed information //
    const l2TxEvent = await l2TxReceipt.getL2ToL1Events()[0];
    const merkleUpdateEvents = eventTools.parseTypedLogs(ArbSys__factory, l2TxReceipt.logs, 'SendMerkleUpdate');

    // Then we instantiate the L2ToL1MessageReader object we need
    const l2ToL1MessageReader = L2ToL1Message.fromEvent(baseL1Provider, l2TxEvent);

    // And get the status of the transaction
    const l2ToL1TxStatus = await l2ToL1MessageReader.status(baseL2Provider);

    // If the transaction has been executed, we try to find the correspondent L1 transaction
    let l1TxReceipt;
    let l1OutboxEvent;
    if (l2ToL1TxStatus === L2ToL1MessageStatus.EXECUTED) {
        const baseL2Network = await getL2Network(baseL2Provider);
        const l1EventFetcher = new EventFetcher(baseL1Provider);
        let l1CurrentFromBlock = l2TxEvent.ethBlockNum.toNumber() + L1_ONE_WEEK_BLOCK_OFFSET;
        const l1MaxSearchableBlock = l1CurrentFromBlock + L1_MAX_SEARCHABLE_BLOCKS;
        while (
            (!l1OutboxEvent) &&
            (l1CurrentFromBlock < l1MaxSearchableBlock)
        ) {
            const outboxTxExecutedEvents = await l1EventFetcher.getEvents(
                Outbox__factory,
                contract => contract.filters.OutBoxTransactionExecuted(
                    l2TxEvent.destination,
                    l2TxEvent.caller
                    // We can't search by the position (transactionIndex) as it is not indexed
                ),
                {
                    fromBlock: l1CurrentFromBlock,
                    toBlock: l1CurrentFromBlock + L1_SEARCHABLE_BLOCK_CHUNK,
                    address: baseL2Network.ethBridge.outbox,
                }
            );

            // Little hack here:
            //      - As the SDK does not provides the "position" from the L2 transaction event,
            //          we have to get it looking directly in the log from the Receipt.
            if (outboxTxExecutedEvents.length > 0) {
                for (let i = 0; i < outboxTxExecutedEvents.length; i++) {
                    if (outboxTxExecutedEvents[i].event.transactionIndex.eq(BigNumber.from(l2TxReceipt.logs[0].topics[3]))) {
                        l1OutboxEvent = outboxTxExecutedEvents[i];
                    }
                }
            }

            l1CurrentFromBlock = l1CurrentFromBlock + L1_SEARCHABLE_BLOCK_CHUNK;
        }

        if (l1OutboxEvent) {
            l1TxReceipt = await baseL1Provider.getTransactionReceipt(l1OutboxEvent.transactionHash);
        }
    }
    
    return {
        result: true,
        l2TxEvents: [l2TxEvent, ...merkleUpdateEvents],
        l2ToL1MessageReader: l2ToL1MessageReader,
        l2ToL1TxStatus: l2ToL1TxStatus,
        l1TxReceipt: l1TxReceipt,
        l1OutboxEvent: l1OutboxEvent
    };
}

export async function findL2ToL1TxFromL1(l1TxReceipt: L1TransactionReceipt) {
    // We first get the outbox event to have all needed information //
    const l1OutboxEvent = eventTools.parseTypedLogs(Outbox__factory, l1TxReceipt.logs, 'OutBoxTransactionExecuted');
}
