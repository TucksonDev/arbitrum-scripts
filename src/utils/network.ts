
// Get an RPC given an L2 chainId
export function getL2RPC(l2ChainId: number): string | void {
    switch (l2ChainId) {
        case 42161:
            return "https://arb1.arbitrum.io/rpc";
        case 42170:
            return "https://nova.arbitrum.io/rpc";
        case 421613:
            return "https://goerli-rollup.arbitrum.io/rpc";
        default:
            throw new Error(
                "Unknown L2 chain id. This chain is not supported by dashboard"
            );
    }
}
