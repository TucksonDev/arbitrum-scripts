//
// TODO: Support searching from L1
//  

import { providers } from "ethers";
import { printVerboseLog } from "./utils/presentation";
import { findL2ToL1TxFromL2, findL2ToL1TxFromL1 } from "./utils/crosschain-messaging";
import { L1TransactionReceipt, L2ToL1MessageStatus, L2TransactionReceipt } from "@arbitrum/sdk";

// Importing configuration //
require('dotenv').config();

// Initial setup //
const baseL1Provider = new providers.StaticJsonRpcProvider(process.env.L1RPC);
const baseL2Provider = new providers.StaticJsonRpcProvider(process.env.L2RPC);

const findL2ToL1Tx = async (txHash: string) => {
    // We first try to find the transaction receipt on L2
    const l2txReceipt = await baseL2Provider.getTransactionReceipt(txHash);
    if (l2txReceipt) {
        console.log("Transaction with hash " + txHash + " found on L2.");
        const l2TxSearchResult = await findL2ToL1TxFromL2(new L2TransactionReceipt(l2txReceipt), baseL1Provider, baseL2Provider);

        printVerboseLog("L2 Transaction Receipt", l2txReceipt);
        printVerboseLog("Events", l2TxSearchResult.l2TxEvents);
        printVerboseLog("Message", l2TxSearchResult.l2ToL1MessageReader);
        printVerboseLog("Status", l2TxSearchResult.l2ToL1TxStatus);

        switch (l2TxSearchResult.l2ToL1TxStatus) {
            case L2ToL1MessageStatus.EXECUTED:
                printVerboseLog("Outbox Event", l2TxSearchResult.l1OutboxEvent);
                printVerboseLog("L1 Transaction Receipt", l2TxSearchResult.l1TxReceipt);
                break;
            case L2ToL1MessageStatus.CONFIRMED:
                printVerboseLog("Result", "Message has been confirmed on L1 but not executed.");
                break;
            case L2ToL1MessageStatus.UNCONFIRMED:
                printVerboseLog("Result", "Message has not yet been confirmed on L1.");
                break;
        }
        return;
    }

    console.log("Transaction with hash " + txHash + " was NOT found on L2. L1 searching is still not supported.");
    return;

    // If we don't find it, we search on L1
    const l1txReceipt = await baseL1Provider.getTransactionReceipt(txHash);
    if (l1txReceipt) {
        console.log("Transaction with hash " + txHash + " found on L1.");
        const l1TxSearchResult = await findL2ToL1TxFromL1(new L1TransactionReceipt(l1txReceipt));
        return;
    }

    console.log("Transaction with hash " + txHash + " was NOT found on L1 or L2.");
    return;
}


var args = process.argv.slice(2);
if (args.length === 0) {
    console.log("You must specify an L1 transaction hash as the first parameter of the command.");
} else {
    findL2ToL1Tx(args[0])
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        });
}
