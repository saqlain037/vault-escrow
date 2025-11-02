import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";

import * as fs from "fs";
import { connection, payer, logPubkeys } from "./_shared";

(async () => {
  // Just to show who we are using to sign
  logPubkeys();

  // === You can customize these ===
  const TOKEN_NAME = "Goblin Gold"; // fun/creative token name
  const DECIMALS = 6;               // like USDC (6 decimal places)

  // We’ll mint 1,000,000 tokens to you.
  // With 6 decimals, "1,000,000 tokens" means:
  //   amount = 1_000_000 * 10^6 = 1_000_000_000_000 base units.
  const INITIAL_AMOUNT = 1_000_000n * 1_000_000n; // bigint

  // 1. Generate a brand new mint account keypair
  const mintKeypair = Keypair.generate();

  // 2. Calculate rent for the mint account
  const rentLamports = await getMinimumBalanceForRentExemptMint(connection);

  // 3. Instruction: create the mint account on-chain
  const createMintIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    lamports: rentLamports,
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  });

  // 4. Instruction: initialize the mint
  const initMintIx = createInitializeMint2Instruction(
    mintKeypair.publicKey,
    DECIMALS,
    payer.publicKey, // mint authority
    payer.publicKey  // freeze authority
  );

  // 5. Derive (and create) your Associated Token Account (ATA) for this mint
  const payerAta = await getAssociatedTokenAddress(
    mintKeypair.publicKey, // mint
    payer.publicKey,       // owner
    false,
    TOKEN_PROGRAM_ID
  );

  const createAtaIx = createAssociatedTokenAccountInstruction(
    payer.publicKey,         // payer funds the ATA creation
    payerAta,                // ATA address
    payer.publicKey,         // ATA owner
    mintKeypair.publicKey,   // mint
    TOKEN_PROGRAM_ID
  );

  // 6. Instruction: mint INITIAL_AMOUNT tokens into your ATA
  // Note: spl-token lib wants `number` for amount, but this can overflow JS number
  // for huge supplies. Our INITIAL_AMOUNT is 1_000_000 * 10^6 = 1e12, which still
  // fits in JS's safe integer range? 1e12 < 2^53 (~9e15), so it's fine.
  const mintToIx = createMintToInstruction(
    mintKeypair.publicKey,
    payerAta,
    payer.publicKey,
    Number(INITIAL_AMOUNT), // safe here
    [],
    TOKEN_PROGRAM_ID
  );

  // 7. Send the transaction with all the above steps
  const tx = new Transaction().add(
    createMintIx,
    initMintIx,
    createAtaIx,
    mintToIx
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [
    payer,
    mintKeypair,
  ]);

  console.log("✅ Mint created and funded!");
  console.log("Signature:", sig);
  console.log("Mint address:", mintKeypair.publicKey.toBase58());
  console.log("Your ATA for this mint:", payerAta.toBase58());

  // 8. Save info that script 2 will need
  const info = {
    programId: "AhtmyF1FM2NwGYECDzgjC6jbNtPnSRDFzhahugFfqkZW", // your deployed program ID on devnet
    mint: mintKeypair.publicKey.toBase58(),                    // the token mint we just made
    payer: payer.publicKey.toBase58(),                         // you (buyer/authority)
    payerAta: payerAta.toBase58(),                             // your token account
    decimals: DECIMALS,
    tokenName: TOKEN_NAME,
  };

  fs.writeFileSync("deploy-info.json", JSON.stringify(info, null, 2));
  console.log("Wrote deploy-info.json:");
  console.log(info);
})();
