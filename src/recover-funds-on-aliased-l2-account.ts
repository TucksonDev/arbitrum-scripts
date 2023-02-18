import { utils, providers, Wallet } from "ethers";
import { Address, getL2Network, L1ToL2MessageGasEstimator, L1TransactionReceipt } from '@arbitrum/sdk';
import { Inbox__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Inbox__factory";
import { getBaseFee } from "@arbitrum/sdk/dist/lib/utils/lib";

// Importing configuration //
require('dotenv').config();

// Set up: instantiate L1 / L2 providers and an L1 wallet to sign the transaction
const baseL1Provider = new providers.JsonRpcProvider(process.env.L1RPC);
const baseL2Provider = new providers.JsonRpcProvider(process.env.L2RPC);
const l1Wallet = new Wallet(process.env.TEST_PRIVATE_KEY, baseL1Provider);

// Set the destination address where to send the funds to
const destinationAddress = "0x2D98cBc6f944c4bD36EdfE9f98cd7CB57faEC8d6";

// Some other constants
const callData = "0x";

const recoverFundsOnAliasedL2Account = async () => {
    console.log("Recover funds (ETH) locked on an aliased L2 account");

    // First, obtain the aliased address of the signer
    const signerAddress = new Address(l1Wallet.address);
    const aliasedSignerAddress = signerAddress.applyAlias();

    // And get its balance to find out the amount we are transferring
    // const aliasedSignerBalance = await baseL2Provider.getBalance(aliasedSignerAddress.value);
    const aliasedSignerBalance = utils.parseEther("0.005");
    if (aliasedSignerBalance.lte(0)) {
        console.warn("Address " + signerAddress.value + "(Alias: " + aliasedSignerAddress.value + ") does not have funds on L2");
        return;
    }

    // Getting also the destination address balance to verify it receives it correctly
    const destinationAddressInitialBalance = await baseL2Provider.getBalance(destinationAddress);

    // Summary of the operation
    console.log("Operation to perform: Move " + utils.formatEther(aliasedSignerBalance.toString()) + " ETH from " + aliasedSignerAddress.value + " to " + destinationAddress);

    // We instantiate the Inbox factory object to make use of its methods
    const l2Network = await getL2Network(baseL2Provider);
    const inbox = Inbox__factory.connect(
        l2Network.ethBridge.inbox,
        baseL2Provider
    );

    // We estimate gas usage
    const l1ToL2MessageGasEstimator = new L1ToL2MessageGasEstimator(baseL2Provider);
    
    // The estimateAll method gives us the following values for sending an L1->L2 message
    //      (1) maxSubmissionCost: The maximum cost to be paid for submitting the transaction
    //      (2) gasLimit: The L2 gas limit
    //      (3) maxFeePerGas: The price bid per gas on L2
    //      (4) deposit: The total amount to deposit on L1 to cover L2 gas and L2 call value
    const gasEstimation = await l1ToL2MessageGasEstimator.estimateAll(
        {
            from: aliasedSignerAddress.value,
            to: destinationAddress,
            l2CallValue: aliasedSignerBalance,
            excessFeeRefundAddress: destinationAddress,
            callValueRefundAddress: destinationAddress,
            data: callData,
        },
        await getBaseFee(baseL1Provider),
        baseL1Provider
    );

    // And we send the request through the method unsafeCreateRetryableTicket of the Inbox contract
    // We need this method because we don't want the contract to check that we are not sending the l2CallValue
    // in the "value" of the transaction, because we want to use the amount that is already on L2
    const l1SubmissionTxRaw = await inbox.connect(l1Wallet).unsafeCreateRetryableTicket(
        destinationAddress,                // to
        aliasedSignerBalance,              // l2CallValue
        gasEstimation.maxSubmissionCost,   // maxSubmissionCost
        destinationAddress,                // excessFeeRefundAddress
        destinationAddress,                // callValueRefundAddress
        gasEstimation.gasLimit,            // maxLimit
        gasEstimation.maxFeePerGas,        // maxFeePerGas
        callData,                          // data
        {
            from: signerAddress.value,
            value: gasEstimation.gasLimit.mul(gasEstimation.maxFeePerGas).add(gasEstimation.maxSubmissionCost)
        }
    );

    // We wrap the transaction in monkeyPatchContractCallWait so we can also waitForL2 later on
    const l1SubmissionTx = L1TransactionReceipt.monkeyPatchContractCallWait(l1SubmissionTxRaw);
    const l1SubmissionTxReceipt = await l1SubmissionTx.wait();
    console.log("L1 submission transaction receipt is:", l1SubmissionTxReceipt.transactionHash);

    // With the transaction confirmed on L1, we now wait for the L2 side (i.e., balance credited to L2) to be confirmed as well.
    // Here we're waiting for the Sequencer to include the L2 message in its off-chain queue. The Sequencer should include it in under 15 minutes.
    console.log("Now we wait for L2 side of the transaction to be executed ⏳");
    const l2Result = await l1SubmissionTxReceipt.waitForL2(baseL2Provider);
    if (!l2Result.complete) {
        console.error("Something happened with the L2 message and funds have probably not been transfered yet.");
        return;
    }
    
    console.log("Transaction message executed on L2");

    // The balance of the signer address on L2 should be 0 now
    const aliasedSignerUpdatedBalance = await baseL2Provider.getBalance(aliasedSignerAddress.value);
    console.log(
        "L2 ETH balance of the signer address has been updated from " +
        aliasedSignerBalance.toString() +
        " to " +
        aliasedSignerUpdatedBalance.toString()
    );

    if (!aliasedSignerUpdatedBalance.eq(0)) {
        console.log("ATTENTION! There are still funds on the aliased account: " + aliasedSignerUpdatedBalance.toString());
    }

    // And so should the destination address balance
    const destinationAddressUpdatedBalance = await baseL2Provider.getBalance(destinationAddress);
    console.log(
        "L2 ETH balance of the destination address has been updated from " +
        destinationAddressInitialBalance.toString() +
        " to " +
        destinationAddressUpdatedBalance.toString()
    );
}


recoverFundsOnAliasedL2Account()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    });
