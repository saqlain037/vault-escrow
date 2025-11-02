import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import * as fs from "fs";

const KEYPAIR_PATH = "/Users/saqlaingulamhusein/.config/solana/id.json";

export function loadKeypair(): Keypair {
  const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  const secretKey = Uint8Array.from(raw);
  return Keypair.fromSecretKey(secretKey);
}

// devnet RPC
export const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

// this is the same wallet you used to deploy program + mint token
export const payer = loadKeypair();

export function logPubkeys() {
  console.log("Payer pubkey:", payer.publicKey.toBase58());
}

// helper for reading strings from deploy-info.json into PublicKey
export function pubkeyFromString(s: string): PublicKey {
  return new PublicKey(s);
}
