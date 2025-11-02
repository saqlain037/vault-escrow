import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  Keypair,
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
 * Small helpers
 */

// anchor-style discriminator: first 8 bytes of sha256("global:<fn_name>")
function discriminator(ixName: string): Buffer {
  const preimage = `global:${ixName}`;
  const hash = createHash("sha256").update(preimage).digest();
  return hash.subarray(0, 8);
}

// Vault PDA seeds: ["vault", mint, authority]
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

// Escrow PDA seeds: ["escrow", vault, buyer, seller]
async function deriveEscrowPda(
  programId: PublicKey,
  vaultPk: PublicKey,
  buyerPk: PublicKey,
  sellerPk: PublicKey
): Promise<[PublicKey, number]> {
  return await PublicKey.findProgramAddress(
    [
      Buffer.from("escrow"),
      vaultPk.toBuffer(),
      buyerPk.toBuffer(),
      sellerPk.toBuffer(),
    ],
    programId
  );
}

/**
 * init_escrow(
 *   ctx: Context<InitEscrow>,
 *   amount: u64,
 *   deadline_unix_ts: i64
 * )
 *
 * Accounts (order matters! must match your Rust struct InitEscrow):
 *
 * 0 buyer            (mut, signer)
 * 1 seller           (unchecked)
 * 2 mint             (Mint)
 * 3 vault            (Vault PDA, seeds ["vault", mint, vault.authority])
 * 4 escrow           (Escrow PDA, init with seeds ["escrow", vault, buyer, seller])
 * 5 system_program
 *
 * Data layout:
 * [8-byte discriminator]["amount" u64 le]["deadline_unix_ts" i64 le]
 */
function encodeInitEscrowIx(params: {
  programId: PublicKey;
  buyer: PublicKey;
  seller: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  escrow: PublicKey;
  amount: bigint; // u64
  deadlineUnixTs: bigint; // i64
}): TransactionInstruction {
  const disc = discriminator("init_escrow");

  // amount: u64 LE
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(params.amount);

  // deadline_unix_ts: i64 LE
  const deadlineBuf = Buffer.alloc(8);
  deadlineBuf.writeBigInt64LE(params.deadlineUnixTs);

  const data = Buffer.concat([disc, amountBuf, deadlineBuf]);

  const keys = [
    { pubkey: params.buyer, isSigner: true, isWritable: true },
    { pubkey: params.seller, isSigner: false, isWritable: false },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.vault, isSigner: false, isWritable: false },
    { pubkey: params.escrow, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: params.programId,
    keys,
    data,
  });
}

/**
 * release_to_seller(
 *   ctx: Context<ReleaseToSeller>
 * ) -> no args
 *
 * Accounts (match ReleaseToSeller struct in your Rust):
 *
 * 0 buyer              (mut, signer)
 * 1 seller             (SystemAccount, mut)
 * 2 mint               (Mint)
 * 3 escrow             (Escrow account, mut, checked)
 * 4 vault              (Vault PDA, seeds ["vault", mint, vault.authority])
 * 5 vault_ata          (mut, ATA of vault PDA for mint)
 * 6 seller_ata         (mut, ATA of seller for mint)
 * 7 token_program
 * 8 associated_token_program
 * 9 system_program
 *
 * Data layout:
 * [8-byte discriminator]  // "global:release_to_seller"
 */
function encodeReleaseToSellerIx(params: {
  programId: PublicKey;
  buyer: PublicKey;
  seller: PublicKey;
  mint: PublicKey;
  escrow: PublicKey;
  vault: PublicKey;
  vaultAta: PublicKey;
  sellerAta: PublicKey;
}): TransactionInstruction {
  const disc = discriminator("release_to_seller");
  const data = disc; // no args

  const keys = [
    { pubkey: params.buyer, isSigner: true, isWritable: true },
    { pubkey: params.seller, isSigner: false, isWritable: true },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.escrow, isSigner: false, isWritable: true },
    { pubkey: params.vault, isSigner: false, isWritable: false },

    { pubkey: params.vaultAta, isSigner: false, isWritable: true },
    { pubkey: params.sellerAta, isSigner: false, isWritable: true },

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
  // 1. Load values from deploy-info.json (programId, mint, buyer wallet, etc)
  //
  const raw = fs.readFileSync("deploy-info.json", "utf8");
  const info = JSON.parse(raw);

  const programId = pubkeyFromString(info.programId);
  const mint = pubkeyFromString(info.mint);
  const buyer = pubkeyFromString(info.payer); // you
  const buyerAta = pubkeyFromString(info.payerAta);

  console.log("Program ID:", programId.toBase58());
  console.log("Mint:", mint.toBase58());
  console.log("Buyer:", buyer.toBase58());
  console.log("Buyer ATA:", buyerAta.toBase58());

  // safety check: ensure local wallet matches
  if (!buyer.equals(payer.publicKey)) {
    throw new Error(
      "Wallet mismatch: deploy-info.json payer != local payer.publicKey"
    );
  }

  //
  // 2. Pick a seller.
  //
  // We'll generate a new keypair to act as the seller.
  // NOTE: release_to_seller does NOT require the seller to sign,
  // so we don't actually need seller's signature when releasing.
  //
  // But we DO need the seller's pubkey to:
  //   (a) init the escrow PDA
  //   (b) create their ATA
  //
  const sellerKp = Keypair.generate();
  const seller = sellerKp.publicKey;
  console.log("Seller pubkey:", seller.toBase58());

  //
  // 3. Derive PDAs:
  //    - Vault PDA (you already used this in script 2)
  //    - Escrow PDA (new)
  //
  const [vaultPda /*vaultBump*/] = await deriveVaultPda(
    programId,
    mint,
    buyer
  );
  console.log("Vault PDA:", vaultPda.toBase58());

  const [escrowPda /*escrowBump*/] = await deriveEscrowPda(
    programId,
    vaultPda,
    buyer,
    seller
  );
  console.log("Escrow PDA:", escrowPda.toBase58());

  //
  // 4. Derive all token accounts we will need:
  //
  // vault_ata: ATA for the vault PDA (this should already hold locked tokens
  //            because you ran lock_tokens in script 2)
  //
  const vaultAta = await getAssociatedTokenAddress(
    mint,
    vaultPda,
    true, // vaultPda is a PDA/off-curve
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  console.log("Vault ATA:", vaultAta.toBase58());

  //
  // seller_ata: ATA for seller to receive tokens
  //
  const sellerAta = await getAssociatedTokenAddress(
    mint,
    seller,
    false, // seller is a normal keypair pubkey
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  console.log("Seller ATA:", sellerAta.toBase58());

  //
  // 5. Build init_escrow instruction
  //
  // We choose how much of the vault we want to allow to be released.
  // You locked ~0.1 Goblin Gold = 100_000 base units (decimals=6).
  // Let's escrow 50_000 base units (0.05 Goblin Gold).
  //
  const amountToEscrow = 50_000n;

  // deadline_unix_ts: we'll set "now + 1 hour"
  const nowSec = Math.floor(Date.now() / 1000);
  const deadlineSec = nowSec + 3600; // 1 hour from now
  const deadlineUnixTs = BigInt(deadlineSec);

  const initEscrowIx = encodeInitEscrowIx({
    programId,
    buyer,
    seller,
    mint,
    vault: vaultPda,
    escrow: escrowPda,
    amount: amountToEscrow,
    deadlineUnixTs,
  });

  //
  // 6. We MUST also make sure seller's ATA exists on chain BEFORE release_to_seller.
  //    Your program expects seller_ata to already be initialized.
  //
  // We'll create the seller's ATA using buyer (payer) so seller
  // doesn't need any SOL.
  //
  const createSellerAtaIx = createAssociatedTokenAccountInstruction(
    buyer,        // payer (funds rent)
    sellerAta,    // ATA address to create
    seller,       // ATA owner (seller)
    mint,         // SPL mint
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  //
  // 7. Send a tx to (a) create seller ATA, (b) init_escrow PDA.
  //    Both only require buyer to sign.
  //
  const tx1 = new Transaction().add(
    createSellerAtaIx,
    initEscrowIx,
  );

  const sig1 = await sendAndConfirmTransaction(connection, tx1, [payer]);
  console.log("init_escrow tx sig:", sig1);

  //
  // 8. Now build release_to_seller instruction.
  //    This moves escrow.amount_locked tokens from vault_ata -> seller_ata,
  //    signed by the vault PDA, but authorized by the buyer's approval.
  //
  const releaseIx = encodeReleaseToSellerIx({
    programId,
    buyer,
    seller,
    mint,
    escrow: escrowPda,
    vault: vaultPda,
    vaultAta,
    sellerAta,
  });

  const tx2 = new Transaction().add(releaseIx);
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [payer]);
  console.log("release_to_seller tx sig:", sig2);

  console.log("🎉 ESCROW COMPLETE");
  console.log("- Escrow PDA was created to track amount, seller, and deadline.");
  console.log("- Seller ATA was created so they can receive Goblin Gold.");
  console.log("- Tokens were released from your Vault PDA ATA to the seller.");
  console.log("You have now completed Task 2 end-to-end on devnet.");
})();
