use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{
    self,
    Mint,
    Token,
    TokenAccount,
    Transfer,
};

// TEMP PROGRAM ID PLACEHOLDER:
// We'll replace this with your real ID after `anchor deploy`
declare_id!("AhtmyF1FM2NwGYECDzgjC6jbNtPnSRDFzhahugFfqkZW");

#[program]
pub mod vault_escrow {
    use super::*;

    // 1. Initialize the vault PDA for a given mint and authority.
    pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.mint = ctx.accounts.mint.key();
        vault.bump = ctx.bumps.vault; // <-- Anchor 0.32 style
        Ok(())
    }

    // 2. Lock tokens (deposit user's tokens into the vault's ATA)
    pub fn lock_tokens(ctx: Context<LockTokens>, amount: u64) -> Result<()> {
        // Transfer from user's ATA -> vault's ATA
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    // 3. Create escrow record (no token move yet, just store terms)
    pub fn init_escrow(
        ctx: Context<InitEscrow>,
        amount: u64,
        deadline_unix_ts: i64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        escrow.vault = ctx.accounts.vault.key();
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.seller.key();
        escrow.token_mint = ctx.accounts.mint.key();
        escrow.amount_locked = amount;
        escrow.deadline_unix_ts = deadline_unix_ts;
        escrow.released = false;
        escrow.bump = ctx.bumps.escrow; // <-- Anchor 0.32 style
        Ok(())
    }

    // 4(a). Buyer approves before deadline -> release to seller
    pub fn release_to_seller(ctx: Context<ReleaseToSeller>) -> Result<()> {
        let now_ts = Clock::get()?.unix_timestamp;

        // Must still be before deadline
        require!(
            now_ts <= ctx.accounts.escrow.deadline_unix_ts,
            EscrowError::DeadlinePassed
        );

        // Caller must be buyer
        require!(
            ctx.accounts.buyer.key() == ctx.accounts.escrow.buyer,
            EscrowError::NotBuyer
        );

        // Can only release once
        require!(
            ctx.accounts.escrow.released == false,
            EscrowError::AlreadyReleased
        );

        // Transfer vault_ata -> seller_ata, signed by vault PDA
        let vault = &ctx.accounts.vault;

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            vault.mint.as_ref(),
            vault.authority.as_ref(),
            &[vault.bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.seller_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, ctx.accounts.escrow.amount_locked)?;

        // mark escrow as done
        ctx.accounts.escrow.released = true;

        Ok(())
    }

    // 4(b). After deadline, refund the buyer if not released
    pub fn refund_buyer(ctx: Context<RefundBuyer>) -> Result<()> {
        let now_ts = Clock::get()?.unix_timestamp;

        // Must be after deadline
        require!(
            now_ts > ctx.accounts.escrow.deadline_unix_ts,
            EscrowError::TooEarly
        );

        // Caller must be buyer
        require!(
            ctx.accounts.buyer.key() == ctx.accounts.escrow.buyer,
            EscrowError::NotBuyer
        );

        // Can't refund if already released
        require!(
            ctx.accounts.escrow.released == false,
            EscrowError::AlreadyReleased
        );

        // Transfer vault_ata -> buyer_ata, signed by vault PDA
        let vault = &ctx.accounts.vault;

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            vault.mint.as_ref(),
            vault.authority.as_ref(),
            &[vault.bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.buyer_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, ctx.accounts.escrow.amount_locked)?;

        // mark escrow finished so it can't be reused
        ctx.accounts.escrow.released = true;

        Ok(())
    }
}

// ------------------ STATE ACCOUNTS ------------------

#[account]
pub struct Vault {
    pub authority: Pubkey, // who initialized this vault
    pub mint: Pubkey,      // which token this vault is for
    pub bump: u8,          // PDA bump
}

#[account]
pub struct Escrow {
    pub vault: Pubkey,           // vault PDA that actually holds tokens
    pub buyer: Pubkey,           // person funding escrow
    pub seller: Pubkey,          // person who will receive tokens
    pub token_mint: Pubkey,      // which SPL token
    pub amount_locked: u64,      // how many tokens are reserved
    pub deadline_unix_ts: i64,   // release allowed until this
    pub released: bool,          // already finalized?
    pub bump: u8,                // PDA bump
}

// ------------------ ACCOUNTS CONTEXT ------------------

// init_vault: creates the Vault PDA account
#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>, // you (vault owner/admin)

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 1, // discriminator + fields
        seeds = [
            b"vault",
            mint.key().as_ref(),
            authority.key().as_ref(),
        ],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

// lock_tokens: user deposits tokens into the vault's ATA
#[derive(Accounts)]
pub struct LockTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>, // the wallet providing tokens

    pub mint: Account<'info, Mint>,

    // vault PDA must already exist
    #[account(
        seeds = [
            b"vault",
            mint.key().as_ref(),
            vault.authority.as_ref(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // vault's token account (owned by vault PDA)
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    // user's token account (source)
    #[account(
        mut,
        constraint = user_ata.owner == user.key(),
        constraint = user_ata.mint == mint.key(),
    )]
    pub user_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// init_escrow: record escrow conditions
#[derive(Accounts)]
pub struct InitEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK:
    /// We only need seller's pubkey here.
    pub seller: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    // reference vault PDA
    #[account(
        seeds = [
            b"vault",
            mint.key().as_ref(),
            vault.authority.as_ref(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = buyer,
        space = 8
            + 32  // vault
            + 32  // buyer
            + 32  // seller
            + 32  // token_mint
            + 8   // amount_locked
            + 8   // deadline_unix_ts
            + 1   // released
            + 1,  // bump
        seeds = [
            b"escrow",
            vault.key().as_ref(),
            buyer.key().as_ref(),
            seller.key().as_ref(),
        ],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    pub system_program: Program<'info, System>,
}

// release_to_seller: move locked tokens to seller before deadline
#[derive(Accounts)]
pub struct ReleaseToSeller<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>, // must match escrow.buyer

    #[account(mut)]
    pub seller: SystemAccount<'info>, // will receive tokens

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = escrow.vault == vault.key(),
        constraint = escrow.buyer == buyer.key(),
        constraint = escrow.seller == seller.key(),
        constraint = escrow.token_mint == mint.key(),
        constraint = escrow.amount_locked > 0,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        seeds = [
            b"vault",
            mint.key().as_ref(),
            vault.authority.as_ref(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // vault ATA (source)
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    // seller ATA (dest)
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller,
    )]
    pub seller_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// refund_buyer: after deadline, send tokens back to buyer
#[derive(Accounts)]
pub struct RefundBuyer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>, // must match escrow.buyer

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = escrow.vault == vault.key(),
        constraint = escrow.buyer == buyer.key(),
        constraint = escrow.token_mint == mint.key(),
        constraint = escrow.amount_locked > 0,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        seeds = [
            b"vault",
            mint.key().as_ref(),
            vault.authority.as_ref(),
        ],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // vault ATA (source)
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    // buyer ATA (dest)
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ------------------ ERRORS ------------------

#[error_code]
pub enum EscrowError {
    #[msg("Escrow already released")]
    AlreadyReleased,
    #[msg("Escrow deadline has already passed")]
    DeadlinePassed,
    #[msg("Too early to refund buyer")]
    TooEarly,
    #[msg("Only the buyer can call this")]
    NotBuyer,
}

