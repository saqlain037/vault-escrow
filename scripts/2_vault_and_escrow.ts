import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";

import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import * as fs from "fs";
import { createHash } from "crypto";
import { connection, payer, pubkeyFromString } from "./_shared";

/**
 * Derive the Vault PDA:
 * seeds = ["vault", mint, authority]
 * authority = buyer wallet
 */
async function deriveVaultPda(
  programId: PublicKey,
  mint: PublicKey,
  authority: PublicKey
): Promise<[PublicKey, number]> {
  return await PublicKey.findProgramAddress(
    [Buffer.from("vault"), mint.toBuffer(), authority.toBuffer()],
    programId
  );
}

/**
 * Anchor instruction discriminator = first 8 bytes of sha256("global:<fn_name>")
 */
function discriminator(ixName: string): Buffer {
  const preimage = `global:${ixName}`;
  const hash = createHash("sha256").update(preimage).digest();
  return hash.subarray(0, 8);
}

/**
 * init_vault()
 *
 * Accounts (from your program):
 *  authority (signer, mut)
 *  mint
 *  vault (PDA, init, payer = authority)
 *  system_program
 */
function encodeInitVaultIx(params: {
  programId: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  vaultPda: PublicKey;
}): TransactionInstruction {
  const data = discriminator("init_vault"); // no args

  const keys = [
    { pubkey: params.authority, isSigner: true, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.vaultPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: params.programId,
    keys,
    data,
  });
}

/**
 * lock_tokens(amount: u64)
 *
 * Accounts (from your program):
 *  user (signer, mut)
 *  mint
 *  vault (PDA)
 *  vault_ata (must ALREADY EXIST as an initialized SPL TokenAccount for `mint`, owned by `vault`)
 *  user_ata (user's ATA)
 *  token_program
 *  associated_token_program
 *  system_program
 *
 * Args:
 *   [8-byte discriminator][amount: u64 little-endian]
 */
function encodeLockTokensIx(params: {
  programId: PublicKey;
  user: PublicKey;
  mint: PublicKey;
  vaultPda: PublicKey;
  vaultAta: PublicKey;
  userAta: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const disc = discriminator("lock_tokens");

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(params.amount);

  const data = Buffer.concat([disc, amountBuf]);

  const keys = [
    { pubkey: params.user, isSigner: true, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },

    { pubkey: params.vaultPda, isSigner: false, isWritable: false },

    { pubkey: params.vaultAta, isSigner: false, isWritable: true },
    { pubkey: params.userAta, isSigner: false, isWritable: true },

    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: params.programId,
    keys,
    data,
  });
}

(async () => {
  //
  // 1. Load deploy-info.json written by 1_create_mint.ts
  //
  const raw = fs.readFileSync("deploy-info.json", "utf8");
  const info = JSON.parse(raw);

  const programId = pubkeyFromString(info.programId);
  const mint = pubkeyFromString(info.mint);
  const buyer = pubkeyFromString(info.payer); // authority
  const buyerAta = pubkeyFromString(info.payerAta);

  console.log("Program ID:", programId.toBase58());
  console.log("Mint:", mint.toBase58());
  console.log("Buyer (authority):", buyer.toBase58());
  console.log("Buyer ATA:", buyerAta.toBase58());

  // safety: local payer must match deploy-info.json payer
  if (!buyer.equals(payer.publicKey)) {
    throw new Error(
      "Wallet mismatch: deploy-info.json payer != local payer.publicKey"
    );
  }

  //
  // 2. Derive vault PDA and its ATA (for this mint)
  //
  const [vaultPda /* bump */] = await deriveVaultPda(programId, mint, buyer);
  console.log("Vault PDA:", vaultPda.toBase58());

  const vaultAta = await getAssociatedTokenAddress(
    mint,
    vaultPda,
    true, // PDA owner, off-curve
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  console.log("Vault ATA:", vaultAta.toBase58());

  //
  // 3. Send init_vault (this already succeeded for you once,
  //    but calling it again will probably fail because the PDA
  //    already exists, so we wrap it in try/catch to be nice)
  //
  const initVaultIx = encodeInitVaultIx({
    programId,
    authority: buyer,
    mint,
    vaultPda,
  });

  try {
    const tx1 = new Transaction().add(initVaultIx);
    const sig1 = await sendAndConfirmTransaction(connection, tx1, [payer]);
    console.log("init_vault tx sig:", sig1);
  } catch (e) {
    console.log("init_vault probably already ran, skipping. Details:");
    console.log(String(e));
  }

  //
  // 4. Ensure the vault's ATA actually exists on-chain.
  //    Your program expects vault_ata to already be initialized,
  //    so WE will create it from the client if it's missing.
  //
  // We do this with spl-token's createAssociatedTokenAccountInstruction.
  // Payer = buyer (your wallet).
  // Owner = vaultPda (PDA).
  //
  // Even if it already exists, sending this ix again will just fail
  // with "account already in use" - harmless to try/catch.
  //
  const createVaultAtaIx = createAssociatedTokenAccountInstruction(
    buyer,        // payer funds rent
    vaultAta,     // the ATA address we want
    vaultPda,     // ATA owner (the vault PDA)
    mint,         // which mint
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  try {
    const tx2 = new Transaction().add(createVaultAtaIx);
    const sig2 = await sendAndConfirmTransaction(connection, tx2, [payer]);
    console.log("create vault ATA tx sig:", sig2);
  } catch (e) {
    console.log("vault ATA likely already exists, skipping. Details:");
    console.log(String(e));
  }

  //
  // 5. Now call lock_tokens to actually move tokens
  //    from buyerAta -> vaultAta.
  //
  // decimals = 6
  // amountToLock = 100_000 = 0.1 token
  //
  const amountToLock = 100_000n;

  const lockTokensIx = encodeLockTokensIx({
    programId,
    user: buyer,
    mint,
    vaultPda,
    vaultAta,
    userAta: buyerAta,
    amount: amountToLock,
  });

  const tx3 = new Transaction().add(lockTokensIx);
  const sig3 = await sendAndConfirmTransaction(connection, tx3, [payer]);

  console.log("lock_tokens tx sig:", sig3);

  console.log("🎉 DONE");
  console.log("- Vault PDA is initialized on devnet.");
  console.log("- Vault ATA exists for that PDA and mint.");
  console.log("- ~0.1 Goblin Gold moved from your wallet ATA into the vault ATA.");
  console.log("That completes: mint token → create vault → lock tokens in vault.");
  console.log("Escrow is next.");
})();
