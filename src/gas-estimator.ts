//
// TODO: Support searching from L1
//  

import { utils, providers, BigNumber } from "ethers";
import { ArbGasInfo__factory } from "@arbitrum/sdk/dist/lib/abi/factories/ArbGasInfo__factory";
import { ARB_GAS_INFO } from "@arbitrum/sdk/dist/lib/dataEntities/constants";

// Importing configuration //
require('dotenv').config();

// Initial setup //
const baseL2Provider = new providers.StaticJsonRpcProvider(process.env.L2RPC);

const gasEstimator = async () => {
    // ***************************
    // * Gas formula explanation *
    // ***************************
    //
    // Transaction fees (TXFEES) = L2 Gas Price (P) * Gas Limit (G)
    //      ----> Gas Limit (G) = L2 Gas used (L2G) + Extra Buffer for L1 cost (B)
    //      ----> L1 Cost (L1C) = L1 Calldata price per byte (L1P) * L1 Calldata size in bytes (L1S)
    //      ----> Extra Buffer (B) = L1 Cost (L1C) / L2 Gas Price (P)
    //
    // TXFEES = P * (L2G + ((L1P * L1S) / P))

    // ********************************************
    // * How do we get all parts of that equation *
    // ********************************************
    // P (L2 Gas Price) =>
    //      ArbGasInfo.getPricesInWei() and get the sixth element => result[5]
    //      NodeInterface.GasEstimateL1Component() and get the second element => result[1]
    //      NodeInterface.GasEstimateComponents() and get the third element => result[2]
    // L2G (L2 Gas used) => Will depend on the transaction itself
    // L1P (L1 Calldata price per byte) => 
    //      ArbGasInfo.getL1BaseFeeEstimate() and multiply by 16
    //      ArbGasInfo.getL1GasPriceEstimate() and multiply by 16
    //      ArbGasInfo.getPricesInWei() and get the second element => result[1]
    //      NodeInterface.GasEstimateL1Component() and get the third element and multiply by 16 => result[2]*16
    //      NodeInterface.GasEstimateComponents() and get the fourth element and multiply by 16 => result[3]*16
    // L1S (L1 Calldata size in bytes) => Will depend on the size (in bytes) of the calldata

    // ****************************
    // * Other values you can get *
    // ****************************
    // B =>
    //      NodeInterface.GasEstimateL1Component() and get the first element => result[0]
    //      NodeInterface.GasEstimateComponents() and get the second element => result[1]
    //

    // Getting the gas prices from ArbGasInfo
    const arbGasInfo = ArbGasInfo__factory.connect(
        ARB_GAS_INFO,
        baseL2Provider
    );
    const gasComponents = await arbGasInfo.callStatic.getPricesInWei();

    // Setting the transaction dependent variables
    const l2GasUsed = 30000;
    const data = "0x";
    const dataLength = utils.hexDataLength(data);

    // Setting the variables of the formula
    const P = gasComponents[5];
    const L2G = BigNumber.from(l2GasUsed);
    const L1P = gasComponents[1];
    const L1S = dataLength;    // Reference https://etherscan.io/address/0x5aed5f8a1e3607476f1f81c3d8fe126deb0afe94#code => calculateRetryableSubmissionFee

    // Getting the result of the formula
    // ---------------------------------

    // L1C (L1 Cost) = L1P * L1S
    const L1C = L1P.mul(L1S);

    // B (Extra Buffer) = L1C / P
    const B = L1C.div(P);

    // G (Gas Limit) = L2G + B
    const G = L2G.add(B);

    // TXFEES (Transaction fees) = P * G
    const TXFEES = P.mul(G);

    console.log("Transaction summary");
    console.log("-------------------");
    console.log("P (L2 Gas Price) =", P.toNumber());
    console.log("L2G (L2 Gas used) =", L2G.toNumber());
    console.log("L1P (L1 Calldata price per byte) =", L1P.toNumber());
    console.log("L1S (L1 Calldata size in bytes) =", L1S);
    console.log("-------------------");
    console.log("Transaction fees to pay =", TXFEES.toNumber());
}

gasEstimator()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    });