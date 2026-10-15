/**
 * EVM wallets with no library: EIP-6963 discovery (MetaMask, Rabby, Phantom,
 * Coinbase Wallet…) with a window.ethereum fallback, and a hand-encoded
 * ERC-20 transfer(address,uint256).
 */

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface EvmWallet {
  name: string;
  icon: string;
  provider: Eip1193;
}

export function discoverEvmWallets(waitMs = 250): Promise<EvmWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, EvmWallet>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 }>).detail;
      if (d?.info && d.provider) found.set(d.info.rdns || d.info.uuid, { name: d.info.name, icon: d.info.icon, provider: d.provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
      if (found.size === 0 && legacy) found.set("legacy", { name: "Browser wallet", icon: "", provider: legacy });
      resolve([...found.values()]);
    }, waitMs);
  });
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

/** ABI-encode transfer(address,uint256). Selector 0xa9059cbb. */
export function erc20TransferData(to: string, amount: bigint): string {
  if (!HEX_ADDR.test(to)) throw new Error(`not an EVM address: ${to}`);
  if (amount < 0n || amount >= 1n << 256n) throw new Error("amount out of range");
  return "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + amount.toString(16).padStart(64, "0");
}

export async function connectEvm(p: Eip1193, chainIdHex: string): Promise<string> {
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("The wallet didn’t share an account");
  await switchChain(p, chainIdHex);
  return accounts[0];
}

export async function switchChain(p: Eip1193, chainIdHex: string) {
  const current = (await p.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === chainIdHex.toLowerCase()) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (e) {
    if ((e as { code?: number }).code === 4902) throw new Error("Add this network to your wallet first, then try again");
    throw e;
  }
}

export async function sendErc20(p: Eip1193, opts: { from: string; token: string; to: string; amount: bigint; chainIdHex: string }): Promise<string> {
  await switchChain(p, opts.chainIdHex);
  const hash = (await p.request({
    method: "eth_sendTransaction",
    params: [{ from: opts.from, to: opts.token, value: "0x0", data: erc20TransferData(opts.to, opts.amount) }],
  })) as string;
  return hash;
}
